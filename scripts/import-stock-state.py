#!/usr/bin/env python3
"""One-time, offline import into the personal Switch build; never writes stock state."""
import json
from pathlib import Path
import shutil
import sqlite3

source = Path.home() / ".t3" / "userdata"
target = Path.home() / ".t3-switch" / "userdata"
destination = target / "state.sqlite"
staging = target / "state.sqlite.importing"
if destination.exists():
    raise SystemExit("Switch already has a database. Import skipped to preserve its work.")
if not (source / "state.sqlite").exists():
    raise SystemExit("No stock T3 Code database found.")
target.mkdir(parents=True, exist_ok=True, mode=0o700)
with sqlite3.connect((source / "state.sqlite").as_uri() + "?mode=ro", uri=True) as original:
    with sqlite3.connect(staging) as copied:
        original.backup(copied)
        # The source may have running agents. Clear only the copy's automatic
        # restart markers; T3 reconciles orphaned turns through its normal events.
        copied.execute("""UPDATE provider_session_runtime
            SET runtime_payload_json = json_remove(runtime_payload_json,
                '$.continueAfterServerUpdate', '$.continueAfterServerUpdatePrepared')
            WHERE json_valid(runtime_payload_json)""")
        assert copied.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        thread_count = copied.execute("SELECT count(*) FROM projection_threads").fetchone()[0]
for name in ("attachments", "secrets", "themes", "snap-shots"):
    if (source / name).exists():
        shutil.copytree(source / name, target / name, dirs_exist_ok=True)
for name in ("settings.json", "client-settings.json", "keybindings.json", "model-manifest.json"):
    if (source / name).exists():
        shutil.copy2(source / name, target / name)
settings_path = target / "settings.json"
settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
settings["continueThreadsAfterServerUpdate"] = False
for override in settings.get("projectSettingsOverrides", {}).values():
    override["continueThreadsAfterServerUpdate"] = False
settings_path.write_text(json.dumps(settings, indent=2) + "\n")
settings_path.chmod(0o600)
staging.chmod(0o600)
staging.replace(destination)
print(f"Imported {thread_count} conversations into T3 Code Switch. Stock state was read-only.")
