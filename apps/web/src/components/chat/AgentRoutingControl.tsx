import type { AgentRoutingSettings, ModelSelection, ServerProvider } from "@t3tools/contracts";
import {
  findRoutingModel,
  isRoutingSelectionAvailable,
  routingEffortDescriptor,
} from "@t3tools/shared/agentRouting";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import {
  PriorityMeter,
  ROUTING_MODES,
  ROUTING_PRIORITIES,
  effortLabel,
  routingModelName,
  routingPriorityLevel,
} from "../orchestrator/orchestratorUi";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ComposerControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

const MAX_LISTED_ROUTES = 4;

function ModelLine({
  providers,
  selection,
  effort,
  className,
}: {
  providers: readonly ServerProvider[];
  selection: ModelSelection;
  effort: string | undefined;
  className?: string;
}) {
  const found = findRoutingModel(providers, selection);
  const available = isRoutingSelectionAvailable(selection, providers);
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {found ? (
        <ProviderInstanceIcon
          driverKind={found.provider.driver}
          displayName={found.provider.displayName ?? found.provider.driver}
          iconClassName="size-3.5"
        />
      ) : null}
      <span className={cn("truncate", available ? "text-foreground/85" : "text-warning")}>
        {routingModelName(providers, selection)}
      </span>
      {effort ? (
        <span className="shrink-0 text-muted-foreground">
          {effortLabel(providers, selection, effort)}
        </span>
      ) : null}
    </span>
  );
}

function lockedEffort(providers: readonly ServerProvider[], selection: ModelSelection) {
  const descriptor = routingEffortDescriptor(findRoutingModel(providers, selection)?.model);
  const value = selection.options?.find((option) => option.id === descriptor?.id)?.value;
  return typeof value === "string" ? value : undefined;
}

/**
 * Composer entry to the orchestrator: switch Manual / Auto / One model and, in Auto, the priority.
 * Everything finer lives on the Orchestrator settings page.
 */
export function AgentRoutingControl({
  value,
  model,
  providers,
  onChange,
}: {
  value: AgentRoutingSettings;
  model: ModelSelection;
  providers: readonly ServerProvider[];
  onChange: (value: AgentRoutingSettings) => void;
}) {
  const navigate = useNavigate();
  const popupProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  const active = ROUTING_MODES.find((mode) => mode.value === value.mode) ?? ROUTING_MODES[0]!;
  const ActiveIcon = active.icon;
  const routes = value.rules.filter((rule) => rule.enabled);
  const setMode = (mode: AgentRoutingSettings["mode"]) =>
    onChange({
      ...value,
      mode,
      ...(mode === "single" ? { singleModel: value.singleModel ?? model } : {}),
    });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ComposerControl
            size="xs"
            aria-label={`Routing: ${active.label}`}
            data-routing-mode={value.mode}
          />
        }
      >
        <ActiveIcon data-composer-control-icon />
        {value.mode === "manual" ? null : <span>{active.short}</span>}
        {value.mode === "auto" ? (
          <PriorityMeter level={routingPriorityLevel(value.priority)} className="opacity-80" />
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="start" side="top" padding="none" className="w-76" {...popupProps}>
        <div className="p-1.5" role="radiogroup" aria-label="Routing mode">
          {ROUTING_MODES.map((mode) => {
            const selected = mode.value === value.mode;
            const Icon = mode.icon;
            return (
              <button
                key={mode.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setMode(mode.value)}
                className={cn(
                  "flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.75 text-start outline-none transition-colors hover:bg-accent",
                  selected && "bg-foreground/[0.06] dark:bg-foreground/[0.08]",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-5.5 shrink-0 items-center justify-center rounded-md",
                    selected
                      ? "bg-foreground text-background"
                      : "bg-foreground/[0.06] text-muted-foreground",
                  )}
                >
                  <Icon className="size-3.25" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm leading-6 text-foreground">{mode.label}</span>
                  <span className="block text-xs leading-snug text-muted-foreground">
                    {mode.description}
                  </span>
                </span>
                {selected ? (
                  <CheckIcon className="mt-1.5 size-3.5 shrink-0 text-foreground" />
                ) : null}
              </button>
            );
          })}
        </div>

        {value.mode === "auto" ? (
          <div className="grid gap-2.5 border-t border-border/70 px-3 py-2.5">
            <ToggleGroup
              aria-label="Priority"
              value={[value.priority]}
              className="w-full"
              onValueChange={(next) => {
                const priority = ROUTING_PRIORITIES.find((entry) => entry.value === next[0]);
                if (priority) onChange({ ...value, priority: priority.value });
              }}
            >
              {ROUTING_PRIORITIES.map((entry) => (
                <Toggle key={entry.value} value={entry.value} className="flex-1">
                  <PriorityMeter level={entry.level} />
                  {entry.label}
                </Toggle>
              ))}
            </ToggleGroup>
            {value.router ? (
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted-foreground">Router</span>
                <ModelLine
                  providers={providers}
                  selection={value.router}
                  effort={undefined}
                  className="max-w-[62%] justify-end"
                />
              </div>
            ) : (
              <p className="text-xs text-warning">
                Choose a router model in settings so Auto can pick routes.
              </p>
            )}
            {routes.length ? (
              <ul className="grid gap-1 text-xs">
                {routes.slice(0, MAX_LISTED_ROUTES).map((rule) => (
                  <li key={rule.id} className="flex items-center justify-between gap-3">
                    <span className="truncate text-muted-foreground">{rule.name}</span>
                    <ModelLine
                      providers={providers}
                      selection={rule.selection}
                      effort={rule.efforts[value.priority] || undefined}
                      className="max-w-[62%] justify-end"
                    />
                  </li>
                ))}
                {routes.length > MAX_LISTED_ROUTES ? (
                  <li className="text-muted-foreground/70">
                    +{routes.length - MAX_LISTED_ROUTES} more
                  </li>
                ) : null}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">
                No routes yet, so every task goes to Everything else.
              </p>
            )}
          </div>
        ) : null}

        {value.mode === "single" && value.singleModel ? (
          <div className="grid gap-1 border-t border-border/70 px-3 py-2.5 text-xs">
            <ModelLine
              providers={providers}
              selection={value.singleModel}
              effort={lockedEffort(providers, value.singleModel)}
            />
            <span className="text-muted-foreground/80">
              Choosing a model in the picker changes the lock.
            </span>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => {
            setOpen(false);
            void navigate({ to: "/settings/orchestrator" });
          }}
          className="flex w-full cursor-pointer items-center justify-between border-t border-border/70 px-3 py-2 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground"
        >
          Orchestrator settings
          <ChevronRightIcon className="size-3.5" />
        </button>
      </PopoverPopup>
    </Popover>
  );
}
