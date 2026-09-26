import type {
  AgentRoutingPriority,
  AgentRoutingRule,
  AgentRoutingSettings,
  ModelSelection,
  ServerProvider,
} from "@t3tools/contracts";
import {
  findRoutingModel,
  isRoutingSelectionAvailable,
  routingEffortDescriptor,
} from "@t3tools/shared/agentRouting";
import { LockIcon, SlidersHorizontalIcon, WaypointsIcon, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";

export type RoutingMode = AgentRoutingSettings["mode"];

export const ROUTING_MODES: ReadonlyArray<{
  value: RoutingMode;
  label: string;
  short: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    value: "manual",
    label: "Manual",
    short: "Manual",
    description: "You pick the model for every message.",
    icon: SlidersHorizontalIcon,
  },
  {
    value: "auto",
    label: "Auto",
    short: "Auto",
    description: "Each task goes to the model your routes choose.",
    icon: WaypointsIcon,
  },
  {
    value: "single",
    label: "One model",
    short: "Locked",
    description: "Every task and sub-agent runs on one model.",
    icon: LockIcon,
  },
];

export const ROUTING_PRIORITIES: ReadonlyArray<{
  value: AgentRoutingPriority;
  label: string;
  level: 1 | 2 | 3;
}> = [
  { value: "fast", label: "Fast", level: 1 },
  { value: "balanced", label: "Balanced", level: 2 },
  { value: "thorough", label: "Thorough", level: 3 },
];

export function routingPriorityLevel(priority: AgentRoutingPriority): 1 | 2 | 3 {
  return ROUTING_PRIORITIES.find((entry) => entry.value === priority)?.level ?? 2;
}

/** Three ascending bars; filled bars show how much effort the priority buys. Static, never animated. */
export function PriorityMeter({ level, className }: { level: 1 | 2 | 3; className?: string }) {
  return (
    <span aria-hidden className={cn("inline-flex h-2.5 items-end gap-0.5", className)}>
      {[1, 2, 3].map((bar) => (
        <span
          key={bar}
          className={cn(
            "w-[3px] rounded-xs",
            bar === 1 ? "h-1" : bar === 2 ? "h-[7px]" : "h-2.5",
            bar <= level ? "bg-current" : "bg-current opacity-25",
          )}
        />
      ))}
    </span>
  );
}

export const capitalize = (value: string) =>
  value ? value.charAt(0).toUpperCase() + value.slice(1) : value;

/** The effort label the model shows for an option id, e.g. "xhigh" → "Extra high". */
export function effortLabel(
  providers: readonly ServerProvider[],
  selection: Pick<ModelSelection, "instanceId" | "model">,
  effort: string,
): string {
  const descriptor = routingEffortDescriptor(findRoutingModel(providers, selection)?.model);
  return descriptor?.options.find((option) => option.id === effort)?.label ?? capitalize(effort);
}

export function routingModelName(
  providers: readonly ServerProvider[],
  selection: Pick<ModelSelection, "instanceId" | "model">,
): string {
  return findRoutingModel(providers, selection)?.model.name ?? selection.model;
}

// Starting points for new routes. Phrases and efforts are editable preferences, not claims about
// which model is objectively best.
interface RouteTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly match: readonly string[];
  readonly drivers: readonly string[];
  readonly models: readonly string[];
  readonly efforts: AgentRoutingRule["efforts"];
}

export const ROUTE_TEMPLATES: readonly RouteTemplate[] = [
  {
    id: "design",
    name: "Design & frontend",
    description: "UI, UX, visual design, product feel, copy and frontend code.",
    match: [
      "frontend",
      "front-end",
      "design",
      "redesign",
      "UI",
      "UX",
      "layout",
      "CSS",
      "styling",
      "typography",
      "animation",
      "component",
      "landing page",
      "copy",
    ],
    drivers: ["claudeAgent"],
    models: ["claude-opus-5-5"],
    efforts: { fast: "medium", balanced: "high", thorough: "high" },
  },
  {
    id: "backend",
    name: "Backend & agentic",
    description: "APIs, data, infrastructure, integrations and long agentic builds.",
    match: [
      "backend",
      "back-end",
      "API",
      "database",
      "schema",
      "migration",
      "server",
      "infrastructure",
      "auth",
      "queue",
      "worker",
      "integration",
      "orchestrator",
    ],
    drivers: ["codex"],
    models: ["gpt-6-astra"],
    efforts: { fast: "medium", balanced: "high", thorough: "high" },
  },
  {
    id: "debugging",
    name: "Tests & debugging",
    description: "Failing tests, bugs, regressions, CI and type errors.",
    match: ["test", "tests", "bug", "debug", "failing", "regression", "CI", "lint", "typecheck"],
    drivers: ["codex"],
    models: ["gpt-6-astra"],
    efforts: { fast: "medium", balanced: "medium", thorough: "high" },
  },
  {
    id: "research",
    name: "Research & answers",
    description: "Questions, explanations, comparisons and quick lookups.",
    match: ["research", "explain", "compare", "summarize", "summarise", "look up", "question"],
    drivers: ["grok", "kimi", "claudeAgent"],
    models: [],
    efforts: { fast: "low", balanced: "medium", thorough: "high" },
  },
];

/** Keep only efforts the chosen model actually offers; the rest fall back to the model default. */
export function supportedEfforts(
  providers: readonly ServerProvider[],
  selection: ModelSelection,
  efforts: AgentRoutingRule["efforts"],
): AgentRoutingRule["efforts"] {
  const descriptor = routingEffortDescriptor(findRoutingModel(providers, selection)?.model);
  const keep = (effort: string) =>
    descriptor?.options.some((option) => option.id === effort) ? effort : "";
  return {
    fast: keep(efforts.fast),
    balanced: keep(efforts.balanced),
    thorough: keep(efforts.thorough),
  };
}

function templateSelection(
  template: RouteTemplate,
  providers: readonly ServerProvider[],
): ModelSelection | null {
  const usable = providers.filter((provider) =>
    provider.models.some((model) =>
      isRoutingSelectionAvailable(
        { instanceId: provider.instanceId, model: model.slug },
        providers,
      ),
    ),
  );
  for (const driver of template.drivers) {
    const provider = usable.find((entry) => entry.driver === driver);
    if (!provider) continue;
    const model =
      template.models
        .map((slug) => provider.models.find((entry) => entry.slug === slug))
        .find(Boolean) ?? provider.models[0];
    if (model) return { instanceId: provider.instanceId, model: model.slug };
  }
  const first = usable[0];
  return first?.models[0] ? { instanceId: first.instanceId, model: first.models[0].slug } : null;
}

export function ruleFromTemplate(
  template: RouteTemplate,
  providers: readonly ServerProvider[],
  id: string,
): AgentRoutingRule | null {
  const selection = templateSelection(template, providers);
  if (!selection) return null;
  return {
    id,
    name: template.name,
    description: template.description,
    enabled: true,
    match: [...template.match],
    selection,
    efforts: supportedEfforts(providers, selection, template.efforts),
    fallback: null,
  };
}
