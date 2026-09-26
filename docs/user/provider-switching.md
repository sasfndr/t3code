# Continue with another provider

When you reach a provider's limit, open the model picker under your message,
choose another provider and model, and send your next message. If a response is
still running, stop it first. The new provider must be installed and signed in.

The conversation stays in the same thread and workspace. T3 starts a fresh
session with the selected provider and carries over recent messages. Long
conversations remain available to the agent in a local transcript, including
saved plans and paths to earlier attachments. Provider-private reasoning and
native tool state cannot move between providers. No request to the old provider
is needed. Choosing your previous provider later carries the updated conversation
back into a fresh session there.

Selecting a model prepares the next message; it does not send a request by itself.
If the replacement fails to start, the old session and its tool access remain usable.
If sending fails, the next attempt retains the handoff context. A switch reports
an error if the previous provider cannot be stopped. Switching accounts with incompatible native session
storage within one provider remains unsupported.

Each conversation keeps one private handoff transcript, updated on a switch.
Deleting the conversation removes it; startup cleans abandoned files and collapses
snapshots left by earlier Switch builds. CLI-native histories remain with their
providers because other apps may use them.

For automatic routing, model locks, and Kimi/Muse setup, see [Orchestrator](orchestrator.md).

## Personal desktop build

The macOS fork is named **T3 Code Switch**, uses `~/.t3-switch` for its own data,
and does not install stock T3 updates over the custom feature. It keeps the
standard T3 interface. Use Switch as your everyday app after migration.

For a one-time import, run `python3 scripts/import-stock-state.py` before opening
Switch. It copies stock conversations and attachments using SQLite's consistent
backup API, leaves stock state untouched, imports only provider credentials (not
app login or remote-link credentials), and disables automatic resumption of
copied running turns. It refuses to overwrite an existing Switch database.
Conversations created afterward in the two apps are separate. Avoid running the
same imported thread in both apps at once because both point to the same project
files and native provider history.

If Switch only contains the earlier import, quit it and run
`python3 scripts/refresh-switch-state.py` to bring across newer stock conversations
and provider accounts while retaining Switch's routing and independent app login.
The refresh refuses to overwrite independent Switch work. It keeps private rollback
backups under `~/.t3-switch/migration-backups` and leaves stock data untouched.
Previously running responses do not automatically restart; send a follow-up to continue.

For installations originally imported by Switch 0.0.42-switch.1, quit Switch
and run `python3 scripts/switch_state.py` once before reopening. This separates
app authentication, clears copied browser/mobile pairings and remote links, and
keeps conversations and provider logins. Remote clients need to pair with Switch
again. Subsequent imports already have this isolation.

To rebuild on an Apple Silicon Mac with the repository's development prerequisites:

```sh
vp i
vp env exec --node 24.13.1 node scripts/build-desktop-artifact.ts \
  --platform mac --target zip --arch arm64 \
  --build-version 0.0.42-switch.5 --output-dir ./release-switch
```

The archive contains the app. Local builds are not notarized by Apple. Keep
future upstream updates in the fork so they can be checked alongside this feature.

## Updates

Switch deliberately disables the stock desktop updater. Upstream releases will
not arrive automatically in this installation, and downloading stock T3 again
will not include these custom features. Your fork also does not currently have
an automatic release service.

When you want an update, ask your coding agent: “Update my T3 Code Switch fork
from upstream, preserve provider switching and orchestration, test the changes,
back up my data, and install the rebuilt app.” This is a maintenance task:
upstream changes can conflict with the fork and need integration and verification.
Keep using the current app until the replacement is checked. Replacing the app
must retain `~/.t3-switch`; do not reimport stock state during ordinary updates.
CLI providers update independently of the desktop app, so adapter compatibility
also needs checking when their protocols change.
