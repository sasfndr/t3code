import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** This directory contains only T3-owned handoffs, never CLI-native history. */
export const reconcileHandoffFiles = Effect.fn("reconcileHandoffFiles")(function* (
  stateDir: string,
  retainedThreadIds: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(stateDir, "provider-handoffs");
  yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
  yield* fs.chmod(root, 0o700);
  const entries = yield* fs.readDirectory(root);
  const retained = new Set<string>();
  const claimed = new Set<string>();
  // Older builds wrote one snapshot per switch. Collapse them to the newest
  // snapshot for each retained thread; archived conversations still count.
  for (const id of [...retainedThreadIds].sort((a, b) => b.length - a.length)) {
    const encoded = encodeURIComponent(id);
    const canonical = `${encoded}.md`;
    const candidates = entries.filter(
      (name) =>
        !claimed.has(name) &&
        (name === canonical || (name.startsWith(`${encoded}-`) && name.endsWith(".md"))),
    );
    for (const name of candidates) claimed.add(name);
    const files = [];
    for (const name of candidates) {
      const info = yield* fs.stat(path.join(root, name));
      if (info.type === "File")
        files.push({ name, time: Option.getOrUndefined(info.mtime)?.getTime() ?? 0 });
    }
    const newest = files.sort((a, b) => b.time - a.time)[0];
    if (newest) {
      if (newest.name !== canonical)
        yield* fs.rename(path.join(root, newest.name), path.join(root, canonical));
      yield* fs.chmod(path.join(root, canonical), 0o600);
      retained.add(canonical);
    }
  }
  for (const name of entries) {
    if (!retained.has(name) && (name.endsWith(".md") || name.endsWith(".md.tmp"))) {
      yield* fs.remove(path.join(root, name), { force: true });
    }
  }
});

export const deleteHandoffFile = Effect.fn("deleteHandoffFile")(function* (
  stateDir: string,
  threadId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(stateDir, "provider-handoffs");
  if (!(yield* fs.exists(root))) return;
  const prefix = encodeURIComponent(threadId);
  for (const name of yield* fs.readDirectory(root)) {
    if (name === `${prefix}.md` || name === `${prefix}.md.tmp`) {
      yield* fs.remove(path.join(root, name), { force: true });
    }
  }
});
