import gc
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import weakref
import ctypes
import _sqlite3
import numpy as np


class Query(str):
    pass


class Tokenizer:
    def __call__(self, texts, **_kwargs):
        return {"query": texts[0]}

    def decode(self, values, **_kwargs):
        return "ink detection " + values


class Translator:
    def generate(self, query, **_kwargs):
        return [query]


class RagPrivacyTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.bundle = Path(self.temporary.name)
        (self.bundle / "index").mkdir()
        (self.bundle / "handles.json").write_text("{}")
        con = sqlite3.connect(self.bundle / "index" / "rag.sqlite")
        con.executescript("CREATE TABLE units(id INTEGER PRIMARY KEY, parent INT, msg_id TEXT, text TEXT); CREATE TABLE chunks(id INTEGER PRIMARY KEY, authors TEXT, team INT, scrolls TEXT, channel TEXT, t0 TEXT, t1 TEXT); CREATE VIRTUAL TABLE fts USING fts5(text, tags);")
        con.close()
        np.save(self.bundle / "index" / "vectors.f16.npy", np.empty((0, 768), dtype=np.float16))
        self.previous = os.environ.get("RAG_BUNDLE_DIR")
        os.environ["RAG_BUNDLE_DIR"] = str(self.bundle)
        spec = importlib.util.spec_from_file_location("private_rag_runtime", "rag/runtime.py")
        self.runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.runtime)
        self.searcher = self.runtime.Searcher(rerank=False)
        self.searcher._mt = (Tokenizer(), Translator())

    def tearDown(self):
        if hasattr(self, "searcher"):
            self.searcher.con.close()
        if self.previous is None:
            os.environ.pop("RAG_BUNDLE_DIR", None)
        else:
            os.environ["RAG_BUNDLE_DIR"] = self.previous
        self.temporary.cleanup()

    def test_translation_does_not_keep_completed_query_objects_alive(self):
        query = Query("PRIVATE_TRANSLATION_SENTINEL")
        reference = weakref.ref(query)
        self.searcher.translate(query)
        del query
        gc.collect()
        self.assertIsNone(reference(), "Completed input must not remain in a translation cache")

    def test_retrieval_metadata_is_english_without_translating_original_messages(self):
        self.assertEqual(self.runtime.as_markdown([]), "(no results)")
        rows = [{"header": "#example · 2026-10-01\nparticipantes: Example [equipo]\nrollos: PHerc1447",
                 "channel_id": "2", "msg_ids": json.dumps(["3"]), "hit": "3", "body": "[2026-10-01 10:00] ¿Qué es spiral fit?"}]
        text = self.runtime.as_markdown(rows)
        self.assertIn("Participants: Example [team]", text)
        self.assertIn("Scrolls: PHerc1447", text)
        self.assertIn("¿Qué es spiral fit?", text)
        self.assertIn("https://discord.com/channels/1/2/3", text)

    def test_success_and_failure_leave_no_last_query_on_shared_searcher(self):
        self.searcher.search("¿PRIVATE_QUERY_SENTINEL?", stage="bm25")
        self.assertNotIn("PRIVATE_QUERY_SENTINEL", json.dumps(self.searcher.__dict__, default=lambda _value: "opaque"))
        def fail(*_args, **_kwargs):
            raise RuntimeError("synthetic failure")
        self.searcher.bm25 = fail
        with self.assertRaises(RuntimeError):
            self.searcher.search("¿PRIVATE_FAILURE_SENTINEL?", stage="bm25")
        self.assertNotIn("PRIVATE_FAILURE_SENTINEL", json.dumps(self.searcher.__dict__, default=lambda _value: "opaque"))

    def test_corpus_is_read_only_and_sqlite_temporaries_stay_in_memory(self):
        with self.assertRaises(sqlite3.OperationalError):
            self.searcher.con.execute("CREATE TABLE messages(content TEXT)")
        self.assertEqual(self.searcher.con.execute("PRAGMA temp_store").fetchone()[0], 2)

    def test_completed_search_keeps_no_bound_query_in_live_sqlite_statements(self):
        marker = "PRIVATE_SQLITE_BOUND_QUERY_SENTINEL"
        self.searcher.search(marker, stage="bm25")
        api = ctypes.CDLL(_sqlite3.__file__)
        api.sqlite3_next_stmt.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        api.sqlite3_next_stmt.restype = ctypes.c_void_p
        api.sqlite3_expanded_sql.argtypes = [ctypes.c_void_p]
        api.sqlite3_expanded_sql.restype = ctypes.c_void_p
        api.sqlite3_free.argtypes = [ctypes.c_void_p]
        # Supported CPython 3.11/3.12 Connection starts with PyObject_HEAD, then sqlite3*.
        database = ctypes.c_void_p.from_address(id(self.searcher.con) + object.__basicsize__).value
        statement = api.sqlite3_next_stmt(database, None)
        while statement:
            text = api.sqlite3_expanded_sql(statement)
            try:
                self.assertNotIn(marker.lower(), ctypes.string_at(text).decode().lower())
            finally:
                api.sqlite3_free(text)
            statement = api.sqlite3_next_stmt(database, statement)


if __name__ == "__main__":
    unittest.main()
