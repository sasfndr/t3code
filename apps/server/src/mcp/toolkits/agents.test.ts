import { OrchestrationCommandInvariantError } from "../../orchestration/Errors.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  OrchestrationThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AgentRoutingSettings,
  type OrchestrationCommand,
  type ServerProvider,
} from "@t3tools/contracts";
import { AgentsToolkit, AgentsToolkitHandlersLive } from "./agents.ts";
import { McpInvocationContext, type McpCapability } from "../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { delegatedDescendants } from "../../orchestration/agentTaskLinks.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";

const rootId = ThreadId.make("root");
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
const provider: ServerProvider = {
  instanceId: selection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-26T00:00:00Z",
  models: [{ slug: selection.model, name: "GPT", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};
const design = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
const claude: ServerProvider = {
  ...provider,
  instanceId: design.instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  models: [{ slug: design.model, name: "Opus", isCustom: false, capabilities: null }],
};
const decodeThread = Schema.decodeSync(OrchestrationThread);
function makeThread(id: ThreadId) {
  return decodeThread({
    id,
    projectId: ProjectId.make("project"),
    title: "Task",
    modelSelection: selection,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-26T00:00:00Z",
    updatedAt: "2026-09-26T00:00:00Z",
    deletedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    session: null,
  });
}
const harness = Effect.fnUntraced(function* (
  overrides: Partial<AgentRoutingSettings> = {},
  rejectStart = false,
  routerAnswer: string | null = null,
) {
  const routerCalls: string[] = [];
  const threads = new Map([[rootId, makeThread(rootId)]]);
  const commands: OrchestrationCommand[] = [];
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    agentRouting: {
      ...DEFAULT_SERVER_SETTINGS.agentRouting,
      mode: "single" as const,
      singleModel: selection,
      delegation: "auto" as const,
      ...overrides,
    },
  };
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadDetailById: (id) => Effect.sync(() => Option.fromNullishOr(threads.get(id))),
    }),
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider, claude]) }),
    Layer.mock(TextGeneration)({
      routeTask: (input) =>
        Effect.sync(() => {
          routerCalls.push(input.message);
          return { routeId: routerAnswer, reason: "test router" };
        }),
    }),
    Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(settings) }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        command.type === "thread.turn.start" && rejectStart
          ? Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "Simulated admission failure",
              }),
            )
          : Effect.sync(() => {
              commands.push(command);
              if (command.type === "thread.delete") threads.delete(command.threadId);
              if (command.type === "thread.create")
                threads.set(command.threadId, {
                  ...makeThread(command.threadId),
                  modelSelection: command.modelSelection,
                });
              if (command.type === "thread.activity.append") {
                const current = threads.get(command.threadId)!;
                threads.set(command.threadId, {
                  ...current,
                  activities: [...current.activities, command.activity],
                });
              }
              return { sequence: commands.length };
            }),
    }),
    NodeServices.layer,
  );
  const toolkit = yield* AgentsToolkit.pipe(
    Effect.provide(AgentsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = (input: Parameters<typeof toolkit.handle<"agent_task">>[1], caller = rootId) =>
    toolkit.handle("agent_task", input).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("test"),
        threadId: caller,
        providerSessionId: "test",
        providerInstanceId: selection.instanceId,
        issuedAt: 0,
        capabilities: new Set<McpCapability>(),
      }),
    );
  return { call, commands, threads, routerCalls };
});

it.effect("locks delegated execution to the configured model and preserves task context", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.call({
      action: "start",
      taskKey: "api",
      objective: "Build the API",
      context: "Keep the existing contract",
      files: ["server/api.ts"],
    });
    const start = h.commands.find((command) => command.type === "thread.turn.start");
    expect(start?.modelSelection).toEqual(selection);
    expect(start?.message.text).toContain("Keep the existing contract");
    expect(start?.message.text).toContain("server/api.ts");
    expect(delegatedDescendants([...h.threads.values()], rootId)).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect("makes concurrent retries idempotent and enforces admission limits", () =>
  Effect.gen(function* () {
    const h = yield* harness({ maxConcurrentAgents: 1 });
    yield* Effect.all(
      [
        h.call({ action: "start", taskKey: "same", objective: "Implement", files: ["a.ts"] }),
        h.call({ action: "start", taskKey: "same", objective: "Implement", files: ["a.ts"] }),
      ],
      { concurrency: "unbounded" },
    );
    expect(h.commands.filter((command) => command.type === "thread.create")).toHaveLength(1);
    const second = yield* h
      .call({ action: "start", taskKey: "second", objective: "Implement", files: ["b.ts"] })
      .pipe(Effect.result);
    expect(second._tag).toBe("Failure");
    expect(h.commands.filter((command) => command.type === "thread.create")).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect("blocks overlapping file ownership, path traversal, and unauthorized task reads", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.call({ action: "start", taskKey: "api", objective: "Implement", files: ["server"] });
    for (const files of [
      ["server/api.ts"],
      ["../outside"],
      ["/etc"],
      ["/"],
      ["server/./api.ts"],
      ["server//api.ts"],
    ]) {
      expect(
        (yield* h
          .call({ action: "start", taskKey: "other", objective: "Implement", files })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }
    const child = [...h.threads.keys()].find((id) => id !== rootId)!;
    expect(
      (yield* h.call({ action: "read", taskKey: "api" }, child).pipe(Effect.result))._tag,
    ).toBe("Failure");
  }).pipe(Effect.scoped),
);

it.effect("enforces direct execution and nesting limits", () =>
  Effect.gen(function* () {
    const direct = yield* harness({ delegation: "direct" });
    expect(
      (yield* direct
        .call({ action: "start", taskKey: "a", objective: "Implement" })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(direct.commands).toHaveLength(0);
    const h = yield* harness({ maxDepth: 1 });
    yield* h.call({ action: "start", taskKey: "a", objective: "Implement" });
    const child = [...h.threads.keys()].find((id) => id !== rootId)!;
    expect(
      (yield* h
        .call({ action: "start", taskKey: "b", objective: "Implement" }, child)
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
  }).pipe(Effect.scoped),
);

it.effect("removes a child when turn admission fails before publishing the task link", () =>
  Effect.gen(function* () {
    const h = yield* harness({}, true);
    const result = yield* h
      .call({ action: "start", taskKey: "retry", objective: "Implement" })
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect([...h.threads.keys()]).toEqual([rootId]);
    expect(h.threads.get(rootId)?.activities).toHaveLength(0);
  }).pipe(Effect.scoped),
);
it.effect("counts running children from previous turns against the concurrency cap", () =>
  Effect.gen(function* () {
    const h = yield* harness({ maxConcurrentAgents: 1 });
    yield* h.call({ action: "start", taskKey: "old", objective: "Implement" });
    const root = h.threads.get(rootId)!;
    h.threads.set(rootId, {
      ...root,
      activities: root.activities.map((a) => ({
        ...a,
        payload: { ...(a.payload as object), rootTurnId: "earlier-turn" },
      })),
    });
    const prior = yield* h.call({ action: "read", taskKey: "old" }).pipe(Effect.result);
    expect(prior._tag).toBe("Success");
    const result = yield* h
      .call({ action: "start", taskKey: "new", objective: "Implement" })
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(h.commands.filter((c) => c.type === "thread.create")).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect("lets the router assign a specialist when the parent names none", () =>
  Effect.gen(function* () {
    const routes = {
      mode: "auto" as const,
      router: selection,
      rules: [
        {
          id: "design",
          name: "Design",
          description: "Visual and frontend work",
          enabled: true,
          match: [],
          selection: design,
          efforts: { fast: "", balanced: "", thorough: "" },
          fallback: null,
        },
      ],
    };
    const routed = yield* harness(routes, false, "design");
    yield* routed.call({ action: "start", taskKey: "hero", objective: "Polish the hero section" });
    expect(routed.routerCalls[0]).toContain("Polish the hero section");
    expect(
      routed.commands.find((command) => command.type === "thread.turn.start")?.modelSelection,
    ).toEqual(design);

    const named = yield* harness(routes, false, null);
    yield* named.call({ action: "start", taskKey: "x", objective: "Anything", ruleId: "design" });
    expect(named.routerCalls).toHaveLength(0);
    expect(
      named.commands.find((command) => command.type === "thread.turn.start")?.modelSelection,
    ).toEqual(design);
  }).pipe(Effect.scoped),
);
