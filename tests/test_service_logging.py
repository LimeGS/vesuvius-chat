import importlib.util
import json
import subprocess
import sys
import unittest


class ServiceLoggingTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("service_logging", "deploy/run-service.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def test_only_valid_fixed_metadata_survives_the_service_boundary(self):
        record = {"timestamp": "2026-10-31T00:00:00.000Z", "event": "request.completed", "route": "chat",
                  "requestId": "123e4567-e89b-42d3-a456-426614174000", "status": 200, "durationMs": 1,
                  "message": "PRIVATE_MESSAGE_SENTINEL", "headers": {"Authorization": "SECRET"}}
        clean = self.module.safe_record(json.dumps(record))
        self.assertEqual(clean["status"], 200)
        self.assertNotIn("PRIVATE", json.dumps(clean))
        self.assertNotIn("SECRET", json.dumps(clean))
        for line in ["Error: PRIVATE_EXCEPTION_SENTINEL", "PRIVATE_BODY", "null", '[]', json.dumps({**record, "event": {"secret": "PRIVATE"}}), json.dumps({**record, "route": []}), json.dumps({**record, "route": "PRIVATE_PATH"}), json.dumps({**record, "requestId": "PRIVATE_QUERY"})]:
            self.assertIsNone(self.module.safe_record(line))

    def test_stdout_stderr_and_large_raw_lines_never_reach_persistent_logging(self):
        record = {"timestamp": "2026-10-31T00:00:00.000Z", "event": "request.completed", "route": "rag",
                  "requestId": "123e4567-e89b-42d3-a456-426614174000", "status": 200, "durationMs": 1}
        code = f"import json,sys; print('PRIVATE_STDOUT'); print('PRIVATE_STDERR',file=sys.stderr); print('PRIVATE_'*20000); print({json.dumps(json.dumps(record))}); sys.exit(7)"
        result = subprocess.run([sys.executable, "deploy/run-service.py", sys.executable, "-c", code], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 7)
        self.assertNotIn("PRIVATE", result.stdout + result.stderr)
        records = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertIn(record, records)

    def test_primary_failover_keeps_only_its_fixed_diagnostic_code(self):
        record = {"timestamp": "2026-11-01T00:00:00.000Z", "event": "dependency.failed", "route": "chat",
                  "requestId": "123e4567-e89b-42d3-a456-426614174000", "level": "warn", "dependency": "rag",
                  "code": "rag_primary_unavailable", "message": "PRIVATE_QUERY", "url": "SECRET_ENDPOINT"}
        clean = self.module.safe_record(json.dumps(record))
        self.assertEqual(clean.get("code"), "rag_primary_unavailable")
        self.assertNotIn("PRIVATE", json.dumps(clean))
        self.assertNotIn("SECRET", json.dumps(clean))

    def test_cache_metrics_are_numeric_only_at_the_persistent_logging_boundary(self):
        record = {"timestamp": "2026-11-01T00:00:00.000Z", "event": "dependency.completed", "route": "chat",
                  "requestId": "123e4567-e89b-42d3-a456-426614174000", "dependency": "model", "promptTokens": 100,
                  "cachedTokens": 64, "content": "PRIVATE_CACHE_CONTENT"}
        clean = self.module.safe_record(json.dumps(record))
        self.assertEqual(clean.get("promptTokens"), 100)
        self.assertEqual(clean.get("cachedTokens"), 64)
        self.assertNotIn("PRIVATE", json.dumps(clean))
        invalid = self.module.safe_record(json.dumps({**record, "promptTokens": "PRIVATE", "cachedTokens": -1}))
        self.assertNotIn("promptTokens", invalid)
        self.assertNotIn("cachedTokens", invalid)


if __name__ == "__main__":
    unittest.main()
