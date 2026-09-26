from pathlib import Path
import os
import sqlite3
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).parent


class SwitchImportTest(unittest.TestCase):
    def test_import_preserves_conversation_and_provider_secret_but_not_app_auth(self):
        with tempfile.TemporaryDirectory() as home:
            source = Path(home) / ".t3/userdata"
            source.mkdir(parents=True)
            with sqlite3.connect(source / "state.sqlite") as db:
                db.executescript("""
                CREATE TABLE provider_session_runtime(runtime_payload_json TEXT);
                INSERT INTO provider_session_runtime VALUES ('{"continueAfterServerUpdate":"turn"}');
                CREATE TABLE projection_threads(id TEXT); INSERT INTO projection_threads VALUES ('retained');
                CREATE TABLE auth_sessions(id TEXT); INSERT INTO auth_sessions VALUES ('stock-session');
                CREATE TABLE auth_pairing_links(id TEXT); INSERT INTO auth_pairing_links VALUES ('stock-pair');
                """)
            (source / "secrets").mkdir()
            for name in ["server-signing-key", "cloud-relay-environment-credential", "provider-auth-example"]:
                (source / "secrets" / f"{name}.bin").write_bytes(b"test-fixture-only")
            env = {**os.environ, "HOME": home}
            subprocess.run(["python3", str(ROOT / "import-stock-state.py")], env=env, check=True, capture_output=True)
            target = Path(home) / ".t3-switch/userdata"
            with sqlite3.connect(target / "state.sqlite") as db:
                self.assertEqual(db.execute("SELECT count(*) FROM projection_threads").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT count(*) FROM auth_sessions").fetchone()[0], 0)
                self.assertEqual(db.execute("SELECT count(*) FROM auth_pairing_links").fetchone()[0], 0)
                self.assertEqual(db.execute("SELECT runtime_payload_json FROM provider_session_runtime").fetchone()[0], "{}")
            self.assertEqual([f.name for f in (target / "secrets").iterdir()], ["provider-auth-example.bin"])
            with sqlite3.connect(source / "state.sqlite") as db:
                self.assertEqual(db.execute("SELECT count(*) FROM auth_sessions").fetchone()[0], 1)
            second = subprocess.run(["python3", str(ROOT / "import-stock-state.py")], env=env, capture_output=True)
            self.assertNotEqual(second.returncode, 0)
            # Upgrade an earlier unsafe import once, retaining new logins on later runs.
            (target / "switch-auth-isolated-v1").unlink()
            (target / "secrets/server-signing-key.bin").write_bytes(b"old-key")
            subprocess.run(["python3", str(ROOT / "switch_state.py")], env=env, check=True, capture_output=True)
            self.assertFalse((target / "secrets/server-signing-key.bin").exists())
            self.assertTrue((target / "secrets/provider-auth-example.bin").exists())
            (target / "secrets/server-signing-key.bin").write_bytes(b"new-key")
            subprocess.run(["python3", str(ROOT / "switch_state.py")], env=env, check=True, capture_output=True)
            self.assertEqual((target / "secrets/server-signing-key.bin").read_bytes(), b"new-key")


if __name__ == "__main__":
    unittest.main()
