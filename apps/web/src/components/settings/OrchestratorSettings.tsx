import {
  type AgentRoutingRule,
  type AgentRoutingSettings,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  findRoutingModel,
  isRoutingSelectionAvailable,
  resolveAgentRouting,
  routingEffortDescriptor,
} from "@t3tools/shared/agentRouting";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";
import type { ComponentProps } from "react";

import { randomUUID, cn } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import {
  PriorityMeter,
  ROUTE_TEMPLATES,
  ROUTING_MODES,
  ROUTING_PRIORITIES,
  effortLabel,
  routingModelName,
  ruleFromTemplate,
} from "../orchestrator/orchestratorUi";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

type Efforts = AgentRoutingRule["efforts"];
const EMPTY_EFFORTS: Efforts = { fast: "", balanced: "", thorough: "" };
const ROUTING_KEYS = ["agentRouting"] as const;

/** Everything the routing editors need about the selected environment's providers. */
function useRoutingCatalog() {
  const { environment, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const navigate = useNavigate();
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const optionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers),
    [providers, settings],
  );
  const environmentId = environment?.environmentId;
  return {
    providers,
    entries,
    optionsByInstance,
    disabled: connectedEnvironments.length === 0,
    openProviderSetup: environmentId
      ? (instanceId: ProviderInstanceId) =>
          void navigate({ to: "/settings/providers", search: { environmentId, instanceId } })
      : undefined,
  };
}
type RoutingCatalog = ReturnType<typeof useRoutingCatalog>;

function RouteModelPicker({
  catalog,
  selection,
  onChange,
  label,
}: {
  catalog: RoutingCatalog;
  selection: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
  label?: string;
}) {
  const fallbackEntry = catalog.entries.find((entry) => entry.enabled && entry.isAvailable);
  return (
    <ProviderModelPicker
      activeInstanceId={
        selection?.instanceId ?? fallbackEntry?.instanceId ?? catalog.entries[0]!.instanceId
      }
      model={selection?.model ?? ""}
      lockedProvider={null}
      instanceEntries={catalog.entries}
      modelOptionsByInstance={catalog.optionsByInstance}
      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
      disabled={catalog.disabled}
      {...(label ? { triggerLabel: label } : {})}
      {...(catalog.openProviderSetup ? { onOpenProviderSetup: catalog.openProviderSetup } : {})}
      onInstanceModelChange={(instanceId, model) =>
        onChange(createModelSelection(instanceId, model))
      }
    />
  );
}

/** Effort choice for one model. Hidden when the model has no effort control. */
function EffortSelect({
  providers,
  selection,
  value,
  onChange,
  label,
  compact = false,
}: {
  providers: readonly ServerProvider[];
  selection: ModelSelection;
  value: string;
  onChange: (effort: string) => void;
  label: string;
  compact?: boolean;
}) {
  const descriptor = routingEffortDescriptor(findRoutingModel(providers, selection)?.model);
  if (!descriptor) {
    return <span className="text-xs text-muted-foreground/70">No effort setting</span>;
  }
  const unsupported = value !== "" && !descriptor.options.some((option) => option.id === value);
  return (
    <Select
      value={value || "default"}
      onValueChange={(next) => onChange(next === "default" || !next ? "" : next)}
    >
      <SelectTrigger
        size="sm"
        aria-label={label}
        aria-invalid={unsupported || undefined}
        className={compact ? "w-full min-w-0" : "w-40"}
      >
        <SelectValue>
          {value ? effortLabel(providers, selection, value) : "Model default"}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end">
        <SelectItem value="default">Model default</SelectItem>
        {descriptor.options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ModeChooser({
  value,
  disabled,
  onChange,
}: {
  value: AgentRoutingSettings["mode"];
  disabled: boolean;
  onChange: (mode: AgentRoutingSettings["mode"]) => void;
}) {
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = ROUTING_MODES[(index + step + ROUTING_MODES.length) % ROUTING_MODES.length]!;
    onChange(next.value);
    (
      event.currentTarget.parentElement?.children[ROUTING_MODES.indexOf(next)] as
        | HTMLElement
        | undefined
    )?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label="Routing mode"
      className="grid gap-1.5 p-2 sm:grid-cols-3 sm:p-2.5"
    >
      {ROUTING_MODES.map((mode, index) => {
        const selected = mode.value === value;
        const Icon = mode.icon;
        return (
          <button
            key={mode.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(mode.value)}
            onKeyDown={(event) => move(event, index)}
            className={cn(
              "group flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-start outline-none transition-colors disabled:pointer-events-none disabled:opacity-64",
              selected
                ? "border-border bg-foreground/[0.06] text-foreground dark:bg-foreground/[0.08]"
                : "border-transparent text-muted-foreground hover:bg-foreground/[0.035] hover:text-foreground/85",
            )}
          >
            <span
              className={cn(
                "mt-px flex size-6 shrink-0 items-center justify-center rounded-md transition-colors",
                selected
                  ? "bg-foreground text-background"
                  : "bg-foreground/[0.06] text-muted-foreground group-hover:text-foreground/80",
              )}
            >
              <Icon className="size-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium leading-6">{mode.label}</span>
              <span className="block text-xs leading-snug text-muted-foreground">
                {mode.description}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Words that send a task to this route. Enter or comma adds; Backspace on an empty field removes the last. */
function PhraseField({
  phrases,
  onChange,
}: {
  phrases: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const additions = raw
      .split(",")
      .map((phrase) => phrase.trim())
      .filter(
        (phrase) =>
          phrase && !phrases.some((existing) => existing.toLowerCase() === phrase.toLowerCase()),
      );
    if (additions.length) onChange([...phrases, ...additions]);
    setDraft("");
  };
  return (
    <div className="flex min-h-8.5 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-background px-1.5 py-1 text-sm shadow-xs/5 dark:bg-input/32 sm:min-h-7.5">
      {phrases.map((phrase) => (
        <span
          key={phrase}
          className="inline-flex h-6 items-center gap-0.5 rounded-md bg-foreground/[0.06] ps-2 pe-0.5 text-xs text-foreground/85 dark:bg-foreground/[0.09]"
        >
          {phrase}
          <button
            type="button"
            aria-label={`Remove ${phrase}`}
            onClick={() => onChange(phrases.filter((entry) => entry !== phrase))}
            className="flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-foreground/[0.08] hover:text-foreground"
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        aria-label="Add phrase"
        placeholder={phrases.length ? "Add phrase" : "e.g. frontend, design, UI"}
        onChange={(event) => {
          const value = event.target.value;
          if (value.includes(",")) add(value);
          else setDraft(value);
        }}
        onBlur={() => draft.trim() && add(draft)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            add(draft);
          } else if (event.key === "Backspace" && !draft && phrases.length) {
            onChange(phrases.slice(0, -1));
          }
        }}
        className="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-placeholder"
      />
    </div>
  );
}

/** Textarea that saves on blur, so long edits do not write settings on every keystroke. */
function CommitTextarea({
  value,
  onCommit,
  ...props
}: Omit<ComponentProps<typeof Textarea>, "value" | "onChange" | "onBlur"> & {
  value: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Textarea
      {...props}
      value={draft ?? value}
      onFocus={() => setDraft(value)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = draft ?? value;
        setDraft(null);
        if (next !== value) onCommit(next);
      }}
    />
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid min-w-0 gap-1.5", className)}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function RouteSummary({
  providers,
  selection,
  effort,
}: {
  providers: readonly ServerProvider[];
  selection: ModelSelection;
  effort: string;
}) {
  const found = findRoutingModel(providers, selection);
  const available = isRoutingSelectionAvailable(selection, providers);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {found ? (
        <ProviderInstanceIcon
          driverKind={found.provider.driver}
          displayName={found.provider.displayName ?? found.provider.driver}
          iconClassName="size-3.5"
        />
      ) : null}
      <span className={cn("truncate", available ? "text-foreground/80" : "text-warning")}>
        {routingModelName(providers, selection)}
      </span>
      {effort ? (
        <span className="shrink-0">· {effortLabel(providers, selection, effort)}</span>
      ) : null}
      {!available ? (
        <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" aria-label="Unavailable" />
      ) : null}
    </span>
  );
}

function RouteCard({
  rule,
  index,
  count,
  priority,
  catalog,
  expanded,
  onToggleExpanded,
  onChange,
  onMove,
  onRemove,
}: {
  rule: AgentRoutingRule;
  index: number;
  count: number;
  priority: AgentRoutingSettings["priority"];
  catalog: RoutingCatalog;
  expanded: boolean;
  onToggleExpanded: () => void;
  onChange: (patch: Partial<AgentRoutingRule>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const { providers } = catalog;
  return (
    <div
      className={cn(
        "border-t border-border/60 first:border-t-0",
        !rule.enabled && "[&_[data-route-head]]:opacity-60",
      )}
    >
      <div className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
        <Switch
          checked={rule.enabled}
          disabled={catalog.disabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
          aria-label={`Use ${rule.name}`}
        />
        <button
          type="button"
          data-route-head
          aria-expanded={expanded}
          onClick={onToggleExpanded}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-start outline-none"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-foreground">{rule.name}</span>
            <span className="block truncate text-xs text-muted-foreground/80">
              {rule.match.length ? rule.match.join(", ") : "No phrases yet"}
            </span>
          </span>
          <span className="hidden max-w-[45%] sm:flex">
            <RouteSummary
              providers={providers}
              selection={rule.selection}
              effort={rule.efforts[priority]}
            />
          </span>
          <ChevronDownIcon
            className={cn(
              "size-4 shrink-0 text-muted-foreground/70 transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
      </div>
      {expanded ? (
        <div className="grid gap-4 px-3 pt-1 pb-4 sm:ps-15 sm:pe-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
            <Field label="Name">
              <DraftInput
                size="sm"
                value={rule.name}
                aria-label="Route name"
                onCommit={(name) => name.trim() && onChange({ name: name.trim() })}
              />
            </Field>
            <Field label="Matches tasks mentioning">
              <PhraseField phrases={rule.match} onChange={(match) => onChange({ match })} />
            </Field>
          </div>
          <Field label="Use for">
            <CommitTextarea
              value={rule.description}
              rows={2}
              maxLength={2000}
              placeholder="What this route is for. Delegating agents read this to pick a specialist."
              onCommit={(description) => onChange({ description })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-end">
            <Field label="Model">
              <RouteModelPicker
                catalog={catalog}
                selection={rule.selection}
                onChange={(selection) => onChange({ selection, efforts: EMPTY_EFFORTS })}
              />
            </Field>
            {!routingEffortDescriptor(findRoutingModel(providers, rule.selection)?.model) ? (
              <p className="pb-2 text-xs text-muted-foreground">
                This model has no effort setting, so every priority uses its default.
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {ROUTING_PRIORITIES.map((entry) => (
                  <Field
                    key={entry.value}
                    label={entry.label}
                    className={cn(
                      entry.value === priority && "[&>span:first-child]:text-foreground",
                    )}
                  >
                    <EffortSelect
                      compact
                      providers={providers}
                      selection={rule.selection}
                      value={rule.efforts[entry.value]}
                      label={`${entry.label} effort for ${rule.name}`}
                      onChange={(effort) =>
                        onChange({ efforts: { ...rule.efforts, [entry.value]: effort } })
                      }
                    />
                  </Field>
                ))}
              </div>
            )}
          </div>
          <Field label="If the model is unavailable">
            <div className="flex flex-wrap items-center gap-2">
              {rule.fallback ? (
                <>
                  <RouteModelPicker
                    catalog={catalog}
                    selection={rule.fallback}
                    onChange={(fallback) => onChange({ fallback })}
                  />
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => onChange({ fallback: null })}
                  >
                    Remove fallback
                  </Button>
                </>
              ) : (
                <>
                  <span className="text-sm text-muted-foreground">Stop and tell me.</span>
                  <RouteModelPicker
                    catalog={catalog}
                    selection={null}
                    label="Add fallback"
                    onChange={(fallback) => onChange({ fallback })}
                  />
                </>
              )}
            </div>
          </Field>
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex items-center gap-1">
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Move up"
                disabled={index === 0}
                onClick={() => onMove(-1)}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Move down"
                disabled={index === count - 1}
                onClick={() => onMove(1)}
              >
                <ArrowDownIcon />
              </Button>
              <span className="ps-1 text-xs text-muted-foreground/70">Order breaks ties</span>
            </div>
            <Button size="xs" variant="ghost-destructive" onClick={onRemove}>
              <Trash2Icon />
              Delete route
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Type a task and see exactly where Auto would send it, using the same resolver as the server. */
function RoutePreview({
  value,
  providers,
}: {
  value: AgentRoutingSettings;
  providers: readonly ServerProvider[];
}) {
  const [task, setTask] = useState("");
  const outcome = useMemo(() => {
    if (!task.trim()) return null;
    const current = value.defaultRoute?.selection ?? value.rules[0]?.selection;
    if (!current) return null;
    try {
      return { decision: resolveAgentRouting({ settings: value, current, task, providers }) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Could not route this task." };
    }
  }, [providers, task, value]);
  const decision = outcome && "decision" in outcome ? outcome.decision : null;
  return (
    <div className="grid gap-2.5 px-3 py-3 sm:px-4">
      <input
        value={task}
        onChange={(event) => setTask(event.target.value)}
        placeholder="Try a task, e.g. “Redesign the pricing page layout”"
        aria-label="Sample task"
        className="h-8.5 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none placeholder:text-placeholder dark:bg-input/32 sm:h-7.5"
      />
      <div className="flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {!outcome ? (
          <span className="text-muted-foreground/70">
            The route, model and effort appear here as you type.
          </span>
        ) : "error" in outcome ? (
          <span className="flex items-center gap-1.5 text-warning">
            <TriangleAlertIcon className="size-3.5" />
            {outcome.error}
          </span>
        ) : decision ? (
          <>
            <RouteSummary
              providers={providers}
              selection={decision.selection}
              effort={decision.effort ?? ""}
            />
            <span className="text-muted-foreground">
              {decision.source === "rule"
                ? `via ${decision.ruleName}${decision.usedFallback ? " (fallback)" : ""}`
                : decision.source === "default"
                  ? "via Everything else"
                  : "no route matched, keeps the current model"}
            </span>
            {decision.matched.length ? (
              <span className="text-muted-foreground/70">
                matched {decision.matched.map((phrase) => `“${phrase}”`).join(", ")}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function RoutesSection({
  value,
  catalog,
  update,
}: {
  value: AgentRoutingSettings;
  catalog: RoutingCatalog;
  update: (patch: Partial<AgentRoutingSettings>) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const { providers } = catalog;
  const changeRule = (id: string, patch: Partial<AgentRoutingRule>) =>
    update({ rules: value.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)) });
  const addRule = (rule: AgentRoutingRule | null) => {
    if (!rule) return;
    update({ rules: [...value.rules, rule] });
    setExpanded(rule.id);
  };
  const unmatchedDefault = value.defaultRoute;
  const addMenu = (
    <Menu>
      <MenuTrigger
        render={
          <Button size="xs" variant="ghost-muted" disabled={catalog.disabled}>
            <PlusIcon />
            Add route
          </Button>
        }
      />
      <MenuPopup align="end">
        {ROUTE_TEMPLATES.map((template) => (
          <MenuItem
            key={template.id}
            onClick={() => addRule(ruleFromTemplate(template, providers, randomUUID()))}
          >
            {template.name}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          onClick={() => {
            const base = ruleFromTemplate(ROUTE_TEMPLATES[0]!, providers, randomUUID());
            addRule(
              base && {
                ...base,
                name: "New route",
                description: "",
                match: [],
                efforts: EMPTY_EFFORTS,
              },
            );
          }}
        >
          Blank route
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
  return (
    <>
      <SettingsSection
        {...searchableSetting("orchestrator-routes")}
        title="Routes"
        headerAction={addMenu}
      >
        {value.rules.length === 0 ? (
          <div className="flex flex-col items-start gap-2 px-3 py-4 sm:px-4">
            <p className="text-sm text-muted-foreground">
              No routes yet. Start from your usual split, then adjust phrases and models.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={catalog.disabled}
              onClick={() =>
                update({
                  rules: ROUTE_TEMPLATES.slice(0, 2).flatMap(
                    (template) => ruleFromTemplate(template, providers, template.id) ?? [],
                  ),
                })
              }
            >
              Add design and backend routes
            </Button>
          </div>
        ) : (
          value.rules.map((rule, index) => (
            <RouteCard
              key={rule.id}
              rule={rule}
              index={index}
              count={value.rules.length}
              priority={value.priority}
              catalog={catalog}
              expanded={expanded === rule.id}
              onToggleExpanded={() => setExpanded(expanded === rule.id ? null : rule.id)}
              onChange={(patch) => changeRule(rule.id, patch)}
              onMove={(delta) => {
                const rules = [...value.rules];
                const [moved] = rules.splice(index, 1);
                rules.splice(index + delta, 0, moved!);
                update({ rules });
              }}
              onRemove={() => {
                update({ rules: value.rules.filter((entry) => entry.id !== rule.id) });
                setExpanded(null);
              }}
            />
          ))
        )}
        <SettingsRow
          title="Everything else"
          description="Tasks no route matches."
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <Select
                value={unmatchedDefault ? "model" : "keep"}
                disabled={catalog.disabled}
                onValueChange={(choice) => {
                  if (choice === "keep") update({ defaultRoute: null });
                  else if (!unmatchedDefault) {
                    const selection = value.rules[0]?.selection ?? value.singleModel;
                    const fallback = catalog.entries.find(
                      (entry) => entry.enabled && entry.isAvailable,
                    );
                    const model = fallback
                      ? catalog.optionsByInstance.get(fallback.instanceId)?.[0]
                      : undefined;
                    const next =
                      selection ??
                      (fallback && model
                        ? createModelSelection(fallback.instanceId, model.slug)
                        : null);
                    if (next) update({ defaultRoute: { selection: next, efforts: EMPTY_EFFORTS } });
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-auto">
                  <SelectValue>
                    {unmatchedDefault ? "Use a model" : "Keep current model"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  <SelectItem value="keep">Keep current model</SelectItem>
                  <SelectItem value="model">Use a model</SelectItem>
                </SelectPopup>
              </Select>
              {unmatchedDefault ? (
                <>
                  <RouteModelPicker
                    catalog={catalog}
                    selection={unmatchedDefault.selection}
                    onChange={(selection) =>
                      update({ defaultRoute: { selection, efforts: EMPTY_EFFORTS } })
                    }
                  />
                  <EffortSelect
                    providers={providers}
                    selection={unmatchedDefault.selection}
                    value={unmatchedDefault.efforts[value.priority]}
                    label={`Effort for everything else at ${value.priority} priority`}
                    onChange={(effort) =>
                      update({
                        defaultRoute: {
                          ...unmatchedDefault,
                          efforts: { ...unmatchedDefault.efforts, [value.priority]: effort },
                        },
                      })
                    }
                  />
                </>
              ) : null}
            </div>
          }
        />
      </SettingsSection>
      <SettingsSection title="Test a task">
        <RoutePreview value={value} providers={providers} />
      </SettingsSection>
    </>
  );
}

function LimitField({
  label,
  value,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <NumberField
        value={value}
        min={1}
        max={max}
        step={1}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== null && Number.isInteger(next) && next >= 1 && next <= max) onChange(next);
        }}
      >
        <NumberFieldGroup className="w-20">
          <NumberFieldInput aria-label={label} />
        </NumberFieldGroup>
      </NumberField>
    </div>
  );
}

export function OrchestratorSettingsPanel() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const catalog = useRoutingCatalog();
  const value = settings.agentRouting;
  const update = (patch: Partial<AgentRoutingSettings>) =>
    updateSettings({ agentRouting: { ...value, ...patch } });
  const { disabled, providers } = catalog;
  const hasModels = catalog.entries.length > 0;
  const locked = value.singleModel;

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("orchestrator")} title="Routing">
        <ModeChooser
          value={value.mode}
          disabled={disabled}
          onChange={(mode) => {
            if (mode === "single" && !value.singleModel) {
              const first = value.rules[0]?.selection ?? value.defaultRoute?.selection ?? null;
              update({ mode, singleModel: first });
            } else update({ mode });
          }}
        />
        {value.mode === "auto" ? (
          <SettingsRow
            serverScoped
            settingKeys={ROUTING_KEYS}
            {...searchableSetting("orchestrator-priority")}
            title="Priority"
            description="Each route sets the effort a priority uses. Thorough is not automatically max."
            control={
              <ToggleGroup
                aria-label="Priority"
                value={[value.priority]}
                disabled={disabled}
                onValueChange={(next) => {
                  const priority = ROUTING_PRIORITIES.find((entry) => entry.value === next[0]);
                  if (priority) update({ priority: priority.value });
                }}
              >
                {ROUTING_PRIORITIES.map((entry) => (
                  <Toggle key={entry.value} value={entry.value}>
                    <PriorityMeter level={entry.level} />
                    {entry.label}
                  </Toggle>
                ))}
              </ToggleGroup>
            }
          />
        ) : null}
        {value.mode === "single" ? (
          <SettingsRow
            serverScoped
            settingKeys={ROUTING_KEYS}
            title="Model"
            description="Also used for sub-agents, titles and commit messages."
            control={
              hasModels ? (
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <RouteModelPicker
                    catalog={catalog}
                    selection={locked}
                    onChange={(singleModel) => update({ singleModel })}
                  />
                  {locked ? (
                    <EffortSelect
                      providers={providers}
                      selection={locked}
                      label="Locked effort"
                      value={
                        (locked.options?.find((option) => {
                          const descriptor = routingEffortDescriptor(
                            findRoutingModel(providers, locked)?.model,
                          );
                          return option.id === descriptor?.id;
                        })?.value as string | undefined) ?? ""
                      }
                      onChange={(effort) => {
                        const descriptor = routingEffortDescriptor(
                          findRoutingModel(providers, locked)?.model,
                        );
                        if (!descriptor) return;
                        update({
                          singleModel: {
                            ...locked,
                            options: [
                              ...(locked.options ?? []).filter(
                                (option) => option.id !== descriptor.id,
                              ),
                              ...(effort ? [{ id: descriptor.id, value: effort }] : []),
                            ],
                          },
                        });
                      }}
                    />
                  ) : null}
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">Add a provider first.</span>
              )
            }
          />
        ) : null}
        {value.mode === "single" && locked && !isRoutingSelectionAvailable(locked, providers) ? (
          <p className="flex items-center gap-1.5 px-3 py-2.5 text-xs text-warning sm:px-4">
            <TriangleAlertIcon className="size-3.5" />
            This model is unavailable, so messages will stop until you pick another.
          </p>
        ) : null}
      </SettingsSection>

      {value.mode === "auto" ? (
        <RoutesSection value={value} catalog={catalog} update={update} />
      ) : null}

      <SettingsSection {...searchableSetting("orchestrator-execution")} title="Execution">
        <SettingsRow
          serverScoped
          settingKeys={ROUTING_KEYS}
          title="Sub-agents"
          description={
            value.mode === "manual"
              ? "Available in Auto and One model."
              : value.delegation === "direct"
                ? "The assigned agent does all the work itself."
                : value.delegation === "auto"
                  ? "Splits off scoped tasks when it helps, each to its route's model."
                  : "Splits substantial separable work across specialists by default."
          }
          control={
            <ToggleGroup
              aria-label="Sub-agents"
              value={[value.delegation]}
              disabled={disabled || value.mode === "manual"}
              onValueChange={(next) => {
                const delegation = next[0];
                if (delegation === "direct" || delegation === "auto" || delegation === "always")
                  update({ delegation });
              }}
            >
              <Toggle value="direct">Off</Toggle>
              <Toggle value="auto">When useful</Toggle>
              <Toggle value="always">Preferred</Toggle>
            </ToggleGroup>
          }
        />
        {value.mode !== "manual" && value.delegation !== "direct" ? (
          <SettingsRow
            title="Limits"
            description="Caps T3 enforces on delegated agents."
            control={
              <div className="flex items-end gap-2">
                <LimitField
                  label="At once"
                  value={value.maxConcurrentAgents}
                  max={16}
                  disabled={disabled}
                  onChange={(maxConcurrentAgents) => update({ maxConcurrentAgents })}
                />
                <LimitField
                  label="Per task"
                  value={value.maxAgentsPerTask}
                  max={32}
                  disabled={disabled}
                  onChange={(maxAgentsPerTask) => update({ maxAgentsPerTask })}
                />
                <LimitField
                  label="Depth"
                  value={value.maxDepth}
                  max={4}
                  disabled={disabled}
                  onChange={(maxDepth) => update({ maxDepth })}
                />
              </div>
            }
          />
        ) : null}
        <SettingsRow
          serverScoped
          settingKeys={ROUTING_KEYS}
          {...searchableSetting("orchestrator-queue")}
          title="Combine queued messages"
          description="Messages sent while an agent works go together as one brief."
          control={
            <Switch
              checked={value.groupQueuedMessages}
              disabled={disabled}
              onCheckedChange={(groupQueuedMessages) => update({ groupQueuedMessages })}
            />
          }
        />
        <div className="grid gap-2 px-3 py-3 sm:px-4">
          <div>
            <h3 className="text-sm text-foreground">Standing instructions</h3>
            <p className="text-xs text-muted-foreground">Added to every routed task.</p>
          </div>
          <CommitTextarea
            value={value.instructions}
            disabled={disabled}
            rows={3}
            maxLength={16000}
            placeholder="e.g. Always run the type checker before finishing."
            onCommit={(instructions) => update({ instructions })}
          />
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
