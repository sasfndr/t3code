import type {
  AgentRoutingEfforts,
  AgentRoutingRule,
  AgentRoutingSettings,
  ModelSelection,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";

/** Enabled routes in the shape the router prompt needs. */
export function routerRoutes(settings: AgentRoutingSettings) {
  return settings.rules
    .filter((rule) => rule.enabled)
    .map((rule) => ({ id: rule.id, name: rule.name, description: routeDescription(rule) }));
}

/** What a route handles; routes saved before descriptions existed describe themselves by their old keywords. */
export function routeDescription(rule: Pick<AgentRoutingRule, "description" | "match">): string {
  if (rule.description.trim()) return rule.description.trim();
  return rule.match.length ? `Work involving ${rule.match.join(", ")}.` : "";
}

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
  /** The router model's one-line explanation, when a router chose the route. */
  readonly routerReason?: string;
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

/** The route the router model chose for a task. `ruleId: null` means no route fits. */
export interface AgentRouteChoice {
  readonly ruleId: string | null;
  readonly reason?: string;
}

/**
 * Turn a route choice into the exact model and effort to run. The choice itself comes from the
 * router model (or a delegating parent naming a specialist); this function is pure so the server
 * and the settings preview agree. Efforts are user-owned preferences, not benchmark claims.
 */
export function resolveAgentRouting(input: {
  readonly settings: AgentRoutingSettings;
  readonly current: ModelSelection;
  readonly providers: readonly ServerProvider[];
  /** Required in Auto mode; ignored by Manual and One model. */
  readonly choice?: AgentRouteChoice;
}): AgentRoutingDecision {
  const { settings, current, providers } = input;
  if (settings.mode === "manual") {
    return {
      selection: current,
      reason: "Manual model selection",
      source: "manual",
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
      usedFallback: false,
    };
  }

  const choice = input.choice ?? { ruleId: null };
  const routerReason = choice.reason ? { routerReason: choice.reason } : {};
  const picked =
    choice.ruleId === null
      ? null
      : (() => {
          const rule = settings.rules.find((entry) => entry.id === choice.ruleId && entry.enabled);
          if (!rule) throw new Error(`Route “${choice.ruleId}” is missing or turned off.`);
          return { rule };
        })();

  if (!picked) {
    const route = settings.defaultRoute;
    if (!route) {
      return {
        selection: current,
        reason: `Stayed on ${modelName(providers, current)} · no route fit`,
        source: "unmatched",
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
      usedFallback: false,
      ...(applied.effort ? { effort: applied.effort } : {}),
    };
  }

  const { rule } = picked;
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
    usedFallback: !primaryAvailable,
    ...routerReason,
    ...(applied.effort ? { effort: applied.effort } : {}),
  };
}
