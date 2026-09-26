import {
  type AgentRoutePreviewResult,
  type AgentRoutingRule,
  type AgentRoutingSettings,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  findRoutingModel,
  isRoutingSelectionAvailable,
  routeDescription,
  routingEffortDescriptor,
} from "@t3tools/shared/agentRouting";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  CornerDownRightIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ComponentProps, type KeyboardEvent, type ReactNode, useMemo, useState } from "react";

import { cn, randomUUID } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import {
  PriorityMeter,
  ROUTE_TEMPLATES,
  ROUTER_DRIVERS,
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
import { Spinner } from "../ui/spinner";
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
const DEFAULT_EFFORT = "default";

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
  const environmentId = environment?.environmentId ?? null;
  return {
    providers,
    entries,
    optionsByInstance,
    environmentId,
    disabled: connectedEnvironments.length === 0,
    openProviderSetup: environmentId
      ? (instanceId: ProviderInstanceId) =>
          void navigate({ to: "/settings/providers", search: { environmentId, instanceId } })
      : undefined,
  };
}
type RoutingCatalog = ReturnType<typeof useRoutingCatalog>;

/** T3's own model picker: every connected provider and account, with icons and search. */
function RouteModelPicker({
  catalog,
  selection,
  onChange,
  label,
  disabledReason,
}: {
  catalog: RoutingCatalog;
  selection: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
  label?: string;
  disabledReason?: (instanceId: ProviderInstanceId) => string | null;
}) {
  const fallbackEntry = catalog.entries.find((entry) => entry.enabled && entry.isAvailable);
  const activeInstanceId = selection?.instanceId ?? fallbackEntry?.instanceId;
  if (!activeInstanceId) {
    return <span className="text-sm text-muted-foreground">Add a provider first.</span>;
  }
  return (
    <ProviderModelPicker
      activeInstanceId={activeInstanceId}
      model={selection?.model ?? ""}
      lockedProvider={null}
      instanceEntries={catalog.entries}
      modelOptionsByInstance={catalog.optionsByInstance}
      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
      disabled={catalog.disabled}
      {...(label ? { triggerLabel: label } : {})}
      {...(disabledReason ? { getModelDisabledReason: (id) => disabledReason(id) } : {})}
      {...(catalog.openProviderSetup ? { onOpenProviderSetup: catalog.openProviderSetup } : {})}
      onInstanceModelChange={(instanceId, model) =>
        onChange(createModelSelection(instanceId, model))
      }
    />
  );
}

function ModelIdentity({
  providers,
  selection,
  effort,
  className,
}: {
  providers: readonly ServerProvider[];
  selection: ModelSelection;
  effort?: string | undefined;
  className?: string;
}) {
  const found = findRoutingModel(providers, selection);
  const available = isRoutingSelectionAvailable(selection, providers);
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-xs", className)}>
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
      {!available ? (
        <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" aria-label="Unavailable" />
      ) : null}
    </span>
  );
}

/**
 * Effort per priority, as a ladder: one row per priority, each a segmented choice of the efforts
 * this model actually offers. Replaces three dropdowns with something you can read at a glance.
 */
function EffortLadder({
  providers,
  selection,
  efforts,
  activePriority,
  disabled,
  onChange,
}: {
  providers: readonly ServerProvider[];
  selection: ModelSelection;
  efforts: Efforts;
  activePriority: AgentRoutingSettings["priority"];
  disabled: boolean;
  onChange: (efforts: Efforts) => void;
}) {
  const descriptor = routingEffortDescriptor(findRoutingModel(providers, selection)?.model);
  if (!descriptor) {
    return (
      <p className="text-xs text-muted-foreground">
        This model has no effort setting, so every priority runs it at its default.
      </p>
    );
  }
  return (
    <div className="grid gap-1.5">
      {ROUTING_PRIORITIES.map((priority) => {
        const value = efforts[priority.value] || DEFAULT_EFFORT;
        const active = priority.value === activePriority;
        return (
          <div
            key={priority.value}
            className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3"
          >
            <span
              className={cn(
                "flex items-center gap-1.5 text-xs",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <PriorityMeter level={priority.level} />
              {priority.label}
            </span>
            <div className="min-w-0 overflow-x-auto">
              <ToggleGroup
                aria-label={`${priority.label} effort`}
                value={[value]}
                disabled={disabled}
                onValueChange={(next) => {
                  const choice = next[0];
                  if (!choice) return;
                  onChange({
                    ...efforts,
                    [priority.value]: choice === DEFAULT_EFFORT ? "" : choice,
                  });
                }}
              >
                <Toggle value={DEFAULT_EFFORT}>Default</Toggle>
                {descriptor.options.map((option) => (
                  <Toggle key={option.id} value={option.id}>
                    {option.label}
                  </Toggle>
                ))}
              </ToggleGroup>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** One effort choice (One model, Everything else). */
function EffortSelect({
  providers,
  selection,
  value,
  onChange,
  label,
}: {
  providers: readonly ServerProvider[];
  selection: ModelSelection;
  value: string;
  onChange: (effort: string) => void;
  label: string;
}) {
  const descriptor = routingEffortDescriptor(findRoutingModel(providers, selection)?.model);
  if (!descriptor) return null;
  return (
    <Select
      value={value || DEFAULT_EFFORT}
      onValueChange={(next) => onChange(next === DEFAULT_EFFORT || !next ? "" : next)}
    >
      <SelectTrigger size="sm" aria-label={label} className="w-36">
        <SelectValue>
          {value ? effortLabel(providers, selection, value) : "Default effort"}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end">
        <SelectItem value={DEFAULT_EFFORT}>Default effort</SelectItem>
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
    const nextIndex = (index + step + ROUTING_MODES.length) % ROUTING_MODES.length;
    onChange(ROUTING_MODES[nextIndex]!.value);
    (event.currentTarget.parentElement?.children[nextIndex] as HTMLElement | undefined)?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Routing mode" className="grid gap-1.5 p-2 sm:grid-cols-3">
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
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid min-w-0 gap-1.5", className)}>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-foreground/80">{label}</span>
        {hint ? <span className="text-xs text-muted-foreground/70">{hint}</span> : null}
      </span>
      {children}
    </div>
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
  const found = findRoutingModel(providers, rule.selection);
  return (
    <div className="border-t border-border/60 first:border-t-0">
      <div className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
        <Switch
          checked={rule.enabled}
          disabled={catalog.disabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
          aria-label={`Use ${rule.name}`}
        />
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggleExpanded}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-start outline-none",
            !rule.enabled && "opacity-60",
          )}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.05] dark:bg-foreground/[0.08]">
            {found ? (
              <ProviderInstanceIcon
                driverKind={found.provider.driver}
                displayName={found.provider.displayName ?? found.provider.driver}
                iconClassName="size-4"
              />
            ) : (
              <TriangleAlertIcon className="size-4 text-warning" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm text-foreground">{rule.name}</span>
            </span>
            <span className="block truncate text-xs text-muted-foreground/80">
              {routeDescription(rule) || "Describe what this route handles"}
            </span>
          </span>
          <span className="hidden max-w-[42%] sm:flex">
            <ModelIdentity
              providers={providers}
              selection={rule.selection}
              effort={rule.efforts[priority] || undefined}
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
        <div className="grid gap-5 px-3 pt-1 pb-4 sm:ps-19 sm:pe-4">
          <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
            <Field label="Name">
              <DraftInput
                size="sm"
                value={rule.name}
                aria-label="Route name"
                onCommit={(name) => name.trim() && onChange({ name: name.trim() })}
              />
            </Field>
            <Field label="Handles" hint="The router reads this">
              <CommitTextarea
                value={routeDescription(rule)}
                rows={2}
                maxLength={2000}
                placeholder="e.g. UI, UX, visual design, product feel and frontend code."
                onCommit={(description) => onChange({ description })}
              />
            </Field>
          </div>
          <Field label="Model">
            <div className="flex flex-wrap items-center gap-2">
              <RouteModelPicker
                catalog={catalog}
                selection={rule.selection}
                onChange={(selection) => onChange({ selection, efforts: EMPTY_EFFORTS })}
              />
            </div>
          </Field>
          <Field label="Effort by priority" hint="Highlighted row is active now">
            <EffortLadder
              providers={providers}
              selection={rule.selection}
              efforts={rule.efforts}
              activePriority={priority}
              disabled={catalog.disabled}
              onChange={(efforts) => onChange({ efforts })}
            />
          </Field>
          <Field label="If this model is unavailable">
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
                    Remove
                  </Button>
                </>
              ) : (
                <>
                  <span className="text-sm text-muted-foreground">Stop and tell me, or</span>
                  <RouteModelPicker
                    catalog={catalog}
                    selection={null}
                    label="Use a fallback"
                    onChange={(fallback) => onChange({ fallback })}
                  />
                </>
              )}
            </div>
          </Field>
          <div className="flex items-center justify-between gap-2">
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

/** Runs the real router on a sample task, exactly as a sent message would be routed. */
function RoutePreview({
  value,
  catalog,
}: {
  value: AgentRoutingSettings;
  catalog: RoutingCatalog;
}) {
  const previewRoute = useAtomCommand(serverEnvironment.previewRoute, { reportFailure: false });
  const [task, setTask] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AgentRoutePreviewResult | { error: string } | null>(null);
  const canRun =
    !pending && !catalog.disabled && task.trim().length > 0 && catalog.environmentId !== null;
  const run = async () => {
    if (!canRun || !catalog.environmentId) return;
    setPending(true);
    try {
      const outcome = await previewRoute({
        environmentId: catalog.environmentId,
        input: { settings: { ...value, mode: "auto" }, task: task.trim() },
      });
      setResult(
        outcome._tag === "Success"
          ? outcome.value
          : { error: "Could not reach the router. Check the environment connection." },
      );
    } finally {
      setPending(false);
    }
  };
  const routeName = (ruleId: string | null) =>
    value.rules.find((rule) => rule.id === ruleId)?.name ?? "Everything else";
  return (
    <div className="grid gap-2.5 px-3 py-3 sm:px-4">
      <div className="flex gap-2">
        <input
          value={task}
          onChange={(event) => setTask(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) void run();
          }}
          placeholder="Describe a task, e.g. “Redesign the pricing page and add a billing API”"
          aria-label="Sample task"
          className="h-8.5 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-sm outline-none placeholder:text-placeholder sm:h-7.5 dark:bg-input/32"
        />
        <Button size="sm" variant="outline" disabled={!canRun} onClick={() => void run()}>
          {pending ? <Spinner className="size-3.5" /> : <SparklesIcon />}
          Route it
        </Button>
      </div>
      <div className="flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {!result ? (
          <span className="text-muted-foreground/70">
            Uses your router model, so it takes a few seconds and one small request.
          </span>
        ) : "error" in result ? (
          <span className="flex items-center gap-1.5 text-warning">
            <TriangleAlertIcon className="size-3.5" />
            {result.error}
          </span>
        ) : (
          <>
            <span className="text-muted-foreground">{routeName(result.ruleId)}</span>
            <CornerDownRightIcon className="size-3.5 text-muted-foreground/60" />
            {result.selection ? (
              <ModelIdentity
                providers={catalog.providers}
                selection={result.selection}
                effort={result.effort ?? undefined}
              />
            ) : (
              <span className="text-muted-foreground">
                {result.problem ?? "Keeps the conversation's current model"}
              </span>
            )}
            {result.usedFallback ? <span className="text-warning">fallback</span> : null}
            {result.routerReason ? (
              <span className="basis-full text-muted-foreground/80">{result.routerReason}</span>
            ) : null}
            {result.selection && result.problem ? (
              <span className="basis-full text-warning">{result.problem}</span>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function RouterRow({
  value,
  catalog,
  update,
}: {
  value: AgentRoutingSettings;
  catalog: RoutingCatalog;
  update: (patch: Partial<AgentRoutingSettings>) => void;
}) {
  const routerCapable = (instanceId: ProviderInstanceId) => {
    const driver = catalog.providers.find((entry) => entry.instanceId === instanceId)?.driver;
    return driver && ROUTER_DRIVERS.has(driver)
      ? null
      : "Only Claude, Codex and Grok models can route tasks.";
  };
  return (
    <>
      <SettingsRow
        serverScoped
        settingKeys={ROUTING_KEYS}
        {...searchableSetting("orchestrator-router")}
        title="Router"
        description="Reads each message and picks the route. A small, fast model keeps sending quick."
        control={
          <RouteModelPicker
            catalog={catalog}
            selection={value.router}
            {...(value.router ? {} : { label: "Choose router" })}
            disabledReason={routerCapable}
            onChange={(router) => update({ router })}
          />
        }
      />
      {!value.router ? (
        <p className="flex items-center gap-1.5 border-t border-border/60 px-3 py-2.5 text-xs text-warning sm:px-4">
          <TriangleAlertIcon className="size-3.5 shrink-0" />
          Choose a router. Until then, every task goes to Everything else.
        </p>
      ) : null}
    </>
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
              base && { ...base, name: "New route", description: "", efforts: EMPTY_EFFORTS },
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
              No routes yet. Start from your usual split, then pick models and efforts.
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
          description="When no route fits, or the router can't answer."
          control={
            <div className="flex flex-wrap items-center justify-end gap-1.5">
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
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => update({ defaultRoute: null })}
                  >
                    Keep current
                  </Button>
                </>
              ) : (
                <RouteModelPicker
                  catalog={catalog}
                  selection={null}
                  label="Keep current model"
                  onChange={(selection) =>
                    update({ defaultRoute: { selection, efforts: EMPTY_EFFORTS } })
                  }
                />
              )}
            </div>
          }
        />
      </SettingsSection>
      <SettingsSection title="Try the router">
        <RoutePreview value={value} catalog={catalog} />
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
  const locked = value.singleModel;
  const lockedDescriptor = locked
    ? routingEffortDescriptor(findRoutingModel(providers, locked)?.model)
    : null;
  const lockedEffort = locked?.options?.find((option) => option.id === lockedDescriptor?.id)?.value;

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
          <>
            <RouterRow value={value} catalog={catalog} update={update} />
            <SettingsRow
              serverScoped
              settingKeys={ROUTING_KEYS}
              {...searchableSetting("orchestrator-priority")}
              title="Priority"
              description="Each route decides what effort a priority buys. Thorough isn't automatically max."
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
          </>
        ) : null}
        {value.mode === "single" ? (
          <SettingsRow
            serverScoped
            settingKeys={ROUTING_KEYS}
            title="Model"
            description="Also used for sub-agents, titles and commit messages."
            control={
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <RouteModelPicker
                  catalog={catalog}
                  selection={locked}
                  onChange={(singleModel) => update({ singleModel })}
                />
                {locked && lockedDescriptor ? (
                  <EffortSelect
                    providers={providers}
                    selection={locked}
                    label="Locked effort"
                    value={typeof lockedEffort === "string" ? lockedEffort : ""}
                    onChange={(effort) =>
                      update({
                        singleModel: {
                          ...locked,
                          options: [
                            ...(locked.options ?? []).filter(
                              (option) => option.id !== lockedDescriptor.id,
                            ),
                            ...(effort ? [{ id: lockedDescriptor.id, value: effort }] : []),
                          ],
                        },
                      })
                    }
                  />
                ) : null}
              </div>
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

      <SettingsSection {...searchableSetting("orchestrator-execution")} title="Sub-agents">
        <SettingsRow
          serverScoped
          settingKeys={ROUTING_KEYS}
          title="Delegation"
          description={
            value.mode === "manual"
              ? "Available in Auto and One model."
              : value.delegation === "direct"
                ? "The assigned agent does all the work itself."
                : value.delegation === "auto"
                  ? "Hands scoped pieces to specialists when it helps. The router picks each one's route."
                  : "Splits substantial work across specialists by default, each on its route's model."
          }
          control={
            <ToggleGroup
              aria-label="Delegation"
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
        <div className="grid gap-2 border-t border-border/60 px-3 py-3 sm:px-4">
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
