import { providerModelsFromSettings } from "../providerSnapshot.ts";
import {
  MuseSettings,
  ProviderDriverKind,
  EventId,
  TurnId,
  RuntimeItemId,
  TextGenerationError,
  type ServerProvider,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { NativeCliConnection, NativeJsonlRun } from "../NativeCliConnection.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { ProviderAdapterRequestError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";

const DRIVER = ProviderDriverKind.make("muse");
const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const text = (value: unknown) => (typeof value === "string" ? value : "");
interface Session {
  session: ProviderSession;
  process?: NativeJsonlRun | undefined;
  busy: boolean;
  stopping: boolean;
  settled?: Promise<void>;
}
export type MuseDriverEnv = ServerConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto;

const decodeSettings = Schema.decodeSync(MuseSettings);

export const MuseDriver: ProviderDriver<MuseSettings, MuseDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "Muse", supportsMultipleInstances: true },
  configSchema: MuseSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const { cwd, stateDir, attachmentsDir } = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const clock = yield* Clock.Clock;
      const now = () => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
      const env = mergeProviderInstanceEnvironment(environment);
      const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const changes = yield* PubSub.unbounded<ServerProvider>();
      const sessions = new Map<ThreadId, Session>();
      let sequence = 0;
      const stamp = () => ({
        eventId: EventId.make(
          `muse-${instanceId}-${clock.currentTimeMillisUnsafe()}-${++sequence}`,
        ),
        createdAt: now(),
        provider: DRIVER,
        providerInstanceId: instanceId,
      });
      const emit = (event: ProviderRuntimeEvent) => {
        PubSub.publishUnsafe(events, event);
      };
      const error = (method: string, cause: unknown) =>
        new ProviderAdapterRequestError({
          provider: DRIVER,
          method,
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      const attempt = <A>(method: string, fn: (signal: AbortSignal) => Promise<A>) =>
        Effect.tryPromise({ try: fn, catch: (cause) => error(method, cause) });
      let snapshot: ServerProvider = {
        instanceId,
        driver: DRIVER,
        displayName: displayName ?? "Muse",
        ...(accentColor ? { accentColor } : {}),
        enabled,
        installed: false,
        version: null,
        status: enabled ? "warning" : "disabled",
        auth: { status: "unknown" },
        checkedAt: now(),
        models: [],
        slashCommands: [],
        skills: [],
        supportsTextGeneration: false,
        supportsConversationRollback: false,
        showInteractionModeToggle: true,
      };
      const refresh = Effect.gen(function* () {
        if (!enabled) return snapshot;
        const result = yield* attempt("model/list", async (signal) => {
          const connection = new NativeCliConnection({
            signal,
            command: config.binaryPath,
            args: ["serve", "--no-session-log"],
            cwd,
            env,
            onMessage: () => {},
          });
          try {
            const initialized = record(
              await connection.request("initialize", {
                clientInfo: { name: "t3_code", version: "0.0.42" },
              }),
            );
            connection.send({ method: "initialized" });
            const catalog = record(await connection.request("model/list", {}));
            return { initialized, catalog };
          } finally {
            await connection.close();
          }
        }).pipe(Effect.result);
        if (result._tag === "Success") {
          const { initialized, catalog } = result.success;
          const models = Array.isArray(catalog.models)
            ? catalog.models.map((model) => record(model))
            : [];
          snapshot = {
            ...snapshot,
            installed: true,
            status: "ready",
            version: text(record(initialized.serverInfo).version) || null,
            message:
              "Uses your Muse CLI login. Each turn reads T3's saved conversation; native session logs are disabled.",
            models: models.map((model) => ({
              slug: text(model.modelId),
              name: text(model.displayLabel) || text(model.modelId),
              isCustom: false,
              isDefault: model.isDefault === true,
              capabilities: Array.isArray(model.variants)
                ? {
                    optionDescriptors: [
                      {
                        id: "effort",
                        label: "Effort",
                        type: "select" as const,
                        options: model.variants
                          .filter((variant): variant is string => typeof variant === "string")
                          .map((variant) => ({ id: variant, label: variant })),
                      },
                    ],
                  }
                : null,
            })),
          };
        } else
          snapshot = {
            ...snapshot,
            installed: false,
            status: "error",
            message: result.failure.message,
          };
        snapshot = {
          ...snapshot,
          models: providerModelsFromSettings(snapshot.models, config.customModels, {}),
          checkedAt: now(),
        };
        PubSub.publishUnsafe(changes, snapshot);
        return snapshot;
      });
      const adapter: ProviderAdapterShape<ProviderAdapterError> = {
        provider: DRIVER,
        capabilities: {
          sessionModelSwitch: "in-session",
          supportsConversationRollback: false,
          requiresConversationHandoff: true,
        },
        startSession: (input) =>
          Effect.try({
            try: () => {
              const session: ProviderSession = {
                provider: DRIVER,
                providerInstanceId: instanceId,
                threadId: input.threadId,
                cwd: input.cwd ?? cwd,
                runtimeMode: input.runtimeMode,
                model: input.modelSelection?.model,
                status: "ready",
                createdAt: now(),
                updatedAt: now(),
                resumeCursor: { kind: "t3-transcript" },
              };
              if (sessions.has(input.threadId))
                throw error("start", "Muse session already exists.");
              sessions.set(input.threadId, { session, busy: false, stopping: false });
              emit({ ...stamp(), type: "session.started", threadId: input.threadId, payload: {} });
              emit({
                ...stamp(),
                type: "session.state.changed",
                threadId: input.threadId,
                payload: { state: "ready" },
              });
              return session;
            },
            catch: (cause) => error("start", cause),
          }),
        sendTurn: (input) =>
          Effect.gen(function* () {
            const context = sessions.get(input.threadId);
            if (!context || context.stopping)
              return yield* error("send", "Muse session is not running.");
            if (context.busy)
              return yield* error(
                "send",
                "Muse is busy. Queue this message or stop the current response first.",
              );
            if (context.session.runtimeMode !== "full-access" && input.interactionMode !== "plan")
              return yield* error(
                "send",
                "Muse's headless CLI cannot relay interactive approvals. Use Plan for analysis or explicitly select Full access for execution.",
              );
            context.busy = true;
            const launch = Effect.gen(function* () {
              const turnId = TurnId.make(
                yield* crypto.randomUUIDv4.pipe(Effect.mapError((cause) => error("uuid", cause))),
              );
              const handoffDir = path.join(stateDir, "provider-handoffs");
              const transcriptPath = path.join(
                handoffDir,
                `${encodeURIComponent(input.threadId)}.md`,
              );
              yield* fs.makeDirectory(handoffDir, { recursive: true, mode: 0o700 });
              const promptPath = `${transcriptPath}.tmp`;
              const attachments = (input.attachments ?? []).map((attachment) => ({
                attachment,
                path: resolveAttachmentPath({ attachmentsDir, attachment }),
              }));
              if (attachments.some((attachment) => !attachment.path))
                return yield* error("attachment", "An attachment is unavailable.");
              const prompt = [
                buildRuntimeInstructions({ harness: "Muse", model: input.modelSelection?.model }),
                ...(input.interactionMode === "plan"
                  ? ["This is read-only planning. Do not execute changes."]
                  : []),
                input.input ?? "",
                ...attachments
                  .filter((item) => item.attachment.type !== "image")
                  .map((item) => `Attached file ${item.attachment.name}: ${item.path}`),
              ].join("\n\n");
              yield* fs.writeFileString(promptPath, prompt, { mode: 0o600 });
              const args = [
                "exec",
                "--json",
                "--no-session-log",
                "--prompt-file",
                promptPath,
                "--user-input-auto-resolve",
              ];
              if (input.interactionMode === "plan") args.push("--disable-write", "--disable-shell");
              else args.push("--yolo");
              const model = input.modelSelection?.model ?? context.session.model;
              if (model) args.push("--model", model);
              const effort = input.modelSelection?.options?.find(
                (option) => option.id === "effort",
              )?.value;
              if (typeof effort === "string") args.push("--reasoning-effort", effort);
              for (const attachment of attachments)
                if (attachment.attachment.type === "image" && attachment.path)
                  args.push("--image", attachment.path);
              let finalText = "";
              let terminal: "completed" | "failed" | undefined;
              let detail: string | undefined;
              context.session = {
                ...context.session,
                status: "running",
                activeTurnId: turnId,
                model,
              };
              emit({
                ...stamp(),
                type: "turn.started",
                threadId: input.threadId,
                turnId,
                payload: {},
              });
              emit({
                ...stamp(),
                type: "item.started",
                threadId: input.threadId,
                turnId,
                itemId: RuntimeItemId.make(turnId),
                payload: { itemType: "assistant_message" },
              });
              const process = new NativeJsonlRun({
                command: config.binaryPath,
                args,
                cwd: context.session.cwd ?? cwd,
                env,
                onRecord: (value) => {
                  const event = record(value);
                  const payload = record(event.payload);
                  if (text(event.payload_type).startsWith("run.terminal.")) {
                    terminal = payload.terminal === "completed" ? "completed" : "failed";
                    finalText = text(payload.text);
                    detail = text(payload.reason) || undefined;
                  }
                },
              });
              context.process = process;
              const completion = Promise.withResolvers<void>();
              context.settled = completion.promise;
              const settle = attempt("exec", () => process.completed).pipe(
                Effect.matchEffect({
                  onFailure: (cause) =>
                    Effect.sync(() => {
                      terminal = "failed";
                      detail = cause.message;
                    }),
                  onSuccess: (code) =>
                    Effect.sync(() => {
                      if (code !== 0 || !terminal) {
                        terminal = "failed";
                        detail ??= `Muse exited without a completed result (${code}).`;
                      }
                    }),
                }),
                Effect.andThen(
                  Effect.sync(() => {
                    if (finalText)
                      emit({
                        ...stamp(),
                        type: "content.delta",
                        threadId: input.threadId,
                        turnId,
                        itemId: RuntimeItemId.make(turnId),
                        payload: { streamKind: "assistant_text", delta: finalText },
                      });
                    emit({
                      ...stamp(),
                      type: "item.completed",
                      threadId: input.threadId,
                      turnId,
                      itemId: RuntimeItemId.make(turnId),
                      payload: { itemType: "assistant_message" },
                    });
                    emit({
                      ...stamp(),
                      type: "turn.completed",
                      threadId: input.threadId,
                      turnId,
                      payload: {
                        state: context.stopping ? "interrupted" : (terminal ?? "failed"),
                        ...(detail ? { errorMessage: detail } : {}),
                      },
                    });
                    context.busy = false;
                    context.process = undefined;
                    context.session = {
                      ...context.session,
                      activeTurnId: undefined,
                      status: terminal === "completed" ? "ready" : "error",
                      updatedAt: now(),
                    };
                  }),
                ),
                Effect.ensuring(
                  fs
                    .remove(promptPath)
                    .pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => completion.resolve()))),
                ),
              );
              yield* settle.pipe(Effect.forkIn(scope));
              return {
                threadId: input.threadId,
                turnId,
                resumeCursor: context.session.resumeCursor,
              };
            }).pipe(
              Effect.mapError((cause) => error("send", cause)),
              Effect.tapError(() =>
                Effect.sync(() => {
                  context.busy = false;
                }),
              ),
            );
            return yield* launch;
          }),
        interruptTurn: (threadId) =>
          attempt("interrupt", async () => {
            const context = sessions.get(threadId);
            if (context?.process) {
              context.stopping = true;
              await context.process.close();
              await context.settled;
              context.stopping = false;
            }
          }),
        stopSession: (threadId) =>
          attempt("stop", async () => {
            const context = sessions.get(threadId);
            if (!context) return;
            context.stopping = true;
            await context.process?.close();
            await context.settled;
            sessions.delete(threadId);
          }),
        stopAll: () =>
          Effect.forEach([...sessions.keys()], (threadId) => adapter.stopSession(threadId), {
            discard: true,
          }),
        listSessions: () =>
          Effect.sync(() => [...sessions.values()].map((context) => context.session)),
        hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
        readThread: () => Effect.fail(error("read", "Muse history is saved in T3.")),
        rollbackThread: () =>
          Effect.fail(error("rollback", "Muse does not support native rollback.")),
        respondToRequest: () =>
          Effect.fail(
            error("approval", "Interactive approval is unavailable in Muse headless mode."),
          ),
        respondToUserInput: () =>
          Effect.fail(error("question", "Reply in the conversation to continue Muse.")),
        streamEvents: Stream.fromPubSub(events),
      };
      const scope = yield* Effect.scope;
      yield* refresh;
      yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));
      const unsupported = (operation: string) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Choose another provider for background text generation.",
          }),
        );
      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity: defaultProviderContinuationIdentity({
          driverKind: DRIVER,
          instanceId,
        }),
        displayName,
        accentColor,
        enabled,
        adapter,
        snapshot: {
          getSnapshot: Effect.sync(() => snapshot),
          refresh,
          streamChanges: Stream.fromPubSub(changes),
          applyUsageLimits: () => Effect.void,
          resolveMaintenance: () =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: DRIVER,
                packageName: null,
              }),
            ),
        },
        textGeneration: {
          generateCommitMessage: () => unsupported("generateCommitMessage"),
          generatePrContent: () => unsupported("generatePrContent"),
          generateBranchName: () => unsupported("generateBranchName"),
          generateThreadTitle: () => unsupported("generateThreadTitle"),
        },
      };
    }),
};
