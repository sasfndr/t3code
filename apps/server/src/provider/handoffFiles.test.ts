import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { deleteHandoffFile, reconcileHandoffFiles } from "./handoffFiles.ts";

const epoch = DateTime.toDateUtc(DateTime.makeUnsafe(0));

it.effect(
  "retains one latest transcript per live or archived thread and removes orphan/temporary files",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const root = path.join(dir, "provider-handoffs");
      yield* fs.makeDirectory(root);
      for (const name of [
        "active-old.md",
        "active-new.md",
        "archived.md",
        "deleted.md",
        "active.md.tmp",
        "leave-alone.txt",
      ]) {
        yield* fs.writeFileString(path.join(root, name), name);
      }
      yield* fs.utimes(path.join(root, "active-old.md"), epoch, epoch);
      yield* reconcileHandoffFiles(dir, ["active", "archived"]);
      assert.deepEqual((yield* fs.readDirectory(root)).sort(), [
        "active.md",
        "archived.md",
        "leave-alone.txt",
      ]);
      assert.equal(yield* fs.readFileString(path.join(root, "active.md")), "active-new.md");
      assert.equal((yield* fs.stat(root)).mode & 0o777, 0o700);
      assert.equal((yield* fs.stat(path.join(root, "active.md"))).mode & 0o777, 0o600);
      yield* deleteHandoffFile(dir, "active");
      assert.deepEqual((yield* fs.readDirectory(root)).sort(), ["archived.md", "leave-alone.txt"]);
      yield* reconcileHandoffFiles(dir, ["archived"]);
      assert.equal(yield* fs.exists(path.join(root, "archived.md")), true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
