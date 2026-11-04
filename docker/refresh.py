"""Portable bot collector and atomic hybrid-index builder; no generation or content logs."""
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'rag'))


def next_delay(now):
    return 1800 - now % 1800


def write_json(path, data):
    temporary = path.with_suffix('.next')
    temporary.write_text(json.dumps(data)); temporary.chmod(0o600)
    os.replace(temporary, path)


def collect(raw, guild, channels, token, session=None):
    import requests
    session = session or requests.Session()
    session.headers.update(Authorization='Bot ' + token)
    raw.mkdir(parents=True, exist_ok=True)
    def get(path, **params):
        for _ in range(12):
            response = session.get('https://discord.com/api/v10' + path, params=params, timeout=30, allow_redirects=False)
            if response.status_code == 429:
                delay = float(response.headers.get('Retry-After') or response.json().get('retry_after', 5))
                if not math.isfinite(delay) or not 0 <= delay <= 3600: raise RuntimeError('discord_rate_limit')
                time.sleep(delay + 0.1); continue
            if response.status_code != 200: raise RuntimeError('discord_unavailable_or_permissions_changed')
            value = response.json()
            time.sleep(0.25)
            return value
        raise RuntimeError('discord_rate_limit')
    for channel in channels:
        metadata = get('/channels/' + channel)
        if metadata.get('guild_id') != guild or str(metadata.get('id')) != channel:
            raise RuntimeError('discord_scope_mismatch')
        if metadata.get('type') not in (0, 5, 10, 11, 12):
            raise RuntimeError('select_text_channels_or_thread_ids')
        path = raw / (channel + '.jsonl')
        rows = {}
        if path.exists():
            for line in path.read_text().splitlines():
                item = json.loads(line); rows[item['id']] = item
        # Re-read the newest 100 known messages to observe recent edits. Publication
        # is a snapshot, not a guarantee that Discord deletions were fully reconciled.
        ids = sorted(rows, key=int)
        after = ids[-101] if len(ids) > 100 else '0'
        while True:
            page = get('/channels/' + channel + '/messages', limit=100, after=after)
            if not page: break
            for item in page:
                if item.get('channel_id') != channel or not str(item.get('id', '')).isdigit(): raise RuntimeError('discord_scope_mismatch')
                item['_channel'] = metadata.get('name', channel)
                rows[item['id']] = item
            following = max((item['id'] for item in page), key=int)
            if int(following) <= int(after): raise RuntimeError('discord_pagination_stalled')
            after = following
        temporary = path.with_suffix('.next')
        with temporary.open('w') as stream:
            for item in sorted(rows.values(), key=lambda item: (item['timestamp'], int(item['id']))):
                if metadata.get('type') in (10, 11, 12): item['thread_id'] = channel
                stream.write(json.dumps(item) + '\n')
            stream.flush(); os.fsync(stream.fileno())
        temporary.chmod(0o600); os.replace(temporary, path)


def render(message):
    text = message.get('content') or ''
    for user in message.get('mentions') or []:
        for tag in (f"<@{user['id']}>", f"<@!{user['id']}>"):
            text = text.replace(tag, '@' + user.get('username', '?'))
    text += ''.join(' [attachment: ' + item.get('filename', '') + ']' for item in message.get('attachments') or [])
    text += ''.join(' [link: ' + item['title'] + ']' for item in message.get('embeds') or [] if item.get('title'))
    return ' '.join(text.split())


def build(raw, bundle, encode):
    import numpy as np
    from research import project_messages
    versions = bundle / 'index-versions'; versions.mkdir(exist_ok=True)
    target = versions / (dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8])
    target.mkdir()
    cache = sqlite3.connect(bundle / 'embeddings.sqlite')
    cache.execute('create table if not exists emb(hash text primary key, vec blob)')
    con = sqlite3.connect(target / 'rag.sqlite')
    try:
        con.executescript('''create table chunks(id integer primary key, channel_id text, channel text, t0 text, t1 text,
            authors text, team int, scrolls text, msg_ids text, header text, body text);
            create table units(id integer primary key,parent int,msg_id text,text text);
            create virtual table fts using fts5(text,tags,tokenize='unicode61 remove_diacritics 2');''')
        vectors = []
        def unit(parent, mid, text):
            key = hashlib.sha256(text.encode()).hexdigest()
            row = cache.execute('select vec from emb where hash=?', (key,)).fetchone()
            if row: vector = np.frombuffer(row[0], dtype=np.float16)
            else:
                vector = np.asarray(encode(['passage: ' + text])[0], dtype=np.float16)
                if vector.shape != (768,) or not np.isfinite(vector).all(): raise RuntimeError('invalid_embedding')
                cache.execute('insert into emb values (?,?)', (key, vector.tobytes())); cache.commit()
            uid = len(vectors) + 1; vectors.append(vector)
            con.execute('insert into units values (?,?,?,?)', (uid, parent, mid, text))
            con.execute('insert into fts(rowid,text,tags) values (?,?,?)', (uid, text, ''))
        ci = 0
        for path in sorted(raw.glob('*.jsonl')):
            messages = [json.loads(line) for line in path.read_text().splitlines()]
            messages = [m for m in messages if m.get('type', 0) in (0, 19, 20, 21) and render(m)]
            current = []; words = 0
            groups = []
            for message in messages:
                gap = current and (dt.datetime.fromisoformat(message['timestamp']) - dt.datetime.fromisoformat(current[-1]['timestamp'])).total_seconds() > 1800
                size = len(render(message).split()) + 6
                if current and (gap or words + size > 320):
                    groups.append(current)
                    current = current[-2:] if not gap else []
                    words = sum(len(render(m).split()) + 6 for m in current)
                current = current + [message]; words += size
            if current: groups.append(current)
            for group in groups:
                ci += 1; first, last = group[0], group[-1]
                header = f"#{first.get('_channel', first['channel_id'])} · {first['timestamp'][:10]} → {last['timestamp'][:10]}"
                lines = [f"[{m['timestamp'][:16].replace('T', ' ')}] {(m.get('author') or {}).get('global_name') or (m.get('author') or {}).get('username', '?')}: {render(m)}" for m in group]
                con.execute('insert into chunks values (?,?,?,?,?,?,?,?,?,?,?)', (ci, first['channel_id'], first.get('_channel', first['channel_id']), first['timestamp'], last['timestamp'], ' '.join({(m.get('author') or {}).get('username', '?') for m in group}), 0, '', json.dumps([m['id'] for m in group]), header, '\n'.join(lines)))
                unit(ci, None, header + '\n' + '\n'.join(lines))
                if len(group) > 1:
                    for i, message in enumerate(group):
                        unit(ci, message['id'], header + '\n' + '\n'.join(lines[max(0, i-1):i+1]))
        if not vectors: raise RuntimeError('empty_corpus')
        project_messages(con, raw, render, guild=os.environ.get('DISCORD_GUILD_ID', '1')); con.commit()
        if con.execute('pragma quick_check').fetchone()[0] != 'ok': raise RuntimeError('invalid_index')
        np.save(target / 'vectors.f16.npy', np.asarray(vectors, dtype=np.float16))
        con.close(); con = None
        digest = hashlib.sha256((target / 'rag.sqlite').read_bytes()).hexdigest()
        write_json(target / 'manifest.json', {'created_utc': dt.datetime.now(dt.timezone.utc).isoformat(), 'research_contract': 1, 'files': {'index/rag.sqlite': digest}})
        temporary = bundle / 'index.next'; temporary.unlink(missing_ok=True)
        temporary.symlink_to(target); os.replace(temporary, bundle / 'index')
    finally:
        if con: con.close()
        cache.close()


def main():
    from bootstrap import models
    import logging
    logging.disable(logging.CRITICAL)
    guild = os.environ['DISCORD_GUILD_ID']; channels = os.environ['DISCORD_CHANNEL_IDS'].split(',')
    if not guild.isdigit() or not channels or any(not value.isdigit() for value in channels): raise RuntimeError('invalid_scope')
    raw = Path('/data/raw'); bundle = Path('/data/bundle')
    bundle.mkdir(parents=True, exist_ok=True)
    with (bundle / 'refresh.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        models(bundle)
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer(str(bundle / 'models/intfloat--multilingual-e5-base'), device=os.environ.get('RAG_DEVICE', 'cpu'))
        model.max_seq_length = 512
        while True:
            started = dt.datetime.now(dt.timezone.utc).isoformat()
            try:
                write_json(bundle / 'refresh-status.json', {'status': 'running', 'startedAtUtc': started})
                collect(raw, guild, channels, os.environ['DISCORD_TOKEN'])
                build(raw, bundle, lambda texts: model.encode(texts, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False))
                write_json(bundle / 'refresh-status.json', {'status': 'success', 'startedAtUtc': started, 'completedAtUtc': dt.datetime.now(dt.timezone.utc).isoformat()})
                print(json.dumps({'event': 'refresh.success'}), flush=True)
            except Exception:
                write_json(bundle / 'refresh-status.json', {'status': 'failed', 'startedAtUtc': started, 'code': 'refresh_unavailable'})
                print(json.dumps({'event': 'refresh.failed', 'code': 'refresh_unavailable'}), flush=True)
            time.sleep(next_delay(time.time()))


if __name__ == '__main__':
    try: main()
    except Exception:
        print(json.dumps({'event': 'refresh.start_failed'}), flush=True)
        raise SystemExit(1) from None
