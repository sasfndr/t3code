import type { AgentRoutingSettings, ModelSelection, ServerProvider } from "@t3tools/contracts";
import {
  findRoutingModel,
  isRoutingSelectionAvailable,
  routingEffortDescriptor,
} from "@t3tools/shared/agentRouting";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

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
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ComposerControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

const MAX_LISTED_ROUTES = 5;

/** Equal-width segmented choice. Owned here so the popover never clips or wraps a label. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; content: ReactNode; title?: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="grid gap-0.5 rounded-lg bg-foreground/[0.05] p-0.5 dark:bg-foreground/[0.07]"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.title}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex h-7 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-md px-1.5 text-xs outline-none transition-colors",
              selected
                ? "bg-background text-foreground shadow-xs/10 dark:bg-foreground/[0.12]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.content}
          </button>
        );
      })}
    </div>
  );
}

function SectionLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 pb-1.5">
      <span className="text-xs font-medium text-muted-foreground/70">{children}</span>
      {aside}
    </div>
  );
}

/** Provider mark, model name and effort, truncating the name before anything else. */
function ModelTag({
  providers,
  selection,
  effort,
}: {
  providers: readonly ServerProvider[];
  selection: ModelSelection;
  effort: string | undefined;
}) {
  const found = findRoutingModel(providers, selection);
  const available = isRoutingSelectionAvailable(selection, providers);
  return (
    <span className="flex min-w-0 items-center justify-end gap-1.5">
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
        <span className="shrink-0 rounded-sm bg-foreground/[0.06] px-1 text-muted-foreground dark:bg-foreground/[0.09]">
          {effortLabel(providers, selection, effort)}
        </span>
      ) : null}
      {!available ? <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" /> : null}
    </span>
  );
}

function lockedEffort(providers: readonly ServerProvider[], selection: ModelSelection) {
  const descriptor = routingEffortDescriptor(findRoutingModel(providers, selection)?.model);
  const value = selection.options?.find((option) => option.id === descriptor?.id)?.value;
  return typeof value === "string" ? value : undefined;
}

/**
 * Composer entry to the orchestrator: mode and, in Auto, priority, with the current route map at a
 * glance. Everything finer lives on Settings → Orchestrator.
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
      <PopoverPopup align="start" side="top" padding="none" className="w-84" {...popupProps}>
        <div className="grid gap-2 p-3">
          <Segmented
            label="Routing mode"
            value={value.mode}
            onChange={setMode}
            options={ROUTING_MODES.map((mode) => {
              const Icon = mode.icon;
              return {
                value: mode.value,
                title: mode.label,
                content: (
                  <>
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">{mode.short}</span>
                  </>
                ),
              };
            })}
          />
          <p className="px-0.5 text-xs leading-snug text-muted-foreground">{active.description}</p>
        </div>

        {value.mode === "auto" ? (
          <>
            <div className="border-t border-border/60 px-3 pt-2.5 pb-3">
              <SectionLabel>Priority</SectionLabel>
              <Segmented
                label="Priority"
                value={value.priority}
                onChange={(priority) => onChange({ ...value, priority })}
                options={ROUTING_PRIORITIES.map((entry) => ({
                  value: entry.value,
                  content: (
                    <>
                      <PriorityMeter level={entry.level} className="shrink-0" />
                      <span className="truncate">{entry.label}</span>
                    </>
                  ),
                }))}
              />
            </div>
            <div className="border-t border-border/60 px-3 pt-2.5 pb-3">
              <SectionLabel
                aside={
                  value.router ? (
                    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground/80">
                      <span className="shrink-0">Router</span>
                      <span className="min-w-0 max-w-32">
                        <ModelTag
                          providers={providers}
                          selection={value.router}
                          effort={undefined}
                        />
                      </span>
                    </span>
                  ) : null
                }
              >
                Routes
              </SectionLabel>
              {!value.router ? (
                <p className="flex items-start gap-1.5 pb-2 text-xs text-warning">
                  <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
                  Pick a router in settings so Auto can choose routes.
                </p>
              ) : null}
              {routes.length ? (
                <ul className="grid gap-1.5 text-xs">
                  {routes.slice(0, MAX_LISTED_ROUTES).map((rule) => (
                    <li
                      key={rule.id}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(0,auto)] items-center gap-3"
                    >
                      <span className="truncate text-foreground/80">{rule.name}</span>
                      <ModelTag
                        providers={providers}
                        selection={rule.selection}
                        effort={rule.efforts[value.priority] || undefined}
                      />
                    </li>
                  ))}
                  <li className="grid grid-cols-[minmax(0,1fr)_minmax(0,auto)] items-center gap-3 text-muted-foreground">
                    <span className="truncate">Everything else</span>
                    {value.defaultRoute ? (
                      <ModelTag
                        providers={providers}
                        selection={value.defaultRoute.selection}
                        effort={value.defaultRoute.efforts[value.priority] || undefined}
                      />
                    ) : (
                      <span className="truncate">Current model</span>
                    )}
                  </li>
                  {routes.length > MAX_LISTED_ROUTES ? (
                    <li className="text-muted-foreground/70">
                      +{routes.length - MAX_LISTED_ROUTES} more in settings
                    </li>
                  ) : null}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No routes yet, so every task stays on the current model.
                </p>
              )}
            </div>
          </>
        ) : null}

        {value.mode === "single" && value.singleModel ? (
          <div className="border-t border-border/60 px-3 pt-2.5 pb-3 text-xs">
            <SectionLabel>Locked to</SectionLabel>
            <div className="flex justify-start">
              <ModelTag
                providers={providers}
                selection={value.singleModel}
                effort={lockedEffort(providers, value.singleModel)}
              />
            </div>
            <p className="pt-1.5 text-muted-foreground/80">
              Pick another model in the model picker to change the lock.
            </p>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => {
            setOpen(false);
            void navigate({ to: "/settings/orchestrator" });
          }}
          className="flex w-full cursor-pointer items-center justify-between border-t border-border/60 px-3 py-2.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground"
        >
          Orchestrator settings
          <ChevronRightIcon className="size-3.5" />
        </button>
      </PopoverPopup>
    </Popover>
  );
}
