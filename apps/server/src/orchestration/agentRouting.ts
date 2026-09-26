import type { AgentRoutingSettings, ServerProvider } from "@t3tools/contracts";
import { findRoutingModel } from "@t3tools/shared/agentRouting";

export { resolveAgentRouting, type AgentRoutingDecision } from "@t3tools/shared/agentRouting";

/** Instructions prepended to routed turns. `providers` lets the parent see which model backs each specialist. */
export function agentExecutionInstructions(
  settings: AgentRoutingSettings,
  providers: readonly ServerProvider[] = [],
): string {
  if (settings.mode === "manual" && !settings.instructions) return "";
  return [
    "<task_execution_preferences>",
    "Treat consecutive user messages as one evolving brief. Preserve the overall objective, corrections, constraints, and acceptance criteria. Finish the authorized task and verify the result.",
    settings.delegation === "direct"
      ? "Execute the work directly. Do not spawn sub-agents."
      : "Use the t3-code agent_task tool for delegated work so T3 applies routing, model locks, file ownership, and limits. Do not use native sub-agent tools or launch other model CLIs to bypass that policy. Give each agent the relevant context, dependencies, and acceptance criteria. Read and verify delegated results before claiming completion.",
    settings.delegation === "always"
      ? "Prefer delegating substantial separable implementation tasks; carry trivial work out directly."
      : "",
    settings.delegation !== "direct"
      ? [
          "Specialists (pass the ruleId to agent_task to assign one):",
          ...settings.rules
            .filter((rule) => rule.enabled)
            .map((rule) => {
              const model =
                settings.mode === "single"
                  ? null
                  : (findRoutingModel(providers, rule.selection)?.model.name ??
                    rule.selection.model);
              return `- ${rule.id}: ${rule.name}${model ? ` (${model})` : ""}${rule.description ? ` — ${rule.description}` : ""}`;
            }),
          `Agent limits: ${settings.maxConcurrentAgents} concurrent, ${settings.maxAgentsPerTask} per task, depth ${settings.maxDepth}.`,
        ].join("\n")
      : "",
    settings.mode === "single"
      ? "The user has locked execution to one model. Do not select a different model or provider for any delegated work."
      : "",
    settings.instructions,
    "</task_execution_preferences>",
  ]
    .filter(Boolean)
    .join("\n");
}
