import type {
  AgentRoutingEfforts,
  AgentRoutingRule,
  AgentRoutingSettings,
  ModelSelection,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";

/** Option ids providers use for their reasoning-effort select. */
export const ROUTING_EFFORT_OPTION_IDS: ReadonlySet<string> = new Set([
  "effort",
  "reasoningEffort",
  "reasoning_effort",
  "thinking",
  "thought_level",
]);

export type AgentRoutingSource = "manual" | "lock" | "rule" | "default" | "unmatched";

export interface AgentRoutingDecision {
  readonly selection: ModelSelection;
  /** One-line, user-facing explanation. Rendered in the thread's work log. */
  readonly reason: string;
  readonly source: AgentRoutingSource;
  readonly ruleId?: string;
  readonly ruleName?: string;
  /** Phrases from the winning rule that appeared in the task. */
  readonly matched: readonly string[];
  readonly effort?: string;
  readonly usedFallback: boolean;
}

export function findRoutingModel(
  providers: readonly ServerProvider[],
  selection: Pick<ModelSelection, "instanceId" | "model">,
): { provider: ServerProvider; model: ServerProviderModel } | null {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  const model = provider?.models.find(
    (entry) => entry.slug === selection.model || entry.aliases?.includes(selection.model),
  );
  return provider && model ? { provider, model } : null;
}

export function routingEffortDescriptor(model: ServerProviderModel | undefined) {
  const descriptor = model?.capabilities?.optionDescriptors?.find((option) =>
    ROUTING_EFFORT_OPTION_IDS.has(option.id),
  );
  return descriptor?.type === "select" ? descriptor : null;
}

export function isRoutingSelectionAvailable(
  selection: ModelSelection,
  providers: readonly ServerProvider[],
): boolean {
  const found = findRoutingModel(providers, selection);
  if (!found) return false;
  const { provider } = found;
  return (
    provider.enabled &&
    provider.installed &&
    provider.status !== "error" &&
    provider.availability !== "unavailable" &&
    provider.auth.status !== "unauthenticated"
  );
}

function phraseMatches(task: string, phrase: string): boolean {
  const escaped = phrase.toLocaleLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u").test(task);
}

/** Distinct phrases of `rule` found in `task`, as whole words and case-insensitively. */
export function matchRoutingRule(rule: AgentRoutingRule, task: string): string[] {
  const lower = task.toLocaleLowerCase();
  const seen = new Set<string>();
  return rule.match.filter((phrase) => {
    const key = phrase.toLocaleLowerCase();
    if (seen.has(key) || !phraseMatches(lower, phrase)) return false;
    seen.add(key);
    return true;
  });
}

// Multi-word phrases are more specific than single words, so they weigh a little more.
const phraseWeight = (phrase: string) => 1 + (phrase.trim().split(/\s+/).length - 1) * 0.5;

/** The enabled rule with the highest phrase score; earlier rules win ties. */
export function pickRoutingRule(
  rules: readonly AgentRoutingRule[],
  task: string,
): { rule: AgentRoutingRule; matched: string[] } | null {
  let best: { rule: AgentRoutingRule; matched: string[]; score: number } | null = null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const matched = matchRoutingRule(rule, task);
    if (matched.length === 0) continue;
    const score = matched.reduce((total, phrase) => total + phraseWeight(phrase), 0);
    if (!best || score > best.score) best = { rule, matched, score };
  }
  return best ? { rule: best.rule, matched: best.matched } : null;
}

function modelName(providers: readonly ServerProvider[], selection: ModelSelection): string {
  return findRoutingModel(providers, selection)?.model.name ?? selection.model;
}

/**
 * Apply the priority's effort to `selection`. An empty effort keeps the model default. An effort the
 * model does not offer is an error, never a silent clamp.
 */
function applyEffort(
  selection: ModelSelection,
  efforts: AgentRoutingEfforts,
  settings: AgentRoutingSettings,
  providers: readonly ServerProvider[],
  owner: string,
): { selection: ModelSelection; effort?: string } {
  const effort = efforts[settings.priority];
  const found = findRoutingModel(providers, selection);
  const descriptor = routingEffortDescriptor(found?.model);
  if (!effort || !descriptor) return { selection };
  if (!descriptor.options.some((choice) => choice.id === effort)) {
    throw new Error(
      `“${effort}” effort is unavailable for ${found?.model.name ?? selection.model}. Update “${owner}” in Orchestrator settings.`,
    );
  }
  return {
    selection: {
      ...selection,
      options: [
        ...(selection.options ?? []).filter((option) => option.id !== descriptor.id),
        { id: descriptor.id, value: effort },
      ],
    },
    effort,
  };
}

const withEffortLabel = (name: string, effort: string | undefined) =>
  effort ? `${name} · ${effort}` : name;

/**
 * Preferences, not benchmark claims. Rule order, phrases and every effort choice are user-owned.
 * `ruleId` forces a specific specialist (delegated work) instead of matching the task text.
 */
export function resolveAgentRouting(input: {
  readonly settings: AgentRoutingSettings;
  readonly current: ModelSelection;
  readonly task: string;
  readonly providers: readonly ServerProvider[];
  readonly ruleId?: string;
}): AgentRoutingDecision {
  const { settings, current, providers } = input;
  if (settings.mode === "manual") {
    return {
      selection: current,
      reason: "Manual model selection",
      source: "manual",
      matched: [],
      usedFallback: false,
    };
  }
  if (settings.mode === "single") {
    if (!settings.singleModel)
      throw new Error("Choose a model in Orchestrator settings before using single-model mode.");
    if (!isRoutingSelectionAvailable(settings.singleModel, providers))
      throw new Error(
        "The locked model is unavailable. Update the model lock in Orchestrator settings.",
      );
    return {
      selection: settings.singleModel,
      reason: `Locked to ${modelName(providers, settings.singleModel)}`,
      source: "lock",
      matched: [],
      usedFallback: false,
    };
  }

  const picked =
    input.ruleId !== undefined
      ? (() => {
          const rule = settings.rules.find((entry) => entry.id === input.ruleId && entry.enabled);
          if (!rule) throw new Error(`Routing rule “${input.ruleId}” is missing or disabled.`);
          return { rule, matched: [] as string[] };
        })()
      : pickRoutingRule(settings.rules, input.task);

  if (!picked) {
    const route = settings.defaultRoute;
    if (!route) {
      return {
        selection: current,
        reason: `No route matched · kept ${modelName(providers, current)}`,
        source: "unmatched",
        matched: [],
        usedFallback: false,
      };
    }
    if (!isRoutingSelectionAvailable(route.selection, providers))
      throw new Error(
        "The default route's model is unavailable. Update it in Orchestrator settings.",
      );
    const applied = applyEffort(
      route.selection,
      route.efforts,
      settings,
      providers,
      "Default route",
    );
    return {
      selection: applied.selection,
      reason: `Routed to ${withEffortLabel(modelName(providers, route.selection), applied.effort)} · Default route`,
      source: "default",
      matched: [],
      usedFallback: false,
      ...(applied.effort ? { effort: applied.effort } : {}),
    };
  }

  const { rule, matched } = picked;
  const primaryAvailable = isRoutingSelectionAvailable(rule.selection, providers);
  if (
    !primaryAvailable &&
    (!rule.fallback || !isRoutingSelectionAvailable(rule.fallback, providers))
  )
    throw new Error(
      `The model for “${rule.name}” is unavailable and no available fallback is configured.`,
    );
  // A fallback keeps its own saved options; the primary's efforts may not exist on another model.
  const applied = primaryAvailable
    ? applyEffort(rule.selection, rule.efforts, settings, providers, rule.name)
    : { selection: rule.fallback! };
  const name = modelName(providers, applied.selection);
  return {
    selection: applied.selection,
    reason: `Routed to ${withEffortLabel(name, applied.effort)} · ${rule.name}${primaryAvailable ? "" : " (fallback)"}`,
    source: "rule",
    ruleId: rule.id,
    ruleName: rule.name,
    matched,
    usedFallback: !primaryAvailable,
    ...(applied.effort ? { effort: applied.effort } : {}),
  };
}
