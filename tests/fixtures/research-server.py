"""Synthetic MCP + real research SQL, never imports models or opens a real corpus."""
import json
import logging
import os
from pathlib import Path
import sqlite3
import sys
import threading
from datetime import datetime, timezone
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'rag'))
from research import Research, project_messages
from mcp.server.fastmcp import FastMCP

logging.disable(logging.CRITICAL)
root = Path(sys.argv[1])
raw = root / 'raw'
raw.mkdir()
rows = []
for number in range(83):
    rows.append({'id': str(1000 + number), 'timestamp': f'2026-11-02T{number // 60:02}:{number % 60:02}:00Z', 'channel_id': '2', '_channel': 'announcements', 'author': {'id': '3', 'username': 'alice', 'global_name': 'Alice Researcher'}, 'content': os.environ['TEST_CONTENT_MARKER']})
for ident, stamp in [('2000', '2026-10-31T00:00:00Z'), ('2001', '2026-11-03T12:30:00Z')]:
    rows.append({'id': ident, 'timestamp': stamp, 'channel_id': '4', '_channel': 'other', 'author': {'id': '5', 'username': 'bob'}, 'content': 'Synthetic outside-interval boundary'})
(raw / '2.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in rows))
database = root / 'rag.sqlite'
con = sqlite3.connect(database)
con.executescript('create table chunks(id integer primary key,msg_ids text,t0 text,t1 text)')
con.execute('insert into chunks values (1,?,?,?)', (json.dumps([row['id'] for row in rows]), rows[-2]['timestamp'], rows[-1]['timestamp']))
project_messages(con, raw, lambda row: row['content'])
con.commit(); con.close()
(root / 'manifest.json').write_text(json.dumps({'created_utc': datetime.now(timezone.utc).isoformat(), 'files': {'index/rag.sqlite': 'a' * 64}}))
con = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, check_same_thread=False, cached_statements=0)
con.execute('pragma temp_store=MEMORY'); con.row_factory = sqlite3.Row
api = Research(SimpleNamespace(con=con, _lock=threading.Lock(), _index_target=root, reload_index=lambda: None))
app = FastMCP('synthetic-research', host='127.0.0.1', port=int(sys.argv[2]), stateless_http=True, json_response=True, log_level='CRITICAL')
for name in ['corpus_info', 'search_messages', 'list_messages', 'get_message', 'get_thread']:
    app.tool(annotations={'readOnlyHint': True, 'destructiveHint': False})(getattr(api, name))
try:
    app.run(transport='streamable-http')
finally:
    con.close()
