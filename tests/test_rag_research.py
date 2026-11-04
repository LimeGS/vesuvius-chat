"""Synthetic-only contract tests; no model, collector, network or live index."""
import contextlib
import asyncio
import gc
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import weakref


def load_research():
    path = Path(__file__).resolve().parents[1] / 'rag/research.py'
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location('synthetic_research', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ResearchTest(unittest.TestCase):
    def setUp(self):
        self.module = load_research()
        self.assertIsNotNone(self.module, 'structured research backend is not implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.raw = self.root / 'raw'
        self.raw.mkdir()
        self.db = self.root / 'rag.sqlite'
        self.rows = [
            self.message('10', '2026-11-01T23:59:59.999999+00:00'),
            self.message('11', '2026-11-02T00:00:00Z'),
            self.message('12', '2026-11-02T00:00:00+00:00', author='bob', aid='202'),
            self.message('13', '2026-11-02T23:59:59.999999Z', channel='302', name='other'),
            self.message('14', '2026-11-03T00:00:00Z'),
        ]
        self.prepare(self.rows)

    def message(self, mid, stamp, author='alice', aid='201', channel='301', name='general', **extra):
        return {'id': mid, 'timestamp': stamp, 'channel_id': channel, '_channel': name,
                'author': {'id': aid, 'username': author, 'global_name': author.title()},
                'content': 'ink detection original ' + mid, **extra}

    def prepare(self, rows, chunks=None):
        (self.raw / '301.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in rows))
        con = sqlite3.connect(self.db)
        con.execute('create table if not exists chunks(id integer primary key,msg_ids text,t0 text,t1 text)')
        con.execute('delete from chunks')
        for i, ids in enumerate(chunks or [[r['id'] for r in rows]], 1):
            con.execute('insert into chunks values (?,?,?,?)', (i, json.dumps(ids), '2026-11-01T23:59:59.999999Z', '2026-11-03T00:00:00Z'))
        con.commit()
        self.module.project_messages(con, self.raw, lambda m: m.get('content', ''))
        con.close()
        self.write_manifest('a' * 64)
        self.connect()

    def write_manifest(self, ident):
        (self.root / 'manifest.json').write_text(json.dumps({'created_utc': '2026-11-03T12:39:52.807315+00:00', 'files': {'index/rag.sqlite': ident}}))

    def connect(self):
        if hasattr(self, 'searcher'):
            self.searcher.con.close()
        con = sqlite3.connect(self.db.as_uri() + '?mode=ro', uri=True, cached_statements=0)
        con.row_factory = sqlite3.Row
        con.execute('pragma temp_store=MEMORY')
        self.searcher = SimpleNamespace(con=con, _lock=threading.Lock(), _index_target=self.root, reload_index=lambda: None)
        self.addCleanup(con.close)
        self.api = self.module.Research(self.searcher)

    def ids(self, page):
        return [m['messageId'] for m in page['messages']]

    def test_exact_november_second_not_chunk_bounds(self):
        page = self.api.list_messages(since='2026-11-02T00:00:00Z', until='2026-11-03T00:00:00Z')
        self.assertEqual(self.ids(page), ['11', '12', '13'])
        self.assertTrue(page['exhaustive'])
        self.assertEqual(page['version'], 1)
        self.assertEqual(page['snapshot'], 'a' * 64)
        self.assertEqual(page['messages'][0], {'messageId': '11', 'timestamp': '2026-11-02T00:00:00.000000Z', 'channelId': '301', 'channel': 'general', 'authorId': '201', 'author': 'Alice', 'username': 'alice', 'globalName': 'Alice', 'threadId': None, 'text': 'ink detection original 11', 'url': 'https://discord.com/channels/1/301/11'})

    def test_unknown_alias_is_omitted_and_long_ids_preserve_the_protocol_bound(self):
        mid = '9' * 32
        row = self.message(mid, '2026-11-02T00:00:00Z')
        row['author'].pop('global_name')
        self.prepare([row])
        result = self.api.get_message(mid)['messages'][0]
        self.assertEqual(result['messageId'], mid)
        self.assertNotIn('globalName', result)

    def test_exact_ids_usernames_display_names_and_channel_names(self):
        for author in ['201', 'alice', 'Alice', 'ALICE']:
            self.assertEqual(self.ids(self.api.list_messages(author=author, channel='general')), ['10', '11', '14'])
        self.assertEqual(self.ids(self.api.list_messages(channel='302')), ['13'])
        for value in ['ali', '%', "' OR 1=1 --"]:
            self.assertEqual(self.ids(self.api.list_messages(author=value)), [])
        self.assertEqual(self.ids(self.api.list_messages(channel='gener')), [])

    def test_unicode_filters_and_numeric_ids_are_consistent_with_chat(self):
        row = self.message('42', '2026-11-02T00:00:00Z', author='123', name='123')
        row['author']['global_name'] = 'Élodie'
        self.prepare([row])
        self.assertEqual(self.ids(self.api.list_messages(author='élodie')), ['42'])
        self.assertEqual(self.ids(self.api.list_messages(author='123')), [])
        self.assertEqual(self.ids(self.api.list_messages(channel='123')), [])

    def test_topic_research_reuses_existing_translated_semantic_candidates(self):
        observed = []
        def search(query, **kwargs):
            observed.append((query, kwargs))
            return [{'hit': '11', 'msg_ids': json.dumps(['11'])}]
        self.searcher.search = search
        result = self.api.search_messages('detección de tinta', since='2026-11-02T00:00:00Z', until='2026-11-03T00:00:00Z')
        self.assertEqual(self.ids(result), ['11'])
        self.assertEqual(observed[0][0], 'detección de tinta')
        self.assertFalse(result['exhaustive'])

    def test_dst_instants_are_filtered_without_timezone_guessing(self):
        rows = [self.message(str(i + 30), stamp) for i, stamp in enumerate([
            '2026-11-01T03:59:59.999999Z', '2026-11-01T04:00:00Z',
            '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z',
            '2026-11-02T04:59:59.999999Z', '2026-11-02T05:00:00Z'])]
        self.prepare(rows)
        self.assertEqual(self.ids(self.api.list_messages(since='2026-11-01T04:00:00Z', until='2026-11-02T05:00:00Z')), ['31', '32', '33', '34'])

    def test_keyset_paging_ties_scope_thread_and_stale_snapshot(self):
        one = self.api.list_messages(limit=2)
        self.assertEqual(self.ids(one), ['10', '11'])
        self.assertFalse(one['exhaustive'])
        two = self.api.list_messages(limit=2, cursor=one['nextCursor'])
        self.assertEqual(self.ids(two), ['12', '13'])
        last = self.api.list_messages(limit=2, cursor=two['nextCursor'])
        self.assertEqual(self.ids(last), ['14'])
        self.assertTrue(last['exhaustive'])
        self.assertIsNone(last['nextCursor'])
        for args in [{'author': 'alice'}, {'channel': 'other'}, {'since': '2026-11-02T00:00:00Z'}]:
            with self.assertRaisesRegex(ValueError, 'cursor'):
                self.api.list_messages(cursor=one['nextCursor'], **args)
        with self.assertRaisesRegex(ValueError, 'cursor'):
            self.api.get_thread('11', cursor=one['nextCursor'])
        with self.assertRaisesRegex(ValueError, 'cursor'):
            self.api.list_messages(cursor=one['nextCursor'][:-2] + 'xx')
        self.write_manifest('b' * 64)
        with self.assertRaisesRegex(ValueError, 'cursor'):
            self.api.list_messages(cursor=one['nextCursor'])
        self.assertEqual(self.api.corpus_info()['snapshot'], 'b' * 64)

    def test_search_is_exact_message_fts_filtered_and_never_exhaustive(self):
        page = self.api.search_messages('ink', since='2026-11-02T00:00:00Z', until='2026-11-03T00:00:00Z', author='bob')
        self.assertEqual(self.ids(page), ['12'])
        self.assertFalse(page['exhaustive'])
        self.assertIsNone(page['nextCursor'])
        self.assertEqual(self.ids(self.api.search_messages('nonexistent')), [])
        self.assertFalse(self.api.search_messages('nonexistent')['exhaustive'])
        self.assertEqual(self.ids(self.api.search_messages('" OR * --')), [])

    def test_context_uses_only_indexed_membership_and_preserves_filters(self):
        self.prepare(self.rows + [self.message('99', '2026-11-02T12:00:00Z')], [['10', '11', '12'], ['13', '14']])
        page = self.api.get_thread('11', since='2026-11-02T00:00:00Z', author='alice')
        self.assertEqual(self.ids(page), ['11'])
        self.assertEqual(self.ids(self.api.get_thread('99')), [])
        self.assertEqual(self.ids(self.api.get_message('99')), [])
        self.assertEqual(self.ids(self.api.get_message('11', author='bob')), [])
        self.assertEqual(self.ids(self.api.get_message('11')), ['11'])

    def test_explicit_thread_metadata_links_original_channel_without_name_inference(self):
        rows = [self.message('100', '2026-11-02T01:00:00Z', thread={'id': '401'}),
                self.message('101', '2026-11-02T02:00:00Z', channel='401', name='thread-topic'),
                self.message('102', '2026-11-02T03:00:00Z', channel='402', name='thread-topic')]
        self.prepare(rows, [['100'], ['101'], ['102']])
        page = self.api.get_thread('100', limit=1)
        self.assertEqual(self.ids(page), ['100'])
        self.assertEqual(page['messages'][0]['threadId'], '401')
        next_page = self.api.get_thread('100', limit=1, cursor=page['nextCursor'])
        self.assertEqual(self.ids(next_page), ['101'])
        self.assertEqual(next_page['messages'][0]['threadId'], '401')
        with self.assertRaisesRegex(ValueError, 'cursor'):
            self.api.get_thread('101', cursor=page['nextCursor'])

    def test_coverage_uses_manifest_not_request_time_or_next_day(self):
        with patch.dict(os.environ, {'RAG_DEVICE': 'cuda:0'}):
            info = self.api.corpus_info()
        self.assertEqual(info, {'version': 1, 'snapshot': 'a' * 64, 'backend': 'gpu',
                               'coverageStart': '2026-11-01T23:59:59.999999Z',
                               'coverageEnd': '2026-11-03T00:00:00.000001Z',
                               'latestMessageAt': '2026-11-03T00:00:00.000000Z',
                               'updatedAt': '2026-11-03T12:39:52.807315Z', 'messageCount': 5,
                               'capabilities': {'structured': True}})
        self.assertFalse(self.api.list_messages(since='2026-11-04T00:00:00Z')['exhaustive'])

    def test_old_empty_and_manifest_free_snapshots_do_not_invent_capability(self):
        self.searcher.con.close()
        con = sqlite3.connect(self.db)
        con.executescript('drop table research_messages; drop table research_fts;')
        con.close()
        self.connect()
        self.assertFalse(self.api.corpus_info()['capabilities']['structured'])
        for action in [lambda: self.api.list_messages(), lambda: self.api.search_messages('ink'), lambda: self.api.get_message('11')]:
            with self.assertRaisesRegex(RuntimeError, 'unavailable'):
                action()
        con = sqlite3.connect(self.db)
        con.execute('delete from chunks'); con.commit()
        self.module.project_messages(con, self.raw, lambda m: m['content']); con.close()
        (self.root / 'manifest.json').unlink()
        self.connect()
        info = self.api.corpus_info()
        self.assertTrue(info['capabilities']['structured'])
        self.assertEqual(info['messageCount'], 0)
        self.assertIsNone(info['coverageEnd'])
        self.assertIsNone(info['updatedAt'])
        self.assertEqual(info['snapshot'], self.api.corpus_info()['snapshot'])
        self.assertEqual(self.ids(self.api.list_messages()), [])

    def test_boundary_validation_caps_and_no_private_errors(self):
        for args in [{'limit': 0}, {'limit': 21}, {'limit': True}, {'limit': 1.2},
                     {'since': '2026-11-02'}, {'since': '2026-02-30T00:00:00Z'},
                     {'since': '2026-11-02T00:00:00+02:00'}, {'until': 'junk'},
                     {'since': '2026-11-03T00:00:00Z', 'until': '2026-11-02T00:00:00Z'},
                     {'channel': ''}, {'author': 'x' * 201}, {'author': 'private\x00marker'}, {'cursor': 'x' * 4097}]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.api.list_messages(**args)
        for query in ['', ' ', 'x' * 1201, 123, None]:
            with self.assertRaises(ValueError):
                self.api.search_messages(query)
        for mid in ['', '1 OR 1=1', 'x' * 100, 11, None]:
            with self.assertRaises(ValueError):
                self.api.get_message(mid)
        self.rows[1]['content'] = 'x' * 5000
        self.prepare(self.rows)
        self.assertEqual(len(self.api.get_message('11')['messages'][0]['text']), 4000)
        logs = io.StringIO()
        with contextlib.redirect_stdout(logs), contextlib.redirect_stderr(logs):
            self.api.search_messages('PRIVATE_QUERY_MARKER')
        self.assertEqual(logs.getvalue(), '')
        self.assertNotIn('PRIVATE_QUERY_MARKER', repr(self.api.__dict__) + repr(self.searcher.__dict__))
        with self.assertRaises(sqlite3.OperationalError):
            self.searcher.con.execute('create table forbidden(x)')

    def test_all_pages_are_capped_at_twenty_and_non_bmp_text_is_client_bounded(self):
        rows = [self.message(str(100 + i), '2026-11-02T00:00:00Z') for i in range(45)]
        rows[0]['content'] = '\U0001f30b' * 5000
        self.prepare(rows)
        seen = []
        page = self.api.list_messages()
        self.assertEqual(len(page['messages']), 20)
        self.assertLessEqual(len(page['messages'][0]['text'].encode('utf-16-le')) // 2, 4000)
        while True:
            seen.extend(self.ids(page))
            self.assertLessEqual(len(page['messages']), 20)
            if page['nextCursor'] is None:
                break
            self.assertFalse(page['exhaustive'])
            page = self.api.list_messages(cursor=page['nextCursor'])
        self.assertEqual(seen, [str(100 + i) for i in range(45)])
        self.assertTrue(page['exhaustive'])
        self.assertEqual(len(self.api.search_messages('ink', limit=20)['messages']), 20)

    def test_reload_is_shared_and_errors_and_lock_wait_do_not_leak_inputs(self):
        calls = []
        self.searcher.reload_index = lambda: calls.append('reload')
        self.api.corpus_info()
        self.api.search_messages('ink')
        self.api.get_message('11')
        self.api.get_thread('11')
        self.api.list_messages()
        self.assertEqual(len(calls), 5)
        def broken():
            raise RuntimeError('PRIVATE_BACKEND_ERROR')
        self.searcher.reload_index = broken
        with self.assertRaisesRegex(RuntimeError, '^Research unavailable$'):
            self.api.search_messages('PRIVATE_QUERY')
        self.searcher._lock.acquire()
        try:
            with patch.object(self.module, 'LOCK_TIMEOUT', 0.001), self.assertRaisesRegex(RuntimeError, '^Research unavailable$'):
                self.api.corpus_info()
        finally:
            self.searcher._lock.release()

    def test_closed_database_fails_safely_and_does_not_strand_shared_lock(self):
        self.searcher.con.close()
        with self.assertRaisesRegex(RuntimeError, '^Research unavailable$'):
            self.api.corpus_info()
        self.assertFalse(self.searcher._lock.locked())

    def test_manifest_for_legacy_index_directory_is_read_from_matching_bundle(self):
        self.searcher.con.close()
        bundle = self.root / 'bundle'
        index = bundle / 'index'; index.mkdir(parents=True)
        self.db.rename(index / 'rag.sqlite')
        self.db = index / 'rag.sqlite'
        (self.root / 'manifest.json').rename(bundle / 'manifest.json')
        self.connect()
        self.searcher._index_target = index
        self.assertEqual(self.api.corpus_info()['updatedAt'], '2026-11-03T12:39:52.807315Z')

    def test_real_runtime_hot_reload_rejects_previous_cursor_without_loading_models(self):
        import numpy as np
        import shutil
        bundle = self.root / 'runtime-bundle'; bundle.mkdir()
        (bundle / 'handles.json').write_text('{}')
        versions = [bundle / 'v1', bundle / 'v2']
        for i, version in enumerate(versions):
            version.mkdir()
            shutil.copyfile(self.db, version / 'rag.sqlite')
            con = sqlite3.connect(version / 'rag.sqlite')
            con.execute('create table units(id integer primary key,parent integer,msg_id text,text text)')
            if i:
                con.execute("update research_messages set timestamp='2026-11-03T01:00:00.000000Z' where id='14'")
            con.commit(); con.close()
            np.save(version / 'vectors.f16.npy', np.empty((0, 768), dtype=np.float16))
            (version / 'manifest.json').write_text(json.dumps({'created_utc': '2026-11-03T12:39:52.807315Z', 'files': {'index/rag.sqlite': ('b' if i else 'a') * 64}}))
        index = bundle / 'index'; index.symlink_to(versions[0])
        spec = importlib.util.spec_from_file_location('synthetic_hot_runtime', 'rag/runtime.py')
        runtime = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {'RAG_BUNDLE_DIR': str(bundle)}):
            spec.loader.exec_module(runtime)
            searcher = runtime.Searcher(rerank=False)
        self.addCleanup(lambda: searcher.con.close())
        api = self.module.Research(searcher)
        cursor = api.list_messages(limit=1)['nextCursor']
        index.unlink(); index.symlink_to(versions[1])
        with self.assertRaisesRegex(ValueError, 'cursor'):
            api.list_messages(limit=1, cursor=cursor)
        info = api.corpus_info()
        self.assertEqual(info['snapshot'], 'b' * 64)
        self.assertEqual(info['latestMessageAt'], '2026-11-03T01:00:00.000000Z')
        self.assertEqual(searcher._index_target, versions[1].resolve())
        self.assertIsNone(searcher._emb)
        self.assertIsNone(searcher._mt)
        self.assertIsNone(searcher._ce)

    def test_query_budget_recovers_without_retaining_query_objects_or_sql_bindings(self):
        rows = [self.message(str(100 + i), '2026-11-02T00:00:00Z') for i in range(200)]
        self.prepare(rows)
        with patch.object(self.module, 'QUERY_TIMEOUT', 0), self.assertRaisesRegex(RuntimeError, '^Research unavailable$'):
            self.api.search_messages('PRIVATE_TIMEOUT_QUERY')
        self.assertEqual(len(self.api.list_messages()['messages']), 20)
        class Query(str):
            pass
        query = Query('PRIVATE_COMPLETED_QUERY')
        reference = weakref.ref(query)
        self.api.search_messages(query)
        del query
        gc.collect()
        self.assertIsNone(reference())
        import ctypes
        import _sqlite3
        library = ctypes.CDLL(_sqlite3.__file__)
        library.sqlite3_next_stmt.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        library.sqlite3_next_stmt.restype = ctypes.c_void_p
        library.sqlite3_expanded_sql.argtypes = [ctypes.c_void_p]
        library.sqlite3_expanded_sql.restype = ctypes.c_void_p
        library.sqlite3_free.argtypes = [ctypes.c_void_p]
        database = ctypes.c_void_p.from_address(id(self.searcher.con) + object.__basicsize__).value
        statement = library.sqlite3_next_stmt(database, None)
        while statement:
            text = library.sqlite3_expanded_sql(statement)
            try:
                self.assertNotIn('private_', ctypes.string_at(text).decode().lower())
            finally:
                library.sqlite3_free(text)
            statement = library.sqlite3_next_stmt(database, statement)

    def test_projection_deduplicates_original_rows_and_rolls_back_invalid_metadata(self):
        changed = {**self.rows[1], 'author': {'id': '202', 'username': 'bob', 'global_name': 'Robert'},
                   'member': {'nick': 'Bobby'}, 'content': 'replacement original text'}
        self.prepare(self.rows + [changed])
        self.assertEqual(self.api.corpus_info()['messageCount'], 5)
        for author in ['202', 'bob', 'Robert', 'Bobby']:
            self.assertEqual(self.ids(self.api.list_messages(author=author)), ['11', '12'] if author in ['202', 'bob'] else ['11'])
        self.assertEqual(self.api.get_message('11')['messages'][0]['author'], 'Bobby')
        (self.raw / '301.jsonl').write_text(json.dumps({**changed, 'author': {'username': 'bob'}}) + '\n')
        con = sqlite3.connect(self.db)
        try:
            with self.assertRaisesRegex(ValueError, '^Invalid research projection$'):
                self.module.project_messages(con, self.raw, lambda m: m['content'])
            self.assertEqual(con.execute("select author_id,text from research_messages where id='11'").fetchone(), ('202', 'replacement original text'))
            self.assertEqual(con.execute('select count(*) from research_fts').fetchone()[0], 5)
        finally:
            con.close()

    def test_projection_requires_original_metadata_for_every_indexed_id(self):
        con = sqlite3.connect(self.root / 'bad.sqlite')
        self.addCleanup(con.close)
        con.execute('create table chunks(msg_ids text)')
        con.execute('insert into chunks values (?)', (json.dumps(['999']),)); con.commit()
        with self.assertRaisesRegex(ValueError, '^Invalid research projection$'):
            self.module.project_messages(con, self.raw, lambda m: m['content'])

    def test_mcp_registers_json_objects_and_keeps_legacy_tools_without_extra_warmup(self):
        spec = importlib.util.spec_from_file_location('research_server', 'rag/server.py')
        server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(server)
        tools = {}
        annotations = {}
        results = {}
        searcher = self.searcher
        searcher.search = lambda *_args, **_kwargs: []

        class MCP:
            def __init__(self, *_args, **_kwargs):
                pass

            def tool(self, **kwargs):
                def register(function):
                    tools[function.__name__] = function
                    annotations[function.__name__] = kwargs.get('annotations')
                    return function
                return register

            def run(self, **_kwargs):
                self_info = tools.get('corpus_info')
                if self_info:
                    results['info'] = self_info()
                    results['page'] = tools['list_messages'](author='bob')
                    tools['get_message']('11')

        modules = {'mcp.server.fastmcp': SimpleNamespace(FastMCP=MCP),
                   'runtime': SimpleNamespace(Searcher=lambda: searcher, as_markdown=lambda rows: '', INSTRUCTIONS='Synthetic'),
                   'research': self.module, 'index_ipc': SimpleNamespace(start_embedding_server=lambda *_args: None)}
        import logging
        previous = logging.root.manager.disable
        try:
            with patch.dict(sys.modules, modules), patch.dict(os.environ, {'RAG_READY_FILE': ''}):
                server.main()
        finally:
            logging.disable(previous)
        self.assertEqual(set(tools), {'corpus_info', 'search_messages', 'list_messages', 'get_message', 'get_thread', 'search_discord', 'corpus_status'})
        self.assertIsInstance(tools['corpus_info'].__self__, self.module.Research)
        self.assertIsInstance(results['info'], dict)
        self.assertEqual(self.ids(results['page']), ['12'])
        for name in ['corpus_info', 'list_messages', 'get_message', 'get_thread', 'search_messages']:
            self.assertEqual(annotations[name], {'readOnlyHint': True, 'destructiveHint': False})

    def test_real_mcp_sdk_emits_root_structured_objects_not_string_only_results(self):
        try:
            from mcp.server.fastmcp import FastMCP
        except ImportError:
            self.skipTest('MCP SDK is not installed')
        app = FastMCP('synthetic-offline')
        for name in ['corpus_info', 'list_messages', 'get_message', 'get_thread', 'search_messages']:
            app.tool(annotations={'readOnlyHint': True, 'destructiveHint': False})(getattr(self.api, name))
        async def check():
            catalog = await app.list_tools()
            for tool in catalog:
                self.assertIsNotNone(tool.outputSchema, 'JSON tool must advertise structured output')
                self.assertTrue(tool.annotations.readOnlyHint)
                self.assertFalse(tool.annotations.destructiveHint)
            for name, args in [('corpus_info', {}), ('list_messages', {'author': 'bob'}),
                               ('get_message', {'message_id': '11'}), ('get_thread', {'message_id': '11'}),
                               ('search_messages', {'query': 'ink'})]:
                result = await app.call_tool(name, args)
                self.assertIsInstance(result, tuple)
                structured = result[1]
                self.assertEqual(structured['version'], 1)
                self.assertNotIn('result', structured, 'contract object must not be SDK-wrapped')
        asyncio.run(check())

    def test_portable_installed_builder_preserves_original_metadata(self):
        import hashlib
        import numpy as np
        import shutil
        installed = self.root / 'installed'
        (installed / 'docker').mkdir(parents=True); (installed / 'rag').mkdir()
        shutil.copyfile('docker/refresh.py', installed / 'docker/refresh.py')
        shutil.copyfile('rag/research.py', installed / 'rag/research.py')
        spec = importlib.util.spec_from_file_location('standalone_refresh', installed / 'docker/refresh.py')
        worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
        raw = installed / 'raw'; raw.mkdir()
        (raw / '301.jsonl').write_text(json.dumps(self.rows[1]) + '\n')
        bundle = installed / 'bundle'; bundle.mkdir()
        worker.build(raw, bundle, lambda texts: np.tile(np.eye(1, 768, dtype=np.float32), (len(texts), 1)))
        con = sqlite3.connect(bundle / 'index/rag.sqlite'); self.addCleanup(con.close)
        self.assertEqual(con.execute('select id,author_id,username,channel_id from research_messages').fetchall(), [('11', '201', 'alice', '301')])
        manifest = json.loads((bundle / 'index/manifest.json').read_text())
        self.assertEqual(manifest['files']['index/rag.sqlite'], hashlib.sha256((bundle / 'index/rag.sqlite').read_bytes()).hexdigest())


if __name__ == '__main__':
    unittest.main()
