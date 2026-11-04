"""MCP v1 message research and staged projection; standard library, no models/logs."""
import base64
from contextlib import contextmanager
from datetime import datetime, timedelta
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import time

GUILD = '1'
LOCK_TIMEOUT = 2.0
QUERY_TIMEOUT = 2.0


def instant(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)', value):
        raise ValueError('Invalid UTC timestamp')
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).isoformat(timespec='microseconds').replace('+00:00', 'Z')
    except ValueError:
        raise ValueError('Invalid UTC timestamp') from None


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{1,32}', value):
        raise ValueError('Invalid message identifier')
    return value


def label(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 200 or re.search(r'[\x00-\x1f\x7f]', value):
        raise ValueError('Invalid filter')
    return value.strip()


def project_messages(con, raw, render, guild=GUILD):
    """Write ONLY a caller-owned staged DB, from original raw rows in chunk msg_ids."""
    guild = identifier(guild)
    represented = {identifier(mid) for row in con.execute('select msg_ids from chunks') for mid in json.loads(row[0])}
    threads = set()
    con.execute('savepoint research_projection')
    try:
        for name in ['research_fts', 'research_messages', 'research_meta']:
            con.execute('drop table if exists ' + name)
        con.execute('''create table research_messages(
            id text primary key, timestamp text not null, channel_id text not null,
            channel text not null, author_id text not null, username text not null,
            display_name text not null, global_name text, thread_id text, text text not null,
            url text not null)''')
        for path in sorted(Path(raw).glob('*.jsonl')):
            with path.open(encoding='utf-8', errors='replace') as stream:
                for line in stream:
                    try:
                        message = json.loads(line)
                    except json.JSONDecodeError:
                        continue  # Same truncated-tail rule as the existing builder.
                    thread = message.get('thread') or {}
                    if thread.get('id'):
                        threads.add(identifier(thread['id']))
                    if message.get('id') not in represented:
                        continue
                    mid, cid = identifier(message['id']), identifier(message['channel_id'])
                    author = message.get('author') or {}
                    aid = identifier(author.get('id'))
                    username = label(author.get('username'))
                    display = label((message.get('member') or {}).get('nick') or author.get('global_name') or username)
                    tid = message.get('thread_id') or thread.get('id')
                    if tid:
                        tid = identifier(tid)
                        threads.add(tid)
                    text = render(message)
                    if not isinstance(text, str) or not text:
                        raise ValueError('Invalid research projection')
                    con.execute('insert or replace into research_messages values (?,?,?,?,?,?,?,?,?,?,?)',
                                (mid, instant(message['timestamp']), cid, label(message.get('_channel')),
                                 aid, username, display, author.get('global_name'), tid, text,
                                  f'https://discord.com/channels/{guild}/{cid}/{mid}'))
        if con.execute('select count(*) from research_messages').fetchone()[0] != len(represented):
            raise ValueError('Invalid research projection')
        con.executemany('update research_messages set thread_id=? where channel_id=? and thread_id is null', [(tid, tid) for tid in threads])
        con.execute('create index research_time on research_messages(timestamp,id)')
        con.execute('create index research_thread on research_messages(thread_id,timestamp,id)')
        con.execute('create index research_channel on research_messages(channel_id,timestamp,id)')
        con.execute('create virtual table research_fts using fts5(text, tokenize="unicode61 remove_diacritics 2")')
        con.execute('insert into research_fts(rowid,text) select rowid,text from research_messages')
        con.execute('create table research_meta(version integer not null)')
        con.execute('insert into research_meta values (1)')
        con.execute('release research_projection')
    except Exception:
        con.execute('rollback to research_projection')
        con.execute('release research_projection')
        raise ValueError('Invalid research projection') from None


class Research:
    def __init__(self, searcher):
        # No database/model work at registration (including on legacy snapshots).
        self.searcher = searcher
        self._cursor_key = os.urandom(32)

    @contextmanager
    def _read(self):
        if not self.searcher._lock.acquire(timeout=LOCK_TIMEOUT):
            raise RuntimeError('Research unavailable')
        con = None
        try:
            try:
                self.searcher.reload_index()
            except Exception:
                raise RuntimeError('Research unavailable') from None
            con = self.searcher.con
            con.create_function('research_lower', 1, lambda value: value.lower() if isinstance(value, str) else None, deterministic=True)
            deadline = time.monotonic() + QUERY_TIMEOUT
            con.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
            yield con
        except (sqlite3.Error, OSError, json.JSONDecodeError):
            raise RuntimeError('Research unavailable') from None
        except ValueError:
            raise  # Only input/cursor validators raise these, with fixed messages.
        except Exception:
            raise RuntimeError('Research unavailable') from None
        finally:
            try:
                if con is not None:
                    con.set_progress_handler(None, 0)
            except sqlite3.Error:
                pass  # A closed/failed connection must not strand the shared lock.
            finally:
                self.searcher._lock.release()

    def _info(self, con):
        database = next(row[2] for row in con.execute('pragma database_list') if row[1] == 'main')
        source = Path(database)
        target = getattr(self.searcher, '_index_target', None)
        if target is not None:
            source = Path(target) / 'rag.sqlite'
        manifest_path = source.parent / 'manifest.json'
        if not manifest_path.is_file() and source.parent.name == 'index':
            manifest_path = source.parent.parent / 'manifest.json'
        manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else {}
        snapshot = manifest.get('files', {}).get('index/rag.sqlite')
        if not isinstance(snapshot, str) or not re.fullmatch('[a-f0-9]{64}', snapshot):
            stat = source.stat()
            snapshot = hashlib.sha256(f'{source}:{stat.st_dev}:{stat.st_ino}:{stat.st_size}:{stat.st_mtime_ns}'.encode()).hexdigest()
        tables = {row[0] for row in con.execute("select name from sqlite_master where type='table' and name in ('research_messages','research_fts','research_meta')")}
        structured = False
        if len(tables) == 3:
            version = con.execute('select version from research_meta').fetchone()
            structured = version is not None and version[0] == 1
        if structured:
            first, last, count = con.execute('select min(timestamp),max(timestamp),count(*) from research_messages').fetchone()
        else:
            first, last = con.execute('select min(t0),max(t1) from chunks').fetchone()
            first, last = instant(first) if first else None, instant(last) if last else None
            count = None
        end = (datetime.fromisoformat(last.replace('Z', '+00:00')) + timedelta(microseconds=1)).isoformat(timespec='microseconds').replace('+00:00', 'Z') if last else None
        updated = manifest.get('created_utc')
        return {'version': 1, 'snapshot': snapshot,
                'backend': 'gpu' if os.environ.get('RAG_DEVICE', 'cpu').startswith('cuda') else 'cpu',
                'coverageStart': first, 'coverageEnd': end, 'latestMessageAt': last,
                'updatedAt': instant(updated) if updated else None, 'messageCount': count,
                'capabilities': {'structured': bool(structured)}}

    def corpus_info(self) -> dict[str, object]:
        """Report selected snapshot identity, original-message coverage and capability."""
        with self._read() as con:
            return self._info(con)

    def _scope(self, since, until, channel, author, limit):
        if type(limit) is not int or not 1 <= limit <= 20:
            raise ValueError('Invalid limit')
        scope = [instant(since) if since is not None else None,
                 instant(until) if until is not None else None,
                 label(channel) if channel is not None else None,
                 label(author) if author is not None else None]
        if scope[0] and scope[1] and scope[0] >= scope[1]:
            raise ValueError('Invalid interval')
        return scope

    def _cursor(self, cursor, binding):
        if not isinstance(cursor, str) or not 1 <= len(cursor) <= 4096:
            raise ValueError('Invalid cursor')
        try:
            encoded, signature = cursor.split('.')
            expected = hmac.new(self._cursor_key, encoded.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(signature, expected):
                raise ValueError()
            data = json.loads(base64.urlsafe_b64decode(encoded.encode()))
            if not isinstance(data, list) or len(data) != 3 or data[0] != binding:
                raise ValueError()
            return instant(data[1]), identifier(data[2])
        except Exception:
            raise ValueError('Invalid or stale cursor') from None

    def _encode_cursor(self, binding, row):
        data = json.dumps([binding, row['timestamp'], row['id']], separators=(',', ':')).encode()
        encoded = base64.urlsafe_b64encode(data).decode()
        return encoded + '.' + hmac.new(self._cursor_key, encoded.encode(), hashlib.sha256).hexdigest()

    def _page(self, operation, since=None, until=None, channel=None, author=None, limit=20, cursor=None, message_id=None, query=None):
        scope = self._scope(since, until, channel, author, limit)
        if operation in ('get_message', 'get_thread'):
            identifier(message_id)
        if operation == 'search_messages' and (not isinstance(query, str) or not query.strip() or len(query) > 1200 or '\x00' in query):
            raise ValueError('Invalid query')
        if cursor is not None and (not isinstance(cursor, str) or not 1 <= len(cursor) <= 4096):
            raise ValueError('Invalid cursor')
        candidates = None
        if query is not None and callable(getattr(self.searcher, 'search', None)):
            # Reuse the already-loaded translation/dense/reranking models; SQL below is authoritative for message scope.
            try:
                rows = self.searcher.search(query, k=20, since=scope[0], until=scope[1])
                candidates = list(dict.fromkeys(mid for row in rows for mid in [row.get('hit'), *json.loads(row['msg_ids'])] if mid))[:2000]
                for mid in candidates:
                    identifier(mid)
            except Exception:
                raise RuntimeError('Research unavailable') from None
        with self._read() as con:
            info = self._info(con)
            if not info['capabilities']['structured']:
                raise RuntimeError('Structured research unavailable')
            binding = hashlib.sha256(json.dumps([info['snapshot'], operation, scope, message_id], separators=(',', ':')).encode()).hexdigest()
            after = self._cursor(cursor, binding) if cursor is not None else None
            where, args = ['1'], []
            if scope[0]:
                where.append('m.timestamp >= ?'); args.append(scope[0])
            if scope[1]:
                where.append('m.timestamp < ?'); args.append(scope[1])
            if scope[2]:
                if scope[2].isdigit():
                    where.append('m.channel_id=?'); args.append(scope[2])
                else:
                    where.append('research_lower(m.channel)=?'); args.append(scope[2].lower())
            if scope[3]:
                if scope[3].isdigit():
                    where.append('m.author_id=?'); args.append(scope[3])
                else:
                    where.append('(research_lower(m.username)=? or research_lower(m.display_name)=? or research_lower(m.global_name)=?)')
                    args.extend([scope[3].lower()] * 3)
            if operation == 'get_message':
                where.append('m.id=?'); args.append(message_id)
            elif operation == 'get_thread':
                anchor = con.execute('select m.thread_id from research_messages m where ' + ' and '.join(where) + ' and m.id=? limit 1', args + [message_id]).fetchone()
                if anchor is None:
                    where.append('0')
                elif anchor[0]:
                    where.append('m.thread_id=?'); args.append(anchor[0])
                else:
                    # Unknown real thread: original indexed conversation windows, not name inference.
                    where.append('m.id in (select value from chunks c, json_each(c.msg_ids) where exists (select 1 from json_each(c.msg_ids) a where a.value=?))')
                    args.append(message_id)
            if after:
                where.append('(m.timestamp,m.id) > (?,?)'); args.extend(after)
            source = 'research_messages m'
            order = 'm.timestamp,m.id'
            if candidates is not None:
                where.append('m.id in (' + ','.join('?' for _ in candidates) + ')' if candidates else '0')
                args.extend(candidates)
            elif query is not None:
                tokens = list(dict.fromkeys(re.findall(r'\w+', query.lower())))
                if tokens:
                    source += ' join research_fts on research_fts.rowid=m.rowid'
                    where.append('research_fts match ?')
                    args.append(' OR '.join('"' + token + '"' for token in tokens))
                    order = 'bm25(research_fts),m.timestamp,m.id'
                else:
                    where.append('0')
            condition = ' and '.join(where)
            rows = con.execute('select m.id,m.timestamp,m.channel_id,m.channel,m.author_id,m.display_name,m.username,m.global_name,m.thread_id,substr(m.text,1,4000) as text,m.url from ' + source + ' where ' + condition + ' order by ' + order + ' limit ?', args + [limit]).fetchall()
            more = False
            if rows and operation in ('list_messages', 'get_thread'):
                more = con.execute('select 1 from research_messages m where ' + condition + ' and (m.timestamp,m.id) > (?,?) limit 1', args + [rows[-1]['timestamp'], rows[-1]['id']]).fetchone() is not None
            in_coverage = (not scope[0] or bool(info['coverageStart'] and info['coverageStart'] <= scope[0] < info['coverageEnd'])) and (not scope[1] or bool(info['coverageEnd'] and info['coverageStart'] < scope[1] <= info['coverageEnd']))
            return {'version': 1, 'snapshot': info['snapshot'],
                    # JS consumers bound strings in UTF-16 units; never split a surrogate pair.
                    'messages': [{'messageId': r['id'], 'timestamp': r['timestamp'], 'channelId': r['channel_id'], 'channel': r['channel'], 'authorId': r['author_id'], 'author': r['display_name'], 'username': r['username'], **({'globalName': r['global_name']} if r['global_name'] else {}), 'threadId': r['thread_id'], 'text': r['text'].encode('utf-16-le')[:8000].decode('utf-16-le', errors='ignore'), 'url': r['url']} for r in rows],
                    'nextCursor': self._encode_cursor(binding, rows[-1]) if more else None,
                    'exhaustive': query is None and not more and bool(in_coverage)}

    def search_messages(self, query: str, since: str | None = None, until: str | None = None, channel: str | None = None, author: str | None = None, limit: int = 10) -> dict[str, object]:
        """Nonexhaustive BM25 topic search, exact original-message filters; no model call."""
        return self._page('search_messages', since, until, channel, author, limit, query=query)

    def list_messages(self, since: str | None = None, until: str | None = None, channel: str | None = None, author: str | None = None, limit: int = 20, cursor: str | None = None) -> dict[str, object]:
        """Enumerate original messages in stable (timestamp,id) order; no keyword needed."""
        return self._page('list_messages', since, until, channel, author, limit, cursor)

    def get_message(self, message_id: str, since: str | None = None, until: str | None = None, channel: str | None = None, author: str | None = None) -> dict[str, object]:
        """Open one indexed message without widening its supplied scope."""
        return self._page('get_message', since, until, channel, author, 1, message_id=message_id)

    def get_thread(self, message_id: str, since: str | None = None, until: str | None = None, channel: str | None = None, author: str | None = None, limit: int = 20, cursor: str | None = None) -> dict[str, object]:
        """Open an original thread or bounded indexed conversation when thread is unknown."""
        return self._page('get_thread', since, until, channel, author, limit, cursor, message_id)
