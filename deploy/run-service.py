"""Drop all raw service stdout/stderr before journald; retain fixed metadata only."""
import json
import math
import re
import signal
import subprocess
import sys
import threading

EVENTS = {"request.completed", "dependency.completed", "dependency.failed"}
ROUTES = {"chat", "session", "status", "rag"}
CODES = {"unauthorized", "rate_limited", "limits_unavailable", "invalid_request", "configuration_error", "rag_unavailable", "rag_timeout", "rag_primary_unavailable", "model_auth_failed", "model_rate_limited", "model_unavailable", "model_timeout", "model_invalid_json", "model_invalid_response", "model_invalid_citations", "model_empty_response", "model_response_too_large", "request_cancelled", "request_timeout", "internal_error"}


def safe_record(line):
    try:
        value = json.loads(line)
    except (ValueError, TypeError, RecursionError):
        return None
    if not isinstance(value, dict):
        return None
    if not isinstance(value.get("event"), str) or value["event"] not in EVENTS or not isinstance(value.get("route"), str) or value["route"] not in ROUTES:
        return None
    if not re.fullmatch(r"[a-fA-F0-9-]{36}", str(value.get("requestId", ""))):
        return None
    if not re.fullmatch(r"[0-9T:.+Z-]{20,40}", str(value.get("timestamp", ""))):
        return None
    result = {key: value[key] for key in ("timestamp", "requestId", "event", "route")}
    for key in ("status", "upstreamStatus", "durationMs", "sourceCount", "promptTokens", "cachedTokens"):
        number = value.get(key)
        if type(number) in (int, float) and math.isfinite(number) and 0 <= number <= 1_000_000_000:
            result[key] = number
    for key, allowed in (("level", {"info", "warn", "error"}), ("dependency", {"rag", "model"}), ("mode", {"demo", "live"}), ("code", CODES)):
        item = value.get(key)
        if isinstance(item, str) and item in allowed:
            result[key] = item
    if type(value.get("rag")) is bool:
        result["rag"] = value["rag"]
    return result


def main():
    if len(sys.argv) < 2:
        return 64
    child = subprocess.Popen(sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    lock = threading.Lock()

    def copy_metadata(stream):
        while True:
            line = stream.readline(8193)
            if not line:
                return
            if len(line) > 8192:
                while line and not line.endswith(b"\n"):
                    line = stream.readline(8193)
                continue
            record = safe_record(line.decode("utf-8", errors="replace"))
            if record:
                with lock:
                    sys.stdout.write(json.dumps(record) + "\n")
                    sys.stdout.flush()

    threads = [threading.Thread(target=copy_metadata, args=(stream,)) for stream in (child.stdout, child.stderr)]
    for thread in threads:
        thread.start()
    for kind in (signal.SIGTERM, signal.SIGINT):
        signal.signal(kind, lambda signum, _frame: child.send_signal(signum) if child.poll() is None else None)
    result = child.wait()
    for thread in threads:
        thread.join()
    return result if result >= 0 else 128 - result


if __name__ == "__main__":
    raise SystemExit(main())
