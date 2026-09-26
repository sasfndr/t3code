import type { AgentRoutingSettings, ModelSelection, ServerProvider } from "@t3tools/contracts";

export interface AgentRoutingDecision {
  readonly selection: ModelSelection;
  readonly reason: string;
  readonly ruleId?: string;
}

function available(selection: ModelSelection, providers: readonly ServerProvider[]): boolean {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  return (
    !!provider &&
    provider.enabled &&
    provider.installed &&
    provider.status !== "error" &&
    provider.availability !== "unavailable" &&
    provider.auth.status !== "unauthenticated" &&
    provider.models.some(
      (model) => model.slug === selection.model || model.aliases?.includes(selection.model),
    )
  );
}

/** Preferences, not benchmark claims. Rule order and every effort choice are user-owned. */
export function resolveAgentRouting(input: {
  readonly settings: AgentRoutingSettings;
  readonly current: ModelSelection;
  readonly task: string;
  readonly providers: readonly ServerProvider[];
}): AgentRoutingDecision {
  const { settings, current, providers } = input;
  if (settings.mode === "manual") return { selection: current, reason: "Manual model selection" };
  if (settings.mode === "single") {
    if (!settings.singleModel)
      throw new Error("Choose a model in Orchestrator settings before using single-model mode.");
    if (!available(settings.singleModel, providers))
      throw new Error(
        "The locked model is unavailable. Update the model lock in Orchestrator settings.",
      );
    return { selection: settings.singleModel, reason: "Single-model lock" };
  }
  const task = input.task.toLocaleLowerCase();
  const rule = settings.rules.find(
    (entry) =>
      entry.enabled &&
      entry.match.some((phrase) => {
        const escaped = phrase.toLocaleLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u").test(task);
      }),
  );
  if (!rule)
    return { selection: current, reason: "No routing rule matched; keeping the selected model" };
  const primaryAvailable = available(rule.selection, providers);
  const selection = primaryAvailable ? rule.selection : rule.fallback;
  if (!selection || !available(selection, providers)) {
    throw new Error(
      `The model for “${rule.name}” is unavailable and no available fallback is configured.`,
    );
  }
  const model = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find(
      (entry) => entry.slug === selection.model || entry.aliases?.includes(selection.model),
    );
  const desiredEffort = rule.efforts[settings.priority];
  const effortDescriptor = model?.capabilities?.optionDescriptors?.find(
    (option) =>
      ["reasoningEffort", "reasoning_effort", "effort", "thinking", "thought_level"].includes(
        option.id,
      ) && option.type === "select",
  );
  // Never silently clamp an unsupported effort or apply the primary's effort to a different fallback.
  if (primaryAvailable && desiredEffort && effortDescriptor?.type === "select") {
    if (!effortDescriptor.options.some((choice) => choice.id === desiredEffort)) {
      throw new Error(
        `“${desiredEffort}” effort is unavailable for ${model?.name}. Update “${rule.name}” in Orchestrator settings.`,
      );
    }
    return {
      selection: {
        ...selection,
        options: [
          ...(selection.options ?? []).filter((option) => option.id !== effortDescriptor.id),
          { id: effortDescriptor.id, value: desiredEffort },
        ],
      },
      reason: `${rule.name} · ${settings.priority} · ${desiredEffort}`,
      ruleId: rule.id,
    };
  }
  return {
    selection,
    reason: `${rule.name}${primaryAvailable ? "" : " · configured fallback"}`,
    ruleId: rule.id,
  };
}

export function agentExecutionInstructions(settings: AgentRoutingSettings): string {
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
      ? `Available routing rules: ${settings.rules
          .filter((rule) => rule.enabled)
          .map((rule) => `${rule.id}: ${rule.name}`)
          .join(
            "; ",
          )}. Agent limits: ${settings.maxConcurrentAgents} concurrent, ${settings.maxAgentsPerTask} per task, depth ${settings.maxDepth}.`
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
