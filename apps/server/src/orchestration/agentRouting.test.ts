import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_AGENT_ROUTING_SETTINGS,
  ProviderInstanceId,
  ProviderDriverKind,
  type AgentRoutingSettings,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveAgentRouting, agentExecutionInstructions } from "./agentRouting.ts";

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
      enabled: true,
      match: ["UI", "design", "front-end"],
      selection: design,
      efforts: { fast: "medium", balanced: "high", thorough: "high" },
      fallback: null,
    },
  ],
};
const route = (task: string, override: Partial<AgentRoutingSettings> = {}, catalog = providers) =>
  resolveAgentRouting({
    settings: { ...settings, ...override },
    current: backend,
    task,
    providers: catalog,
  });

describe("agent routing policy", () => {
  it("honors the model lock even when a different task rule matches", () => {
    expect(route("Design the UI", { mode: "single", singleModel: backend }).selection).toEqual(
      backend,
    );
  });
  it("never silently replaces an unavailable locked model", () => {
    expect(() => route("Design", { mode: "single", singleModel: design }, [providers[0]!])).toThrow(
      "locked model is unavailable",
    );
  });
  it("does not match short UI phrases inside unrelated words", () => {
    expect(route("Build an API query").selection).toEqual(backend);
    expect(route("Redesign front-end navigation").selection.instanceId).toBe(design.instanceId);
  });
  it("uses priority-specific effort and does not equate thorough with max", () => {
    expect(route("Design the UI", { priority: "fast" }).selection.options).toEqual([
      { id: "effort", value: "medium" },
    ]);
    expect(route("Design the UI", { priority: "thorough" }).selection.options).toEqual([
      { id: "effort", value: "high" },
    ]);
  });
  it("refuses unsupported configured effort", () => {
    expect(() =>
      route("Design", {
        rules: [
          { ...settings.rules[0]!, efforts: { fast: "max", balanced: "max", thorough: "max" } },
        ],
      }),
    ).toThrow("unavailable");
  });
  it("uses only an explicitly configured available fallback with its own options", () => {
    expect(() => route("Design", {}, [providers[0]!])).toThrow("no available fallback");
    const fallback = { ...backend, options: [{ id: "effort", value: "medium" }] };
    expect(
      route("Design", { rules: [{ ...settings.rules[0]!, fallback }] }, [providers[0]!]).selection,
    ).toEqual(fallback);
  });
  it("manual mode preserves the exact user's model and effort", () => {
    expect(route("Design", { mode: "manual" }).selection).toEqual(backend);
  });
  it("keeps direct execution explicit and carries the evolving brief instruction", () => {
    const instruction = agentExecutionInstructions(settings);
    expect(instruction).toContain("Do not spawn sub-agents");
    expect(instruction).toContain("one evolving brief");
  });
});
