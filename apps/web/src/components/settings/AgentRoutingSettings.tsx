import { searchableSetting } from "./settingsSearch";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import {
  ProviderInstanceId,
  type AgentRoutingSettings as RoutingSettings,
  type AgentRoutingRule,
  type ModelSelection,
} from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";

const PRIORITIES = ["fast", "balanced", "thorough"] as const;
const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export function AgentRoutingSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments } = useSettingsScope();
  const providers = environment?.serverConfig?.providers ?? [];
  const value = settings.agentRouting;
  const [advanced, setAdvanced] = useState(false);
  const update = (patch: Partial<RoutingSettings>) =>
    updateSettings({ agentRouting: { ...value, ...patch } });
  const disabled = connectedEnvironments.length === 0;
  const models = providers
    .filter((provider) => provider.enabled && provider.installed)
    .flatMap((provider) =>
      provider.models.map((model) => ({
        key: `${provider.instanceId}/${model.slug}`,
        selection: { instanceId: provider.instanceId, model: model.slug } satisfies ModelSelection,
        label: `${provider.displayName ?? provider.driver} · ${model.name}`,
        model,
      })),
    );
  const picker = (
    selection: ModelSelection | null,
    onChange: (next: ModelSelection | null) => void,
    optional = false,
  ) => (
    <Select
      value={selection ? `${selection.instanceId}/${selection.model}` : "none"}
      disabled={disabled}
      onValueChange={(key) => {
        const next = models.find((model) => model.key === key);
        if (next || key === "none") onChange(next?.selection ?? null);
      }}
    >
      <SelectTrigger>
        <SelectValue placeholder="Choose model">
          {selection
            ? (models.find((model) => model.key === `${selection.instanceId}/${selection.model}`)
                ?.label ?? selection.model)
            : optional
              ? "No fallback"
              : "Choose model"}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end">
        <SelectItem value="none">{optional ? "No fallback" : "Choose model"}</SelectItem>
        {selection &&
          !models.some((model) => model.key === `${selection.instanceId}/${selection.model}`) && (
            <SelectItem value={`${selection.instanceId}/${selection.model}`} disabled>
              {selection.model} · unavailable
            </SelectItem>
          )}
        {models.map((model) => (
          <SelectItem key={model.key} value={model.key}>
            {model.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
  const effortPicker = (
    selection: ModelSelection,
    onChange: (selection: ModelSelection) => void,
  ) => {
    const descriptor = models
      .find((model) => model.key === `${selection.instanceId}/${selection.model}`)
      ?.model.capabilities?.optionDescriptors?.find((option) =>
        ["effort", "reasoningEffort", "reasoning_effort", "thinking", "thought_level"].includes(
          option.id,
        ),
      );
    if (descriptor?.type !== "select") return null;
    const current = selection.options?.find((option) => option.id === descriptor.id)?.value;
    return (
      <Select
        value={typeof current === "string" ? current : "default"}
        onValueChange={(effort) => {
          if (!effort) return;
          onChange({
            ...selection,
            options: [
              ...(selection.options ?? []).filter((option) => option.id !== descriptor.id),
              ...(effort === "default" ? [] : [{ id: descriptor.id, value: effort }]),
            ],
          });
        }}
      >
        <SelectTrigger aria-label="Locked model effort">
          <SelectValue>
            {typeof current === "string" ? label(current) : "Model default"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="default">Model default</SelectItem>
          {descriptor.options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    );
  };
  const changeRule = (id: string, patch: Partial<AgentRoutingRule>) =>
    update({ rules: value.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)) });
  const preset = () => {
    const claude = providers.find((provider) => provider.driver === "claudeAgent");
    const codex = providers.find((provider) => provider.driver === "codex");
    const rule = (
      id: string,
      name: string,
      match: string[],
      instance: string,
      model: string,
    ): AgentRoutingRule => ({
      id,
      name,
      enabled: true,
      match,
      selection: { instanceId: ProviderInstanceId.make(instance), model },
      efforts: { fast: "medium", balanced: "high", thorough: "high" },
      fallback: null,
    });
    update({
      rules: [
        rule(
          "design",
          "Design & frontend",
          [
            "frontend",
            "front-end",
            "design",
            "UX",
            "UI",
            "layout",
            "customer experience",
            "product",
            "CSS",
            "typography",
          ],
          claude?.instanceId ?? "claudeAgent",
          "claude-opus-5-5",
        ),
        rule(
          "backend",
          "Backend & agentic work",
          [
            "backend",
            "back-end",
            "API",
            "database",
            "server",
            "agent",
            "orchestrator",
            "migration",
            "infrastructure",
          ],
          codex?.instanceId ?? "codex",
          "gpt-6-astra",
        ),
        ...value.rules.filter((rule) => rule.id !== "design" && rule.id !== "backend"),
      ],
    });
  };
  return (
    <SettingsSection {...searchableSetting("orchestrator")} title="Orchestrator">
      <SettingsRow
        title="Model routing"
        description="Keep your chosen model, route by task, or lock all work to one model."
      >
        <Select
          value={value.mode}
          disabled={disabled}
          onValueChange={(mode) => {
            if (mode === "manual" || mode === "auto" || mode === "single") update({ mode });
          }}
        >
          <SelectTrigger>
            <SelectValue>
              {value.mode === "single" ? "One model for everything" : label(value.mode)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end">
            <SelectItem value="manual">Manual</SelectItem>
            <SelectItem value="auto">Auto</SelectItem>
            <SelectItem value="single">One model for everything</SelectItem>
          </SelectPopup>
        </Select>
      </SettingsRow>
      {value.mode === "single" && (
        <SettingsRow title="Locked model" description="Applies to every task and delegated agent.">
          {picker(value.singleModel, (singleModel) => update({ singleModel }))}
        </SettingsRow>
      )}
      {value.mode === "single" && value.singleModel && (
        <SettingsRow
          title="Locked effort"
          description="Use the same supported effort for this model across tasks."
        >
          {effortPicker(value.singleModel, (singleModel) => update({ singleModel }))}
        </SettingsRow>
      )}
      {value.mode === "auto" && (
        <SettingsRow
          title="Priority"
          description="Each routing rule maps priority to an effort level. Thorough does not automatically mean maximum."
        >
          <Select
            value={value.priority}
            disabled={disabled}
            onValueChange={(priority) => {
              if (PRIORITIES.includes(priority as (typeof PRIORITIES)[number]))
                update({ priority: priority as (typeof PRIORITIES)[number] });
            }}
          >
            <SelectTrigger>
              <SelectValue>{label(value.priority)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              {PRIORITIES.map((priority) => (
                <SelectItem key={priority} value={priority}>
                  {label(priority)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </SettingsRow>
      )}
      {value.mode !== "manual" && (
        <SettingsRow
          title="Execution"
          description="Direct keeps work with the assigned agent. Delegation lets it split scoped tasks."
        >
          <Select
            value={value.delegation}
            disabled={disabled}
            onValueChange={(delegation) => {
              if (delegation === "direct" || delegation === "auto" || delegation === "always")
                update({ delegation });
            }}
          >
            <SelectTrigger>
              <SelectValue>
                {value.delegation === "direct"
                  ? "Direct"
                  : value.delegation === "auto"
                    ? "Delegate when useful"
                    : "Prefer delegation"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end">
              <SelectItem value="direct">Direct</SelectItem>
              <SelectItem value="auto">Delegate when useful</SelectItem>
              <SelectItem value="always">Prefer delegation</SelectItem>
            </SelectPopup>
          </Select>
        </SettingsRow>
      )}
      <SettingsRow
        title="Combine queued messages"
        description="Send compatible queued messages together as one evolving brief."
      >
        <Switch
          checked={value.groupQueuedMessages}
          disabled={disabled}
          onCheckedChange={(groupQueuedMessages) => update({ groupQueuedMessages })}
        />
      </SettingsRow>
      <SettingsRow
        title="Routing & limits"
        description={`${value.rules.length} rules · ${value.maxConcurrentAgents} concurrent agents`}
      >
        <Button variant="outline" size="sm" onClick={() => setAdvanced(!advanced)}>
          {advanced ? "Hide details" : "Configure"}
        </Button>
      </SettingsRow>
      {advanced && (
        <div className="space-y-4 px-3 py-4 sm:px-4">
          <p className="text-xs text-muted-foreground">
            Rules run in order; the first matching phrase wins. Unmatched work keeps the selected
            model. Fallbacks run only when explicitly configured.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={disabled} onClick={preset}>
              Use Claude / GPT preferences
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !models[0]}
              onClick={() => {
                const first = models[0];
                if (!first) return;
                update({
                  rules: [
                    ...value.rules,
                    {
                      id: randomUUID(),
                      name: "New rule",
                      enabled: true,
                      match: ["task"],
                      selection: first.selection,
                      efforts: { fast: "", balanced: "", thorough: "" },
                      fallback: null,
                    },
                  ],
                });
              }}
            >
              Add rule
            </Button>
          </div>
          {value.rules.map((rule, index) => (
            <div key={rule.id} className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <Switch
                  checked={rule.enabled}
                  onCheckedChange={(enabled) => changeRule(rule.id, { enabled })}
                  aria-label={`Enable ${rule.name}`}
                />
                <Input
                  aria-label="Rule name"
                  value={rule.name}
                  onChange={(event) => {
                    if (event.target.value.trim())
                      changeRule(rule.id, { name: event.target.value });
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={index === 0}
                  onClick={() => {
                    const rules = [...value.rules];
                    [rules[index - 1], rules[index]] = [rules[index]!, rules[index - 1]!];
                    update({ rules });
                  }}
                >
                  Up
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    update({ rules: value.rules.filter((entry) => entry.id !== rule.id) })
                  }
                >
                  Remove
                </Button>
              </div>
              <label className="grid gap-1 text-xs text-muted-foreground">
                Matching phrases, separated by commas
                <Input
                  defaultValue={rule.match.join(", ")}
                  onBlur={(event) =>
                    changeRule(rule.id, {
                      match: event.target.value
                        .split(",")
                        .map((phrase) => phrase.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Model
                  {picker(rule.selection, (selection) => {
                    if (selection)
                      changeRule(rule.id, {
                        selection,
                        efforts: { fast: "", balanced: "", thorough: "" },
                      });
                  })}
                </label>
                <label className="grid gap-1 text-xs text-muted-foreground">
                  Fallback
                  {picker(rule.fallback, (fallback) => changeRule(rule.id, { fallback }), true)}
                </label>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {PRIORITIES.map((priority) => {
                  const descriptor = models
                    .find(
                      (model) =>
                        model.selection.instanceId === rule.selection.instanceId &&
                        model.selection.model === rule.selection.model,
                    )
                    ?.model.capabilities?.optionDescriptors?.find((option) =>
                      [
                        "effort",
                        "reasoningEffort",
                        "reasoning_effort",
                        "thinking",
                        "thought_level",
                      ].includes(option.id),
                    );
                  const choices = descriptor?.type === "select" ? descriptor.options : [];
                  return (
                    <label key={priority} className="grid gap-1 text-xs text-muted-foreground">
                      {label(priority)} effort
                      <Select
                        value={rule.efforts[priority] || "default"}
                        onValueChange={(effort) => {
                          if (effort)
                            changeRule(rule.id, {
                              efforts: {
                                ...rule.efforts,
                                [priority]: effort === "default" ? "" : effort,
                              },
                            });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue>
                            {rule.efforts[priority]
                              ? label(rule.efforts[priority])
                              : "Model default"}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value="default">Model default</SelectItem>
                          {choices.map((choice) => (
                            <SelectItem key={choice.id} value={choice.id}>
                              {choice.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="grid gap-3 sm:grid-cols-3">
            {(
              [
                ["maxConcurrentAgents", "Concurrent agents", 16],
                ["maxAgentsPerTask", "Agents per task", 32],
                ["maxDepth", "Delegation depth", 4],
              ] as const
            ).map(([key, title, max]) => (
              <label key={key} className="grid gap-1 text-xs text-muted-foreground">
                {title}
                <Input
                  type="number"
                  min={1}
                  max={max}
                  value={value[key]}
                  onChange={(event) => {
                    const number = Number(event.target.value);
                    if (Number.isInteger(number) && number >= 1 && number <= max)
                      update({ [key]: number });
                  }}
                />
              </label>
            ))}
          </div>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Additional execution instructions
            <Textarea
              value={value.instructions}
              maxLength={16000}
              onChange={(event) => update({ instructions: event.target.value })}
            />
          </label>
        </div>
      )}
    </SettingsSection>
  );
}
