"""Authentication isolation for an offline T3 Code Switch database."""
from pathlib import Path
import json
import os
import sqlite3

PROVIDER_SECRET_PREFIXES = ("provider-env-", "provider-auth-", "usage-limit-source-")


def clear_app_auth(connection):
    # Provider-native sessions and provider settings are deliberately retained.
    for table in ("auth_sessions", "auth_pairing_links"):
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
            connection.execute(f'DELETE FROM "{table}"')


def isolate_existing(target):
    target = Path(target).resolve()
    if target != (Path.home() / ".t3-switch" / "userdata").resolve():
        raise SystemExit("Only the separate Switch data directory may be migrated.")
    if not (target / "state.sqlite").is_file():
        raise SystemExit("No existing Switch database found.")
    runtime = target / "server-runtime.json"
    if runtime.exists():
        pid = json.loads(runtime.read_text()).get("pid")
        if pid:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise SystemExit("Quit T3 Code Switch before isolating its authentication.")
    marker = target / "switch-auth-isolated-v1"
    if marker.exists():
        print("Switch authentication is already isolated.")
        return
    with sqlite3.connect(target / "state.sqlite") as db:
        clear_app_auth(db)
    secret_dir = target / "secrets"
    if secret_dir.exists():
        for secret in secret_dir.iterdir():
            if secret.is_file() and not secret.name.startswith(PROVIDER_SECRET_PREFIXES):
                secret.unlink()
    # App identity and remote links must be minted independently. CLI logins
    # live outside this directory and are never read or changed here.
    for name in ("environment-id", "desktop-settings.json"):
        (target / name).unlink(missing_ok=True)
    marker.write_text("App authentication isolated; provider credentials preserved.\n")
    marker.chmod(0o600)
    print("Switch app authentication isolated. Provider logins and conversations preserved.")


if __name__ == "__main__":
    isolate_existing(Path.home() / ".t3-switch" / "userdata")
