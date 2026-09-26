#!/usr/bin/env python3
"""Offline refresh from stock, refusing to discard independent Switch work.

This is a migration, not ongoing synchronization. Private backups retain the
previous installation, including deleted conversations. Never writes stock.
"""
import datetime
import json
import os
from pathlib import Path
import shutil
import sqlite3

from switch_state import PROVIDER_SECRET_PREFIXES, clear_app_auth


def readonly(path, *, offline=False):
    # SQLite on macOS cannot always create missing WAL sidecars read-only.
    # Immutable is safe only for verified stopped, checkpointed databases.
    if offline and Path(str(path) + "-wal").exists() and Path(str(path) + "-wal").stat().st_size:
        raise RuntimeError("Offline database has an uncheckpointed WAL; recover it before migration.")
    return sqlite3.connect(path.resolve().as_uri() + ("?mode=ro&immutable=1" if offline else "?mode=ro"), uri=True)


def assert_stopped(target):
    runtime = target / "server-runtime.json"
    if runtime.exists():
        pid = json.loads(runtime.read_text()).get("pid")
        if pid:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            raise RuntimeError("Quit Switch before refreshing its conversations.")


def check_divergence(source, current):
    known = {r[0] for r in source.execute("SELECT event_id FROM orchestration_events")}
    live = {r[0] for r in current.execute(
        "SELECT thread_id FROM projection_threads WHERE deleted_at IS NULL"
    )}
    live.update(r[0] for r in current.execute(
        "SELECT project_id FROM projection_projects WHERE deleted_at IS NULL"
    ))
    for event_id, stream_id, event_type in current.execute(
        "SELECT event_id, stream_id, event_type FROM orchestration_events"
    ):
        # Startup reconciles orphaned provider bindings without changing content.
        if stream_id in live and event_id not in known and event_type != "thread.session-set":
            raise RuntimeError("Switch has independent work. Refresh refused; merge it explicitly.")


def snapshot(source, destination, *, offline=False):
    original = readonly(source, offline=offline)
    copied = sqlite3.connect(destination)
    try:
        original.backup(copied)
        # A standalone backup must not need the source's WAL sidecars.
        copied.execute("PRAGMA journal_mode=DELETE")
    finally:
        copied.close()
        original.close()
    destination.chmod(0o600)


def refresh(source, target, backups):
    if source.resolve() == target.resolve():
        raise RuntimeError("Source and destination must be separate.")
    assert_stopped(target)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = backups / stamp
    backup.mkdir(parents=True, mode=0o700)
    backup.chmod(0o700)
    stock_snapshot = backup / "stock-state.sqlite"
    snapshot(source / "state.sqlite", stock_snapshot)
    with readonly(stock_snapshot, offline=True) as original, readonly(target / "state.sqlite", offline=True) as current:
        check_divergence(original, current)
        if original.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("Stock snapshot failed integrity check.")
        migrations = "SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id"
        source_migrations = original.execute(migrations).fetchall()
        current_migrations = current.execute(migrations).fetchall()
        # The installed fork applies its newer migrations normally on launch.
        if current_migrations[:len(source_migrations)] != source_migrations:
            raise RuntimeError("Stock schema is newer or divergent. Upgrade compatibility needs review.")
        for table in ("auth_sessions", "auth_pairing_links"):
            if original.execute(f'PRAGMA table_info("{table}")').fetchall() != current.execute(
                f'PRAGMA table_info("{table}")'
            ).fetchall():
                raise RuntimeError("App authentication schemas differ; refresh refused.")
    # Keep a consistent rollback copy, not a live copy of SQLite's WAL files.
    previous = backup / "switch-userdata"
    shutil.copytree(target, previous, ignore=shutil.ignore_patterns("state.sqlite*"))
    snapshot(target / "state.sqlite", previous / "state.sqlite", offline=True)
    staging = target / "state.sqlite.refreshing"
    if staging.exists():
        raise RuntimeError("An earlier refresh is unfinished; inspect its staging file.")
    snapshot(stock_snapshot, staging, offline=True)
    with sqlite3.connect(staging) as copied, readonly(previous / "state.sqlite", offline=True) as old:
        clear_app_auth(copied)
        # Preserve only Switch's own app pairings; never bring stock browser auth.
        for table in ("auth_sessions", "auth_pairing_links"):
            for row in old.execute(f'SELECT * FROM "{table}"'):
                copied.execute(f'INSERT INTO "{table}" VALUES ({",".join("?" for _ in row)})', row)
        copied.execute("""UPDATE provider_session_runtime SET runtime_payload_json =
            json_remove(runtime_payload_json, '$.continueAfterServerUpdate',
                '$.continueAfterServerUpdatePrepared') WHERE json_valid(runtime_payload_json)""")
        if copied.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("Refreshed database failed integrity check.")
        count = copied.execute("SELECT count(*) FROM projection_threads WHERE deleted_at IS NULL").fetchone()[0]
    settings = json.loads((target / "settings.json").read_text())
    stock_settings = json.loads((source / "settings.json").read_text())
    for key in ("providers", "providerInstances"):
        settings[key] = {**settings.get(key, {}), **stock_settings.get(key, {})}
    settings["continueThreadsAfterServerUpdate"] = False
    for override in settings.get("projectSettingsOverrides", {}).values():
        override["continueThreadsAfterServerUpdate"] = False
    for name in ("attachments", "themes", "snap-shots"):
        if (source / name).exists():
            shutil.copytree(source / name, target / name, dirs_exist_ok=True)
    (target / "secrets").mkdir(exist_ok=True, mode=0o700)
    if (source / "secrets").exists():
        for secret in (source / "secrets").iterdir():
            if secret.is_file() and secret.name.startswith(PROVIDER_SECRET_PREFIXES):
                shutil.copy2(secret, target / "secrets" / secret.name)
                (target / "secrets" / secret.name).chmod(0o600)
    assert_stopped(target)
    settings_staging = target / "settings.json.refreshing"
    settings_staging.write_text(json.dumps(settings, indent=2) + "\n")
    settings_staging.chmod(0o600)
    # These sidecars belong to the retired database, already safely backed up.
    for suffix in ("-wal", "-shm"):
        (target / ("state.sqlite" + suffix)).unlink(missing_ok=True)
    staging.replace(target / "state.sqlite")
    settings_staging.replace(target / "settings.json")
    print(f"Refreshed {count} conversations. Private rollback backup: {backup}")
    return backup


if __name__ == "__main__":
    home = Path.home()
    refresh(home / ".t3/userdata", home / ".t3-switch/userdata", home / ".t3-switch/migration-backups")
