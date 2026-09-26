import { createFileRoute } from "@tanstack/react-router";

import { OrchestratorSettingsPanel } from "../components/settings/OrchestratorSettings";

export const Route = createFileRoute("/settings/orchestrator")({
  component: OrchestratorSettingsPanel,
});
