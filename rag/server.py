"""Private query-only MCP service; conversation inputs never enter logs or caches."""
import json
import logging
import os
from pathlib import Path
import time
from datetime import datetime, timezone
import uuid


def search_request(searcher, query):
    started = time.monotonic()
    status = 400
    try:
        if not isinstance(query, str) or not query.strip() or len(query) > 1200:
            raise ValueError("Invalid query")
        status = 503
        try:
            rows = searcher.search(query)
        except Exception:
            raise RuntimeError("Retrieval unavailable") from None
        status = 200
        return rows
    finally:
        print(json.dumps({"timestamp": datetime.now(timezone.utc).isoformat(),
                          "requestId": str(uuid.uuid4()), "event": "request.completed",
                          "route": "rag", "status": status,
                          "durationMs": round((time.monotonic() - started) * 1000)}), flush=True)


def main():
    for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "HF_HUB_DISABLE_PROGRESS_BARS"):
        os.environ[name] = "1"
    os.environ.setdefault("RAG_DEVICE", "cpu")
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    # Framework exceptions can contain tool inputs; only our allowlisted events are kept.
    logging.disable(logging.CRITICAL)
    from mcp.server.fastmcp import FastMCP
    from runtime import Searcher, as_markdown, INSTRUCTIONS
    try:
        from research import Research
    except ModuleNotFoundError:
        from rag.research import Research
    searcher = Searcher()
    searcher.search("¿Cómo se detecta la tinta del rollo 1447?", k=1)
    socket_path = Path(os.environ['RAG_READY_FILE']).with_name('index-embed.sock') if os.environ.get('RAG_READY_FILE') else None
    embedding_server = None
    if socket_path:
        from index_ipc import start_embedding_server
        embedding_server = start_embedding_server(searcher, socket_path)
    app = FastMCP("discord-rag", instructions=INSTRUCTIONS, host="127.0.0.1",
                  port=int(os.environ.get("RAG_PORT", "8765")), log_level="CRITICAL",
                  stateless_http=True, json_response=True)
    research = Research(searcher)
    for name in ('corpus_info', 'search_messages', 'list_messages', 'get_message', 'get_thread'):
        app.tool(annotations={'readOnlyHint': True, 'destructiveHint': False})(getattr(research, name))

    @app.tool()
    def search_discord(query: str) -> str:
        """Read-only Discord evidence search with original message permalinks."""
        return as_markdown(search_request(searcher, query))

    @app.tool()
    def corpus_status() -> str:
        """Return static index coverage metadata, not user queries or history."""
        with searcher._lock:
            searcher.reload_index()
            first, last, count = searcher.con.execute("select min(t0), max(t1), count(*) from chunks").fetchone()
        return f"Corpus: {first} to {last}; {count} conversations; read-only snapshot"

    ready = Path(os.environ["RAG_READY_FILE"]) if os.environ.get("RAG_READY_FILE") else None
    try:
        if ready:
            ready.write_text("ready\n")
        app.run(transport="streamable-http")
    finally:
        if embedding_server:
            embedding_server.shutdown()
            embedding_server.server_close()
            socket_path.unlink(missing_ok=True)
        if ready:
            ready.unlink(missing_ok=True)
        searcher.con.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"event": "rag.start_failed", "code": "rag_unavailable"}), flush=True)
        raise SystemExit(1) from None
