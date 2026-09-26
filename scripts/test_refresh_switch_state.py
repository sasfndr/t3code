import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("refresh", Path(__file__).with_name("refresh-switch-state.py"))
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)


class RefreshTest(unittest.TestCase):
    def seed(self, path, stock):
        path.mkdir()
        with sqlite3.connect(path / "state.sqlite") as db:
            db.executescript("""
                CREATE TABLE effect_sql_migrations(migration_id INTEGER, name TEXT);
                INSERT INTO effect_sql_migrations VALUES(1,'Initial');
                CREATE TABLE orchestration_events(event_id TEXT, stream_id TEXT, event_type TEXT);
                INSERT INTO orchestration_events VALUES('shared','thread','thread.created');
                CREATE TABLE projection_threads(thread_id TEXT, deleted_at TEXT);
                INSERT INTO projection_threads VALUES('thread',NULL);
                CREATE TABLE projection_projects(project_id TEXT, deleted_at TEXT);
                CREATE TABLE projection_thread_messages(message_id TEXT, text TEXT);
                INSERT INTO projection_thread_messages VALUES('old','Original message');
                CREATE TABLE provider_session_runtime(runtime_payload_json TEXT);
                INSERT INTO provider_session_runtime VALUES('{"continueAfterServerUpdate":"turn","retained":true}');
                CREATE TABLE auth_sessions(id TEXT); CREATE TABLE auth_pairing_links(id TEXT);
            """)
            db.execute("INSERT INTO auth_sessions VALUES(?)", ("stock-auth" if stock else "switch-auth",))
            if stock:
                db.execute("INSERT INTO projection_thread_messages VALUES('new','Latest message')")
            else:
                db.execute("INSERT INTO effect_sql_migrations VALUES(2,'ForkMigration')")
        (path / "settings.json").write_text(json.dumps({"agentRouting": {"mode": "manual" if stock else "auto"}, "providerInstances": {"claude2" if stock else "kimi": {"enabled": True}}}))
        (path / "secrets").mkdir()
        (path / "secrets/server-signing-key").write_bytes(b"stock-key" if stock else b"switch-key")
        if stock:
            (path / "secrets/provider-auth-test").write_bytes(b"fixture-provider-auth")
            (path / "attachments").mkdir()
            (path / "attachments/image.png").write_bytes(b"fixture-attachment")

    def test_refresh_preserves_auth_routing_and_backups_with_latest_messages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root / "source"; target = root / "target"
            self.seed(source, True); self.seed(target, False)
            before = (source / "state.sqlite").read_bytes()
            backup = refresh.refresh(source, target, root / "backups")
            self.assertEqual((source / "state.sqlite").read_bytes(), before)
            with sqlite3.connect(target / "state.sqlite") as db:
                self.assertEqual(db.execute("SELECT id FROM auth_sessions").fetchall(), [("switch-auth",)])
                self.assertEqual(db.execute("SELECT count(*) FROM projection_thread_messages").fetchone()[0], 2)
                self.assertEqual(json.loads(db.execute("SELECT runtime_payload_json FROM provider_session_runtime").fetchone()[0]), {"retained": True})
            with sqlite3.connect(backup / "switch-userdata/state.sqlite") as db:
                self.assertEqual(db.execute("SELECT count(*) FROM projection_thread_messages").fetchone()[0], 1)
            settings = json.loads((target / "settings.json").read_text())
            self.assertEqual(settings["agentRouting"]["mode"], "auto")
            self.assertEqual(set(settings["providerInstances"]), {"kimi", "claude2"})
            self.assertEqual((target / "secrets/server-signing-key").read_bytes(), b"switch-key")
            self.assertTrue((target / "secrets/provider-auth-test").exists())
            self.assertEqual((target / "attachments/image.png").read_bytes(), b"fixture-attachment")

    def test_divergent_work_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root / "source"; target = root / "target"
            self.seed(source, True); self.seed(target, False)
            with sqlite3.connect(target / "state.sqlite") as db:
                db.execute("INSERT INTO orchestration_events VALUES('independent','thread','thread.message-sent')")
            before = (target / "state.sqlite").read_bytes()
            with self.assertRaisesRegex(RuntimeError, "independent work"):
                refresh.refresh(source, target, root / "backups")
            self.assertEqual((target / "state.sqlite").read_bytes(), before)

    def test_running_destination_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            (target / "server-runtime.json").write_text(json.dumps({"pid": os.getpid()}))
            with self.assertRaisesRegex(RuntimeError, "Quit Switch"):
                refresh.assert_stopped(target)

    def test_wal_snapshot_includes_committed_rows_without_sidecars(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "live.sqlite"
            writer = sqlite3.connect(path)
            try:
                writer.execute("PRAGMA journal_mode=WAL")
                writer.execute("CREATE TABLE messages(text TEXT)")
                writer.execute("INSERT INTO messages VALUES('committed in WAL')")
                writer.commit()
                snapshot = Path(tmp) / "snapshot.sqlite"
                refresh.snapshot(path, snapshot)
                with refresh.readonly(snapshot, offline=True) as db:
                    self.assertEqual(db.execute("SELECT text FROM messages").fetchone()[0], "committed in WAL")
                self.assertFalse(Path(str(snapshot) + "-wal").exists())
                with self.assertRaisesRegex(RuntimeError, "uncheckpointed WAL"):
                    refresh.readonly(path, offline=True)
            finally:
                writer.close()

    def test_newer_stock_schema_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root / "source"; target = root / "target"
            self.seed(source, True); self.seed(target, False)
            with sqlite3.connect(source / "state.sqlite") as db:
                db.execute("INSERT INTO effect_sql_migrations VALUES(2,'UnknownUpstreamMigration')")
            with self.assertRaisesRegex(RuntimeError, "newer or divergent"):
                refresh.refresh(source, target, root / "backups")


if __name__ == "__main__":
    unittest.main()
