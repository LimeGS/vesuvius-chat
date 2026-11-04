import contextlib
import importlib.util
import io
import json
import logging
import os
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


class RagServiceTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("private_rag_service", "rag/server.py")
        self.server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.server)

    def test_startup_preserves_explicit_cuda_and_defaults_to_cpu(self):
        previous_logging = logging.root.manager.disable
        try:
            for selected in [None, "cuda:0"]:
                with self.subTest(device=selected):
                    seen = {}

                    class Searcher:
                        def __init__(self):
                            seen["device"] = os.environ["RAG_DEVICE"]
                            self.con = SimpleNamespace(close=lambda: seen.update(closed=True))

                        def search(self, query, **kwargs):
                            seen["warmup"] = (query, kwargs)

                    class MCP:
                        def __init__(self, *_args, **kwargs):
                            seen["host"] = kwargs["host"]

                        def tool(self, **_kwargs):
                            return lambda function: function

                        def run(self, **_kwargs):
                            pass

                    modules = {"mcp.server.fastmcp": SimpleNamespace(FastMCP=MCP),
                               "runtime": SimpleNamespace(Searcher=Searcher, as_markdown=lambda rows: rows, INSTRUCTIONS="Synthetic instructions")}
                    with patch.dict(sys.modules, modules), patch.dict(os.environ, {"RAG_READY_FILE": ""}):
                        if selected is None:
                            os.environ.pop("RAG_DEVICE", None)
                        else:
                            os.environ["RAG_DEVICE"] = selected
                        self.server.main()
                    self.assertEqual(seen["device"], selected or "cpu")
                    self.assertEqual(seen["host"], "127.0.0.1")
                    self.assertEqual(seen["warmup"], ("¿Cómo se detecta la tinta del rollo 1447?", {"k": 1}))
                    self.assertTrue(seen["closed"])
        finally:
            logging.disable(previous_logging)

    def test_failures_never_log_query_or_exception_content(self):
        class Broken:
            def search(self, _query):
                raise RuntimeError("PRIVATE_EXCEPTION_SENTINEL")
        logs = io.StringIO()
        with contextlib.redirect_stdout(logs), self.assertRaisesRegex(RuntimeError, "^Retrieval unavailable$"):
            self.server.search_request(Broken(), "PRIVATE_QUERY_SENTINEL")
        event = json.loads(logs.getvalue())
        self.assertEqual(event["status"], 503)
        self.assertNotIn("PRIVATE", logs.getvalue())
        self.assertEqual(set(event), {"timestamp", "requestId", "event", "route", "status", "durationMs"})

    def test_success_and_validation_emit_only_request_metadata(self):
        class Searcher:
            def search(self, _query):
                return [{"text": "PRIVATE_EVIDENCE_SENTINEL"}]
        for query, status in [("PRIVATE_USER_SENTINEL", 200), ("x" * 1201, 400), ("", 400)]:
            logs = io.StringIO()
            with contextlib.redirect_stdout(logs):
                if status == 200:
                    self.assertEqual(len(self.server.search_request(Searcher(), query)), 1)
                else:
                    with self.assertRaisesRegex(ValueError, "^Invalid query$"):
                        self.server.search_request(Searcher(), query)
            self.assertEqual(json.loads(logs.getvalue())["status"], status)
            self.assertNotIn("PRIVATE", logs.getvalue())


if __name__ == "__main__":
    unittest.main()
