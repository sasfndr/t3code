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

## Personal desktop build

The macOS fork is named **T3 Code Switch**, uses `~/.t3-switch` for its own data,
and does not install stock T3 updates over the custom feature. It keeps the
standard T3 interface. The stock app remains separately installed.

For a one-time import, run `python3 scripts/import-stock-state.py` before opening
Switch. It copies stock conversations and attachments using SQLite's consistent
backup API, leaves stock state untouched, imports only provider credentials (not
app login or remote-link credentials), and disables automatic resumption of
copied running turns. It refuses to overwrite an existing Switch database.
Conversations created afterward in the two apps are separate. Avoid running the
same imported thread in both apps at once because both point to the same project
files and native provider history.

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
  --build-version 0.0.42-switch.3 --output-dir ./release-switch
```

The archive contains the app. Local builds are not notarized by Apple. Keep
future upstream updates in the fork so they can be checked alongside this feature.
