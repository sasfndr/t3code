import type { AgentRoutingSettings, ModelSelection } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuItem,
} from "../ui/menu";
import { ComposerControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

export function AgentRoutingControl({
  value,
  model,
  onChange,
}: {
  value: AgentRoutingSettings;
  model: ModelSelection;
  onChange: (value: AgentRoutingSettings) => void;
}) {
  const navigate = useNavigate();
  const popupProps = useComposerMenuProps();
  return (
    <Menu>
      <MenuTrigger render={<ComposerControl size="xs" aria-label="Agent routing" />}>
        {value.mode === "auto"
          ? `Auto · ${value.priority}`
          : value.mode === "single"
            ? "One model"
            : "Manual"}
      </MenuTrigger>
      <MenuPopup align="start" {...popupProps}>
        <MenuRadioGroup
          value={value.mode}
          onValueChange={(mode) => {
            if (mode === "manual" || mode === "auto" || mode === "single")
              onChange({
                ...value,
                mode,
                ...(mode === "single" ? { singleModel: value.singleModel ?? model } : {}),
              });
          }}
        >
          <MenuRadioItem value="manual">Manual model selection</MenuRadioItem>
          <MenuRadioItem value="auto">Auto route by preferences</MenuRadioItem>
          <MenuRadioItem value="single">One model for everything</MenuRadioItem>
        </MenuRadioGroup>
        {value.mode === "auto" && (
          <>
            <MenuSeparator />
            <MenuRadioGroup
              value={value.priority}
              onValueChange={(priority) => {
                if (priority === "fast" || priority === "balanced" || priority === "thorough")
                  onChange({ ...value, priority });
              }}
            >
              <MenuRadioItem value="fast">Fast</MenuRadioItem>
              <MenuRadioItem value="balanced">Balanced</MenuRadioItem>
              <MenuRadioItem value="thorough">Thorough</MenuRadioItem>
            </MenuRadioGroup>
          </>
        )}
        <MenuSeparator />
        <MenuItem onClick={() => void navigate({ to: "/settings/general", hash: "orchestrator" })}>
          Configure orchestration…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
