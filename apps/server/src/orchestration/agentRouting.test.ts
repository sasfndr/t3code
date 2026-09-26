import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_AGENT_ROUTING_SETTINGS,
  ProviderInstanceId,
  ProviderDriverKind,
  type AgentRoutingSettings,
  type ServerProvider,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TextGenerationError } from "@t3tools/contracts";
import { resolveAgentRouting, agentExecutionInstructions } from "./agentRouting.ts";
import { chooseAgentRoute } from "./agentRouter.ts";

const backend = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
const design = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
const providers: ServerProvider[] = [backend, design].map((selection) => ({
  instanceId: selection.instanceId,
  driver: ProviderDriverKind.make(selection.instanceId),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-26T00:00:00Z",
  models: [
    {
      slug: selection.model,
      name: selection.model,
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: ["medium", "high"].map((id) => ({ id, label: id })),
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
}));
const settings: AgentRoutingSettings = {
  ...DEFAULT_AGENT_ROUTING_SETTINGS,
  mode: "auto",
  rules: [
    {
      id: "design",
      name: "Design",
      description: "",
      enabled: true,
      match: [],
      selection: design,
      efforts: { fast: "medium", balanced: "high", thorough: "high" },
      fallback: null,
    },
  ],
};
const route = (
  ruleId: string | null,
  override: Partial<AgentRoutingSettings> = {},
  catalog = providers,
) =>
  resolveAgentRouting({
    settings: { ...settings, ...override },
    current: backend,
    providers: catalog,
    choice: { ruleId, reason: "router says so" },
  });

describe("agent routing policy", () => {
  it("honors the model lock whatever the router chose", () => {
    expect(route("design", { mode: "single", singleModel: backend }).selection).toEqual(backend);
  });
  it("never silently replaces an unavailable locked model", () => {
    expect(() => route("design", { mode: "single", singleModel: design }, [providers[0]!])).toThrow(
      "locked model is unavailable",
    );
  });
  it("runs the router's route with the priority's effort and keeps its reason", () => {
    const decision = route("design", { priority: "fast" });
    expect(decision.selection).toEqual({ ...design, options: [{ id: "effort", value: "medium" }] });
    expect(decision.routerReason).toBe("router says so");
    expect(decision.reason).toBe("Routed to claude-opus-5-5 · medium · Design");
    expect(route("design", { priority: "thorough" }).selection.options).toEqual([
      { id: "effort", value: "high" },
    ]);
  });
  it("refuses unsupported configured effort", () => {
    expect(() =>
      route("design", {
        rules: [
          { ...settings.rules[0]!, efforts: { fast: "max", balanced: "max", thorough: "max" } },
        ],
      }),
    ).toThrow("unavailable");
  });
  it("uses only an explicitly configured available fallback with its own options", () => {
    expect(() => route("design", {}, [providers[0]!])).toThrow("no available fallback");
    const fallback = { ...backend, options: [{ id: "effort", value: "medium" }] };
    expect(
      route("design", { rules: [{ ...settings.rules[0]!, fallback }] }, [providers[0]!]).selection,
    ).toEqual(fallback);
  });
  it("rejects a route that is missing or turned off", () => {
    expect(() => route("nope")).toThrow("missing or turned off");
    expect(() => route("design", { rules: [{ ...settings.rules[0]!, enabled: false }] })).toThrow(
      "missing or turned off",
    );
  });
  it("sends unrouted work to Everything else, or keeps the current model", () => {
    expect(route(null).selection).toEqual(backend);
    expect(route(null).source).toBe("unmatched");
    const decision = route(null, {
      defaultRoute: { selection: design, efforts: { fast: "medium", balanced: "", thorough: "" } },
      priority: "fast",
    });
    expect(decision.source).toBe("default");
    expect(decision.selection).toEqual({ ...design, options: [{ id: "effort", value: "medium" }] });
  });
  it("manual mode preserves the exact user's model and effort", () => {
    expect(route("design", { mode: "manual" }).selection).toEqual(backend);
  });
  it("keeps direct execution explicit and carries the evolving brief instruction", () => {
    const instruction = agentExecutionInstructions(settings);
    expect(instruction).toContain("Do not spawn sub-agents");
    expect(instruction).toContain("one evolving brief");
  });
  it("briefs delegating parents with each specialist's model and purpose", () => {
    const instruction = agentExecutionInstructions(
      {
        ...settings,
        delegation: "auto",
        rules: [{ ...settings.rules[0]!, description: "Owns visual polish" }],
      },
      providers,
    );
    expect(instruction).toContain("- design: Design (claude-opus-5-5) — Owns visual polish");
  });
});

describe("router selection", () => {
  const textGeneration = (routeId: string | null, fail = false) => ({
    routeTask: () =>
      fail
        ? Effect.fail(new TextGenerationError({ operation: "routeTask", detail: "CLI missing" }))
        : Effect.succeed({ routeId, reason: "fits" }),
  });
  const auto = { ...settings, router: backend };
  const choose = (s: AgentRoutingSettings, fail = false) =>
    chooseAgentRoute({
      settings: s,
      task: "x",
      cwd: "/",
      textGeneration: textGeneration("design", fail),
    });
  effectIt.effect("asks the router model and passes its choice through", () =>
    Effect.gen(function* () {
      expect(yield* choose(auto)).toEqual({ ruleId: "design", reason: "fits" });
    }),
  );
  effectIt.effect("falls back to Everything else, with a reason, when routing cannot run", () =>
    Effect.gen(function* () {
      expect(yield* choose({ ...auto, router: null })).toEqual({
        ruleId: null,
        reason: "No router model chosen",
      });
      expect((yield* choose(auto, true)).reason).toBe("Router unavailable: CLI missing");
      expect((yield* choose({ ...auto, rules: [] })).ruleId).toBeNull();
    }),
  );
});
