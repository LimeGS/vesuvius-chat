import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('docker_refresh', ROOT / 'docker/refresh.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class RefreshTest(unittest.TestCase):
    def test_model_bootstrap_marks_only_complete_downloads_and_reuses_them(self):
        from types import SimpleNamespace
        spec = importlib.util.spec_from_file_location('docker_bootstrap_test', ROOT / 'docker/bootstrap.py')
        bootstrap = importlib.util.module_from_spec(spec); spec.loader.exec_module(bootstrap)
        with tempfile.TemporaryDirectory() as tmp:
            bundle = Path(tmp)
            def failed(*args, **kwargs): raise RuntimeError('offline')
            with patch.dict(sys.modules, {'huggingface_hub': SimpleNamespace(snapshot_download=failed)}):
                with self.assertRaises(RuntimeError): bootstrap.models(bundle)
            self.assertFalse(list(bundle.rglob('.ready')))
            self.assertFalse((bundle / 'handles.json').exists())
            downloads = []
            def download(name, revision, local_dir, **kwargs):
                self.assertRegex(revision, '^[0-9a-f]{40}$')
                downloads.append(name); local_dir.mkdir(parents=True, exist_ok=True)
            with patch.dict(sys.modules, {'huggingface_hub': SimpleNamespace(snapshot_download=download)}): bootstrap.models(bundle)
            self.assertEqual(len(downloads), 4)
            self.assertTrue((bundle / 'models/intfloat--multilingual-e5-base/.ready').exists())
            self.assertTrue((bundle / 'models/Helsinki-NLP--opus-mt-es-en/.ready').exists())
            self.assertEqual(json.loads((bundle / 'handles.json').read_text()), {})
            with patch.dict(sys.modules, {'huggingface_hub': SimpleNamespace(snapshot_download=failed)}): bootstrap.models(bundle)

    def test_schedule_targets_next_utc_half_hour(self):
        self.assertEqual(worker.next_delay(1801), 1799)
        self.assertEqual(worker.next_delay(1800), 1800)

    def test_collection_keeps_selected_channels_and_retries_rate_limits(self):
        responses = [({'id': '22', 'guild_id': '11', 'name': 'selected', 'type': 0}, 200),
                     ({'retry_after': 0.01}, 429),
                     ([{'id': '100', 'channel_id': '22', 'timestamp': '2026-11-03T00:00:00Z', 'content': 'ink evidence', 'author': {'id': '99', 'username': 'reader'}}], 200),
                     ([], 200)]
        class Response:
            def __init__(self, data, status): self.data, self.status_code, self.headers = data, status, {}
            def json(self): return self.data
            def raise_for_status(self):
                if self.status_code != 200: raise RuntimeError('http')
        class Session:
            headers = {}
            def get(self, url, **kwargs):
                self.paths.append(url)
                return Response(*responses.pop(0))
            paths = []
        with tempfile.TemporaryDirectory() as tmp, patch.object(worker.time, 'sleep'):
            session = Session()
            worker.collect(Path(tmp), '11', ['22'], 'bot-secret', session)
            row = json.loads((Path(tmp) / '22.jsonl').read_text())
            self.assertEqual(row['_channel'], 'selected')
            self.assertTrue(all('/channels/22' in url for url in session.paths))
            self.assertEqual(session.headers['Authorization'], 'Bot bot-secret')
            self.assertFalse(responses)

    def test_build_publishes_compatible_index_and_failed_build_keeps_previous(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp); raw = base / 'raw'; raw.mkdir(); bundle = base / 'bundle'; bundle.mkdir()
            (bundle / 'handles.json').write_text('{}')
            message = {'id': '100', 'channel_id': '22', '_channel': 'general', 'timestamp': '2026-11-03T00:00:00Z', 'content': 'A synthetic ink evidence message for retrieval.', 'author': {'id': '99', 'username': 'reader'}}
            (raw / '22.jsonl').write_text(json.dumps(message) + '\n')
            def encode(texts): return np.tile(np.eye(1, 768, dtype=np.float32), (len(texts), 1))
            with patch.dict(os.environ, {'DISCORD_GUILD_ID': '11'}):
                worker.build(raw, bundle, encode)
            first = (bundle / 'index').resolve()
            con = sqlite3.connect(first / 'rag.sqlite')
            self.assertEqual(con.execute('select count(*) from research_messages').fetchone()[0], 1)
            self.assertEqual(con.execute('select url from research_messages').fetchone()[0], 'https://discord.com/channels/11/22/100')
            self.assertEqual(con.execute("select count(*) from fts where fts match 'ink'").fetchone()[0], 1)
            con.close()
            message['content'] += ' modified'
            (raw / '22.jsonl').write_text(json.dumps(message) + '\n')
            with self.assertRaises(RuntimeError):
                worker.build(raw, bundle, lambda _: (_ for _ in ()).throw(RuntimeError('build failure')))
            self.assertEqual((bundle / 'index').resolve(), first)

    def test_forbidden_channel_does_not_reuse_old_index_as_if_fresh(self):
        class Session:
            headers = {}
            def get(self, *args, **kwargs):
                return type('Response', (), {'status_code': 403})()
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(RuntimeError): worker.collect(Path(tmp), '11', ['22'], 'secret', Session())

    def test_collected_known_thread_preserves_full_paginated_context(self):
        import numpy as np
        import threading
        from types import SimpleNamespace
        from research import Research
        class Session:
            headers = {}
            page = 0
            def get(self, url, **kwargs):
                if url.endswith('/channels/22'): data = {'id': '22', 'guild_id': '11', 'type': 11, 'name': 'thread'}
                elif self.page == 0:
                    self.page += 1
                    data = [{'id': str(100+i), 'channel_id': '22', 'timestamp': f'2026-11-03T00:{i:02}:00Z', 'content': 'Synthetic original thread evidence.', 'author': {'id': '99', 'username': 'reader'}} for i in range(50)]
                else: data = []
                return type('Response', (), {'status_code': 200, 'json': lambda _: data})()
        with tempfile.TemporaryDirectory() as tmp, patch.object(worker.time, 'sleep'):
            raw = Path(tmp)/'raw'; bundle = Path(tmp)/'bundle'; bundle.mkdir()
            worker.collect(raw, '11', ['22'], 'token', Session())
            worker.build(raw, bundle, lambda texts: np.tile(np.eye(1, 768, dtype=np.float32), (len(texts), 1)))
            con = sqlite3.connect(bundle/'index/rag.sqlite'); con.row_factory = sqlite3.Row
            api = Research(SimpleNamespace(con=con, _lock=threading.Lock(), _index_target=(bundle/'index').resolve(), reload_index=lambda: None))
            count = 0; cursor = None
            while True:
                page = api.get_thread('100', limit=20, cursor=cursor)
                count += len(page['messages']); cursor = page['nextCursor']
                if not cursor: break
            con.close()
            self.assertEqual(count, 50)


if __name__ == '__main__': unittest.main()
