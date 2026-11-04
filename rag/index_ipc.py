"""Private bounded embedding IPC; reuses the query model without another load."""
import base64
import json
import os
from pathlib import Path
import socket
import socketserver
import stat
import threading
import time


def start_embedding_server(searcher, path):
    path = Path(path)
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError('Invalid private embedding socket')
        path.unlink()

    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            self.request.settimeout(10)
            try:
                line = self.rfile.readline(65537)
                if len(line) > 65536 or not line.endswith(b'\n'):
                    raise ValueError()
                request = json.loads(line)
                text = request.get('text') if isinstance(request, dict) else None
                if not isinstance(text, str) or not text.startswith('passage: ') or len(text) > 16384:
                    raise ValueError()
                vector = searcher.embed_index(text)
                result = {'busy': True} if vector is None else {'vector': base64.b64encode(vector.tobytes()).decode('ascii')}
            except BaseException:
                result = {'error': 'embedding_request_failed'}
            try:
                self.wfile.write(json.dumps(result).encode() + b'\n')
            except (OSError, TimeoutError):
                pass

    server = socketserver.UnixStreamServer(str(path), Handler)
    os.chmod(path, 0o600)
    thread = threading.Thread(target=server.serve_forever, name='private-index-embed', daemon=True)
    thread.start()
    return server


class IndexEmbedder:
    def __init__(self, path, timeout=120):
        self.path, self.timeout = str(path), timeout

    def encode(self, texts, **kwargs):
        import numpy as np
        rows = []
        for text in texts:
            deadline = time.monotonic() + self.timeout
            while True:
                with socket.socket(socket.AF_UNIX) as stream:
                    stream.settimeout(45)
                    stream.connect(self.path)
                    stream.sendall(json.dumps({'text': text}).encode() + b'\n')
                    with stream.makefile('rb') as reader:
                        line = reader.readline(8193)
                    if len(line) > 8192:
                        raise RuntimeError('Invalid embedding response')
                    result = json.loads(line)
                if result.get('busy') is True:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Query model busy')
                    time.sleep(0.2)
                    continue
                value = base64.b64decode(result.get('vector', ''), validate=True)
                row = np.frombuffer(value, dtype=np.float16)
                if row.shape != (768,) or not np.isfinite(row).all():
                    raise RuntimeError('Invalid embedding response')
                rows.append(row.copy())
                # Let newly arriving user queries claim the model between passages.
                time.sleep(0.05)
                break
        return np.stack(rows)
