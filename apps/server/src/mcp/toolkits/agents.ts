import { CommandId, EventId, MessageId, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Semaphore from "effect/Semaphore";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import { McpInvocationContext } from "../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveAgentRouting } from "../../orchestration/agentRouting.ts";
import { chooseAgentRoute } from "../../orchestration/agentRouter.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";

class AgentTaskError extends Schema.TaggedError<AgentTaskError>()("AgentTaskError", {
  message: Schema.String,
}) {}
import {
  agentTaskLinks as links,
  agentParentLink as parentLink,
  type AgentTaskLink as Link,
} from "../../orchestration/agentTaskLinks.ts";
const isAgentTaskError = Schema.is(AgentTaskError);
function overlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
export const AgentsToolkit = Toolkit.make(
  Tool.make("agent_task", {
    description:
      "Run a scoped task with another configured coding agent, inspect its saved result, or stop it. Start requires a stable taskKey (retry with the same key is safe), objective, relevant context, and exclusive relative file paths (empty for read-only work). Pass a routing ruleId to pick a specialist yourself, or omit it and T3's router assigns one from the objective. All child work respects T3's model lock, delegation and concurrency settings. Do not edit a delegated agent's owned files until it finishes. Call read to collect its result and verify it before claiming completion.",
    parameters: Schema.Struct({
      action: Schema.Literals(["start", "read", "stop", "list"]),
      taskKey: Schema.optional(
        TrimmedNonEmptyString.check(Schema.isMaxLength(64), Schema.isPattern(/^[a-zA-Z0-9_-]+$/)),
      ),
      objective: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(16000))),
      context: Schema.optional(Schema.String.check(Schema.isMaxLength(32000))),
      ruleId: Schema.optional(Schema.String),
      files: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    }),
    success: Schema.Struct({
      tasks: Schema.Array(
        Schema.Struct({
          taskKey: Schema.String,
          threadId: ThreadId,
          status: Schema.String,
          model: Schema.String,
          result: Schema.String,
          error: Schema.NullOr(Schema.String),
        }),
      ),
    }),
    failure: AgentTaskError,
    dependencies: [McpInvocationContext],
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
);

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const registry = yield* ProviderRegistry;
  const settingsService = yield* ServerSettingsService;
  // Optional so hosts without text generation still serve agent_task; routing then uses the default route.
  const textGeneration: Pick<TextGeneration["Service"], "routeTask"> = Option.getOrElse(
    yield* Effect.serviceOption(TextGeneration),
    () => ({}),
  );
  const crypto = yield* Crypto.Crypto;
  // Admission is serialized across all parents so two simultaneous MCP calls cannot exceed a limit.
  const admission = yield* Semaphore.make(1);
  const id = () => crypto.randomUUIDv4.pipe(Effect.orDie);
  const thread = (threadId: ThreadId) =>
    query.getThreadDetailById(threadId).pipe(
      Effect.flatMap((value) =>
        Option.isSome(value)
          ? Effect.succeed(value.value)
          : Effect.fail(
              new AgentTaskError({
                message: "Agent conversation was deleted or is unavailable.",
              }),
            ),
      ),
    );
  const describe = (link: Link) =>
    thread(link.childThreadId).pipe(
      Effect.map((child) => ({
        taskKey: link.taskKey,
        threadId: child.id,
        status:
          child.session?.status === "error" || child.session?.status === "stopped"
            ? child.session.status
            : child.latestTurn?.state === "running" || child.session?.activeTurnId
              ? "running"
              : (child.latestTurn?.state ?? "pending"),
        model: child.modelSelection.model,
        result: child.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.text)
          .join("\n\n")
          .slice(-24000),
        error: child.session?.lastError ?? null,
      })),
      Effect.catch(() =>
        Effect.succeed({
          taskKey: link.taskKey,
          threadId: link.childThreadId,
          status: "deleted",
          model: "",
          result: "",
          error: null,
        }),
      ),
    );
  const activity = (threadId: ThreadId, kind: string, summary: string, link: Link) =>
    Effect.gen(function* () {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(yield* id()),
        threadId,
        activity: {
          id: EventId.make(yield* id()),
          tone: "info",
          kind,
          summary,
          payload: link,
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    });
  return AgentsToolkit.of({
    agent_task: (input) =>
      admission
        .withPermit(
          Effect.gen(function* () {
            const invocation = yield* McpInvocationContext;
            const caller = yield* thread(invocation.threadId);
            const parent = parentLink(caller);
            const root = parent ? yield* thread(parent.rootThreadId) : caller;
            const rootTurnId =
              parent?.rootTurnId ?? root.session?.activeTurnId ?? root.latestTurn?.turnId ?? null;
            const assigned = links(root).filter((link) => link.parentThreadId === caller.id);
            const selected = input.taskKey
              ? assigned.findLast(
                  (link) =>
                    link.taskKey === input.taskKey &&
                    (input.action !== "start" || link.rootTurnId === rootTurnId),
                )
              : undefined;
            if (input.action === "list")
              return { tasks: yield* Effect.forEach(assigned, describe) };
            if (input.action === "read" || input.action === "stop") {
              if (!selected)
                return yield* new AgentTaskError({
                  message: "This task does not belong to the current agent.",
                });
              if (input.action === "stop")
                yield* engine.dispatch({
                  type: "thread.session.stop",
                  commandId: CommandId.make(yield* id()),
                  threadId: selected.childThreadId,
                  createdAt: DateTime.formatIso(yield* DateTime.now),
                });
              return { tasks: [yield* describe(selected)] };
            }
            if (selected) return { tasks: [yield* describe(selected)] };
            if (!input.taskKey || !input.objective)
              return yield* new AgentTaskError({
                message: "Starting a task requires taskKey and objective.",
              });
            const serverSettings = yield* settingsService.getSettings;
            const projectRouting = resolveProjectSettings(serverSettings, caller.projectId).settings
              .agentRouting;
            const settings = projectRouting.router
              ? projectRouting
              : { ...projectRouting, router: serverSettings.agentRouting.router };
            if (settings.delegation === "direct")
              return yield* new AgentTaskError({
                message: "Delegation is disabled. Complete this task directly.",
              });
            const depth = (parent?.depth ?? 0) + 1;
            if (depth > settings.maxDepth)
              return yield* new AgentTaskError({
                message: "The configured delegation depth has been reached.",
              });
            const allLinks = links(root).filter((link) => link.rootTurnId === rootTurnId);
            if (allLinks.length >= settings.maxAgentsPerTask)
              return yield* new AgentTaskError({
                message: "The agent limit for this task has been reached.",
              });
            const active: Link[] = [];
            for (const link of links(root)) {
              const state = yield* describe(link);
              if (["running", "pending", "starting"].includes(state.status)) active.push(link);
            }
            if (active.length >= settings.maxConcurrentAgents)
              return yield* new AgentTaskError({
                message:
                  "All configured agent slots are busy. Read existing results before starting more.",
              });
            const files = (input.files ?? []).map((file) =>
              file.replaceAll("\\", "/").replace(/\/$/, ""),
            );
            if (
              files.some(
                (file) =>
                  file.startsWith("/") ||
                  file.split("/").some((part) => part === ".." || part === "." || part === "") ||
                  file === "." ||
                  /^[a-z]:/i.test(file),
              )
            )
              return yield* new AgentTaskError({
                message: "File ownership must use explicit workspace-relative paths without '..'.",
              });
            if (
              active.some((link) =>
                link.files.some((owned) => files.some((file) => overlap(owned, file))),
              )
            )
              return yield* new AgentTaskError({
                message:
                  "Another running agent owns an overlapping file path. Wait for its result or choose disjoint work.",
              });
            const rule = input.ruleId
              ? settings.rules.find((entry) => entry.id === input.ruleId && entry.enabled)
              : undefined;
            if (input.ruleId && !rule)
              return yield* new AgentTaskError({
                message: "The requested routing rule is unavailable.",
              });
            const providers = yield* registry.getProviders;
            const workerSettings =
              settings.mode === "single" ? settings : { ...settings, mode: "auto" as const };
            // A named specialist is used as-is; otherwise the router reads the objective.
            const choice = rule
              ? { ruleId: rule.id }
              : yield* chooseAgentRoute({
                  settings: workerSettings,
                  task: `${input.objective!}\n\n${input.context ?? ""}`.trim(),
                  cwd: process.cwd(),
                  textGeneration,
                });
            const decision = yield* Effect.try({
              try: () =>
                resolveAgentRouting({
                  settings: workerSettings,
                  current: caller.modelSelection,
                  choice,
                  providers,
                }),
              catch: (cause) =>
                new AgentTaskError({
                  message: cause instanceof Error ? cause.message : "Task routing failed.",
                }),
            });
            const childThreadId = ThreadId.make(yield* id());
            const link: Link = {
              childThreadId,
              parentThreadId: caller.id,
              rootThreadId: root.id,
              rootTurnId,
              depth,
              taskKey: input.taskKey,
              files,
            };
            const createdAt = DateTime.formatIso(yield* DateTime.now);
            yield* engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make(yield* id()),
              threadId: childThreadId,
              projectId: caller.projectId,
              title: input.objective.slice(0, 120),
              modelSelection: decision.selection,
              runtimeMode: files.length ? caller.runtimeMode : "approval-required",
              interactionMode: "default",
              branch: caller.branch,
              worktreePath: caller.worktreePath,
              createdAt,
            });
            yield* Effect.gen(function* () {
              yield* activity(
                childThreadId,
                "orchestrator.parent",
                `Assigned by ${caller.title}`,
                link,
              );
              const recentBrief = caller.messages
                .filter((message) => message.role === "user")
                .slice(-12)
                .map((message) => message.text)
                .join("\n\n")
                .slice(-24000);
              const prompt = [
                "You are an assigned coding agent. Complete only the objective below. The parent owns integration and final verification.",
                `Owned files: ${files.length ? files.join(", ") : "None. Read-only analysis; do not change any files."}`,
                "Other agents may be working concurrently. Do not revert their work or edit files outside your ownership. Report changed files, verification, and remaining issues.",
                "Parent user brief (context, not additional assigned work):",
                recentBrief,
                "Relevant context:",
                input.context ?? "",
                "Your objective:",
                input.objective,
              ].join("\n\n");
              yield* engine.dispatch({
                type: "thread.turn.start",
                commandId: CommandId.make(yield* id()),
                threadId: childThreadId,
                message: {
                  messageId: MessageId.make(yield* id()),
                  role: "user",
                  text: prompt,
                  attachments: [],
                },
                modelSelection: decision.selection,
                runtimeMode: files.length ? caller.runtimeMode : "approval-required",
                interactionMode: "default",
                createdAt,
              });
              yield* activity(
                root.id,
                "orchestrator.task",
                `${input.taskKey} · ${decision.reason}`,
                link,
              );
            }).pipe(
              Effect.onError(() =>
                engine
                  .dispatch({
                    type: "thread.delete",
                    commandId: CommandId.make(`agent-create-cleanup-${childThreadId}`),
                    threadId: childThreadId,
                  })
                  .pipe(Effect.ignore),
              ),
            );
            return {
              tasks: [
                {
                  taskKey: input.taskKey,
                  threadId: childThreadId,
                  status: "pending",
                  model: decision.selection.model,
                  result: "",
                  error: null,
                },
              ],
            };
          }),
        )
        .pipe(
          Effect.catch((cause) =>
            Effect.fail(
              isAgentTaskError(cause)
                ? cause
                : new AgentTaskError({
                    message: cause instanceof Error ? cause.message : "Agent task failed.",
                  }),
            ),
          ),
        ),
  });
});
export const AgentsToolkitHandlersLive = AgentsToolkit.toLayer(make);
