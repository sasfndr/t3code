import { providerModelsFromSettings } from "../providerSnapshot.ts";
import {
  KimiSettings,
  ProviderDriverKind,
  EventId,
  TurnId,
  RuntimeItemId,
  RuntimeRequestId,
  TextGenerationError,
  type ServerProvider,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  type ApprovalRequestId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  NativeCliConnection,
  readNativeCliJson,
  type NativeRpcMessage,
} from "../NativeCliConnection.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { ProviderAdapterRequestError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  readMcpProviderSession,
  withAgentDeviceEnvironment,
} from "../../mcp/McpProviderSession.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";

const DRIVER = ProviderDriverKind.make("kimi");
const decodeRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const record = (value: unknown): Record<string, unknown> => decodeRecord(value ?? {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(record) : [];
const INITIALIZE = {
  protocolVersion: 1,
  clientCapabilities: {},
  clientInfo: { name: "t3-code", version: "0.0.42" },
};

interface Session {
  connection: NativeCliConnection;
  session: ProviderSession;
  nativeId: string;
  effortConfigId: string | undefined;
  activeTurn?: TurnId | undefined;
  itemId?: string;
  stopped: boolean;
  approvals: Map<
    ApprovalRequestId,
    {
      rpcId: string | number;
      requestType: "file_change_approval" | "exec_command_approval";
      options: Record<string, unknown>[];
    }
  >;
}

const decodeSettings = Schema.decodeSync(KimiSettings);

export const KimiDriver: ProviderDriver<
  KimiSettings,
  ServerConfig | FileSystem.FileSystem | Crypto.Crypto
> = {
  driverKind: DRIVER,
  metadata: { displayName: "Kimi Code", supportsMultipleInstances: true },
  configSchema: KimiSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const { cwd, attachmentsDir } = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const clock = yield* Clock.Clock;
      const nowIso = () => DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
      const env = mergeProviderInstanceEnvironment(environment);
      const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const changes = yield* PubSub.unbounded<ServerProvider>();
      const sessions = new Map<ThreadId, Session>();
      const pendingStarts = new Set<ThreadId>();
      let sequence = 0;
      const eventId = () =>
        EventId.make(`kimi-${instanceId}-${clock.currentTimeMillisUnsafe()}-${++sequence}`);
      const stamp = () => ({
        eventId: eventId(),
        createdAt: nowIso(),
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
        displayName: displayName ?? "Kimi Code",
        ...(accentColor ? { accentColor } : {}),
        enabled,
        installed: false,
        version: null,
        status: enabled ? "warning" : "disabled",
        auth: { status: "unknown" },
        checkedAt: nowIso(),
        models: [],
        slashCommands: [],
        skills: [],
        supportsTextGeneration: false,
        supportsConversationRollback: false,
        showInteractionModeToggle: true,
      };
      const learnModels = (setup: Record<string, unknown>) => {
        const options = records(setup.configOptions);
        const models = options.find((option) => option.category === "model");
        const effort = options.find((option) => option.category === "thought_level");
        if (!models) return;
        snapshot = {
          ...snapshot,
          installed: true,
          status: "ready",
          auth: snapshot.auth,
          models: records(models.options).map((model) => ({
            slug: text(model.value),
            name: text(model.name) || text(model.value),
            isCustom: false,
            isDefault: model.value === models.currentValue,
            ...(model.value === models.currentValue ? { aliases: ["kimi-default"] } : {}),
            capabilities: effort
              ? {
                  optionDescriptors: [
                    {
                      id: text(effort.id),
                      label: text(effort.name) || "Thinking",
                      type: "select" as const,
                      options: records(effort.options).map((option) => ({
                        id: text(option.value),
                        label: text(option.name) || text(option.value),
                      })),
                      currentValue: text(effort.currentValue),
                    },
                  ],
                }
              : null,
          })),
        };
        snapshot = {
          ...snapshot,
          models: providerModelsFromSettings(snapshot.models, config.customModels, {}),
        };
        PubSub.publishUnsafe(changes, snapshot);
      };
      const finish = (
        context: Session,
        state: "completed" | "failed" | "interrupted",
        message?: string,
      ) => {
        const turnId = context.activeTurn;
        if (!turnId || context.stopped) return;
        emit({
          ...stamp(),
          type: "item.completed",
          threadId: context.session.threadId,
          turnId,
          itemId: RuntimeItemId.make(context.itemId ?? turnId),
          payload: { itemType: "assistant_message" },
        });
        context.activeTurn = undefined;
        context.session = {
          ...context.session,
          status: state === "failed" ? "error" : "ready",
          activeTurnId: undefined,
          updatedAt: nowIso(),
        };
        emit({
          ...stamp(),
          type: "turn.completed",
          threadId: context.session.threadId,
          turnId,
          payload: { state, ...(message ? { errorMessage: message } : {}) },
        });
        context.approvals.clear();
      };
      const handle = (context: Session, message: NativeRpcMessage) => {
        if (context.stopped) return;
        try {
          const params = record(message.params);
          if (params.sessionId && params.sessionId !== context.nativeId) return;
          const threadId = context.session.threadId;
          const turnId = context.activeTurn;
          if (message.method === "session/request_permission" && message.id !== undefined) {
            const call = record(params.toolCall);
            const requestId = RuntimeRequestId.make(
              text(call.toolCallId) || `permission-${++sequence}`,
            );
            context.approvals.set(requestId as unknown as ApprovalRequestId, {
              rpcId: message.id,
              requestType: call.kind === "edit" ? "file_change_approval" : "exec_command_approval",
              options: records(params.options),
            });
            emit({
              ...stamp(),
              type: "request.opened",
              threadId,
              turnId,
              requestId,
              payload: {
                requestType:
                  call.kind === "edit" ? "file_change_approval" : "exec_command_approval",
                detail: text(call.title) || "Kimi requests permission",
                args: call.rawInput,
              },
            });
            return;
          }
          if (message.method !== "session/update") {
            if (message.id !== undefined && message.method)
              context.connection.send({
                id: message.id,
                error: { code: -32601, message: "Unsupported client request" },
              });
            return;
          }
          const update = record(params.update);
          if (update.sessionUpdate === "config_option_update") {
            learnModels(update);
            return;
          }
          if (!turnId) return;
          if (
            update.sessionUpdate === "agent_message_chunk" ||
            update.sessionUpdate === "agent_thought_chunk"
          ) {
            const content = record(update.content);
            if (content.type !== "text" || !text(content.text)) return;
            emit({
              ...stamp(),
              type: "content.delta",
              threadId,
              turnId,
              itemId: RuntimeItemId.make(context.itemId ?? turnId),
              payload: {
                streamKind:
                  update.sessionUpdate === "agent_thought_chunk"
                    ? "reasoning_text"
                    : "assistant_text",
                delta: text(content.text),
              },
            });
          } else if (
            update.sessionUpdate === "tool_call" ||
            update.sessionUpdate === "tool_call_update"
          ) {
            const status =
              update.status === "failed"
                ? "failed"
                : update.status === "completed"
                  ? "completed"
                  : "inProgress";
            emit({
              ...stamp(),
              type: status === "inProgress" ? "item.updated" : "item.completed",
              threadId,
              turnId,
              itemId: RuntimeItemId.make(text(update.toolCallId)),
              payload: {
                itemType: "dynamic_tool_call",
                status,
                title: text(update.title) || "Kimi tool",
                data: update,
              },
            });
          }
        } catch (cause) {
          finish(
            context,
            "failed",
            cause instanceof Error ? cause.message : "Invalid Kimi protocol event",
          );
        }
      };
      const requireSession = (threadId: ThreadId) => {
        const context = sessions.get(threadId);
        if (!context || context.stopped) throw new Error("Kimi session is not running.");
        return context;
      };
      const adapter: ProviderAdapterShape<ProviderAdapterError> = {
        provider: DRIVER,
        capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
        startSession: (input) =>
          attempt("session/start", async (signal) => {
            if (sessions.has(input.threadId) || pendingStarts.has(input.threadId))
              throw new Error("Kimi session already exists.");
            pendingStarts.add(input.threadId);
            let context: Session | undefined;
            const connection = new NativeCliConnection({
              signal,
              command: config.binaryPath,
              args: ["acp"],
              cwd: input.cwd ?? cwd,
              env: withAgentDeviceEnvironment(env, readMcpProviderSession(input.threadId)),
              onMessage: (message) => {
                if (context) handle(context, message);
              },
              onClose: (cause) => {
                if (context && !context.stopped) {
                  finish(context, "failed", cause.message);
                  context.session = { ...context.session, status: "closed" };
                }
              },
            });
            try {
              await connection.request("initialize", INITIALIZE);
              const mcp = readMcpProviderSession(input.threadId);
              const resume = input.resumeCursor ? record(input.resumeCursor) : {};
              const setup = record(
                await connection.request(
                  resume.sessionId ? "session/load" : "session/new",
                  {
                    cwd: input.cwd ?? cwd,
                    ...(resume.sessionId ? { sessionId: resume.sessionId } : {}),
                    mcpServers: mcp
                      ? [
                          {
                            type: "http",
                            name: "t3-code",
                            url: mcp.endpoint,
                            headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
                          },
                        ]
                      : [],
                  },
                  90_000,
                ),
              );
              const nativeId = text(setup.sessionId) || text(resume.sessionId);
              if (!nativeId) throw new Error("Kimi did not return a session id.");
              const now = nowIso();
              context = {
                connection,
                nativeId,
                effortConfigId:
                  text(
                    records(setup.configOptions).find(
                      (option) => option.category === "thought_level",
                    )?.id,
                  ) || undefined,
                stopped: false,
                approvals: new Map(),
                session: {
                  provider: DRIVER,
                  providerInstanceId: instanceId,
                  threadId: input.threadId,
                  status: "ready",
                  runtimeMode: input.runtimeMode,
                  cwd: input.cwd ?? cwd,
                  model: input.modelSelection?.model,
                  resumeCursor: { sessionId: nativeId },
                  createdAt: now,
                  updatedAt: now,
                },
              };
              learnModels(setup);
              sessions.set(input.threadId, context);
              emit({ ...stamp(), type: "session.started", threadId: input.threadId, payload: {} });
              emit({
                ...stamp(),
                type: "thread.started",
                threadId: input.threadId,
                payload: { providerThreadId: nativeId },
              });
              emit({
                ...stamp(),
                type: "session.state.changed",
                threadId: input.threadId,
                payload: { state: "ready" },
              });
              return context.session;
            } catch (cause) {
              await connection.close();
              throw cause;
            } finally {
              pendingStarts.delete(input.threadId);
            }
          }),
        sendTurn: (input) =>
          Effect.gen(function* () {
            const turnId = TurnId.make(
              yield* crypto.randomUUIDv4.pipe(Effect.mapError((cause) => error("uuid", cause))),
            );
            const prompt: unknown[] = [
              {
                type: "text",
                text: `${buildRuntimeInstructions({ harness: "Kimi Code", model: input.modelSelection?.model })}\n\n${input.input ?? ""}`,
              },
            ];
            for (const attachment of input.attachments ?? []) {
              const path = resolveAttachmentPath({ attachmentsDir, attachment });
              if (!path) return yield* error("attachment", "Attachment path is unavailable.");
              if (attachment.type === "image") {
                const bytes = yield* fs
                  .readFile(path)
                  .pipe(Effect.mapError((cause) => error("attachment", cause)));
                prompt.push({
                  type: "image",
                  data: Buffer.from(bytes).toString("base64"),
                  mimeType: attachment.mimeType,
                });
              } else
                prompt.push({ type: "text", text: `Attached file ${attachment.name}: ${path}` });
            }
            return yield* attempt("session/prompt", async () => {
              const context = requireSession(input.threadId);
              if (context.activeTurn)
                throw new Error(
                  "Kimi is busy. Queue this message or stop the current response first.",
                );
              if (input.modelSelection?.model && input.modelSelection.model !== "kimi-default") {
                await context.connection.request("session/set_config_option", {
                  sessionId: context.nativeId,
                  configId: "model",
                  value: input.modelSelection.model,
                });
              }
              for (const option of input.modelSelection?.options ?? []) {
                await context.connection.request("session/set_config_option", {
                  sessionId: context.nativeId,
                  configId: ["thought_level", "thinking"].includes(option.id)
                    ? (context.effortConfigId ?? option.id)
                    : option.id,
                  value: option.value,
                });
              }
              const mode =
                input.interactionMode === "plan"
                  ? "plan"
                  : context.session.runtimeMode === "full-access"
                    ? "auto"
                    : context.session.runtimeMode === "auto"
                      ? "yolo"
                      : "default";
              await context.connection.request("session/set_config_option", {
                sessionId: context.nativeId,
                configId: "mode",
                value: mode,
              });
              context.activeTurn = turnId;
              context.itemId = turnId;
              context.session = {
                ...context.session,
                status: "running",
                activeTurnId: turnId,
                model: input.modelSelection?.model ?? context.session.model,
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
              void context.connection
                .request(
                  "session/prompt",
                  { sessionId: context.nativeId, prompt },
                  24 * 60 * 60 * 1000,
                )
                .then((result) =>
                  finish(
                    context,
                    record(result).stopReason === "cancelled" ? "interrupted" : "completed",
                  ),
                )
                .catch((cause) =>
                  finish(context, "failed", cause instanceof Error ? cause.message : "Kimi failed"),
                );
              return {
                threadId: input.threadId,
                turnId,
                resumeCursor: context.session.resumeCursor,
              };
            });
          }),
        interruptTurn: (threadId) =>
          attempt("session/cancel", async () => {
            const context = requireSession(threadId);
            context.connection.send({
              method: "session/cancel",
              params: { sessionId: context.nativeId },
            });
          }),
        respondToRequest: (threadId, requestId, decision) =>
          attempt("permission", async () => {
            const context = requireSession(threadId);
            const request = context.approvals.get(requestId);
            if (!request) throw new Error("Permission request is no longer pending.");
            const kind =
              decision === "accept"
                ? "allow_once"
                : decision === "acceptForSession" || decision === "acceptAlways"
                  ? "allow_always"
                  : "reject_once";
            const option = request.options.find((entry) => entry.kind === kind);
            context.connection.send({
              id: request.rpcId,
              result: {
                outcome: option
                  ? { outcome: "selected", optionId: option.optionId }
                  : { outcome: "cancelled" },
              },
            });
            context.approvals.delete(requestId);
            emit({
              ...stamp(),
              type: "request.resolved",
              threadId,
              turnId: context.activeTurn,
              requestId: RuntimeRequestId.make(requestId),
              payload: { requestType: request.requestType, decision },
            });
          }),
        respondToUserInput: () =>
          Effect.fail(
            error("user-input", "This Kimi protocol does not expose structured user input."),
          ),
        stopSession: (threadId) =>
          attempt("stop", async () => {
            const context = sessions.get(threadId);
            if (!context) return;
            context.stopped = true;
            await context.connection.close();
            sessions.delete(threadId);
          }),
        stopAll: () =>
          Effect.forEach([...sessions.keys()], (id) => adapter.stopSession(id), { discard: true }),
        listSessions: () => Effect.sync(() => [...sessions.values()].map((entry) => entry.session)),
        hasSession: (id) => Effect.sync(() => sessions.has(id)),
        readThread: () => Effect.fail(error("readThread", "Use T3's saved conversation history.")),
        rollbackThread: () =>
          Effect.fail(error("rollbackThread", "Kimi does not support conversation rollback.")),
        streamEvents: Stream.fromPubSub(events),
      };
      const refresh = Effect.gen(function* () {
        if (!enabled) return snapshot;
        const result = yield* attempt("probe", async (signal) => {
          const connection = new NativeCliConnection({
            signal,
            command: config.binaryPath,
            args: ["acp"],
            cwd,
            env,
            onMessage: () => {},
          });
          try {
            const initialized = record(await connection.request("initialize", INITIALIZE));
            const catalogue = await readNativeCliJson({
              command: config.binaryPath,
              args: ["provider", "list", "--json"],
              cwd,
              env,
              signal,
            }).catch(() => null);
            return { initialized, models: catalogue ? record(record(catalogue).models) : {} };
          } finally {
            await connection.close();
          }
        }).pipe(Effect.result);
        snapshot =
          result._tag === "Success"
            ? {
                ...snapshot,
                installed: true,
                version: text(record(result.success.initialized.agentInfo).version) || null,
                status: "ready",
                message: "Uses your Kimi CLI login. Model discovery does not create sessions.",
                models: Object.keys(result.success.models).length
                  ? [
                      {
                        slug: "kimi-default",
                        name: "Kimi CLI default",
                        isCustom: false,
                        isDefault: true,
                        capabilities: null,
                      },
                      ...Object.entries(result.success.models).map(([slug, raw]) => {
                        const model = record(raw);
                        const efforts = Array.isArray(model.supportEfforts)
                          ? model.supportEfforts.filter(
                              (value): value is string => typeof value === "string",
                            )
                          : [];
                        return {
                          slug,
                          name: text(model.displayName) || slug,
                          isCustom: false,
                          capabilities: efforts.length
                            ? {
                                optionDescriptors: [
                                  {
                                    id: "thinking",
                                    label: "Thinking",
                                    type: "select" as const,
                                    options: efforts.map((value) => ({ id: value, label: value })),
                                    currentValue: text(model.defaultEffort),
                                  },
                                ],
                              }
                            : null,
                        };
                      }),
                    ]
                  : snapshot.models.length
                    ? snapshot.models
                    : [
                        {
                          slug: "kimi-default",
                          name: "Kimi CLI default",
                          isCustom: false,
                          isDefault: true,
                          capabilities: null,
                        },
                      ],
              }
            : { ...snapshot, installed: false, status: "error", message: result.failure.message };
        snapshot = {
          ...snapshot,
          models: providerModelsFromSettings(snapshot.models, config.customModels, {}),
          checkedAt: nowIso(),
        };
        PubSub.publishUnsafe(changes, snapshot);
        return snapshot;
      });
      yield* refresh;
      yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));
      const unsupported = (operation: string) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail:
              "Choose another provider for background title and source-control text generation.",
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
