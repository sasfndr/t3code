import type { AgentRoutingSettings } from "@t3tools/contracts";
import { routerRoutes, type AgentRouteChoice } from "@t3tools/shared/agentRouting";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type { TextGeneration } from "../textGeneration/TextGeneration.ts";

const ROUTER_TIMEOUT = Duration.seconds(60);

/**
 * Ask the configured router model which route fits `task`. Never fails: without a router, routes,
 * or a usable answer the task falls through to "Everything else", and the reason says why.
 */
export const chooseAgentRoute = (input: {
  readonly settings: AgentRoutingSettings;
  readonly task: string;
  readonly cwd: string;
  readonly textGeneration: Pick<TextGeneration["Service"], "routeTask">;
}): Effect.Effect<AgentRouteChoice> => {
  const { settings } = input;
  if (settings.mode !== "auto") return Effect.succeed({ ruleId: null });
  const routes = routerRoutes(settings);
  if (routes.length === 0) return Effect.succeed({ ruleId: null, reason: "No routes are on" });
  const routeTask = input.textGeneration.routeTask;
  if (!settings.router) return Effect.succeed({ ruleId: null, reason: "No router model chosen" });
  if (!routeTask) return Effect.succeed({ ruleId: null, reason: "Routing is unavailable" });
  return routeTask({
    cwd: input.cwd,
    message: input.task,
    routes,
    modelSelection: settings.router,
  }).pipe(
    Effect.timeout(ROUTER_TIMEOUT),
    Effect.map((result): AgentRouteChoice => ({
      ruleId: result.routeId,
      ...(result.reason ? { reason: result.reason } : {}),
    })),
    Effect.catch((error) =>
      Effect.logWarning("Orchestrator router failed", { error }).pipe(
        Effect.as<AgentRouteChoice>({
          ruleId: null,
          reason: `Router unavailable: ${"detail" in error ? error.detail : "timed out"}`,
        }),
      ),
    ),
  );
};
