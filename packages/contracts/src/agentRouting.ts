import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ModelSelection } from "./orchestration.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AgentRoutingPriority = Schema.Literals(["fast", "balanced", "thorough"]);
export type AgentRoutingPriority = typeof AgentRoutingPriority.Type;
const AgentRoutingEfforts = Schema.Struct({
  fast: Schema.String,
  balanced: Schema.String,
  thorough: Schema.String,
});
export type AgentRoutingEfforts = typeof AgentRoutingEfforts.Type;

export const AgentRoutingRule = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** What this specialist handles. The router model and delegating parents read it. */
  description: Schema.String.check(Schema.isMaxLength(2000)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
  enabled: Schema.Boolean,
  /** Legacy keyword routing. Kept so older settings decode; routing now uses the router model. */
  match: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  selection: ModelSelection,
  efforts: AgentRoutingEfforts,
  fallback: Schema.NullOr(ModelSelection),
});
export type AgentRoutingRule = typeof AgentRoutingRule.Type;

export const AgentRoutingSettings = Schema.Struct({
  mode: Schema.Literals(["manual", "auto", "single"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("manual" as const)),
  ),
  priority: AgentRoutingPriority.pipe(
    Schema.withDecodingDefault(Effect.succeed("balanced" as const)),
  ),
  singleModel: Schema.NullOr(ModelSelection).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  rules: Schema.Array(AgentRoutingRule).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Fast model that reads each task and picks a route in Auto mode. Null disables Auto routing. */
  router: Schema.NullOr(ModelSelection).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Auto mode's route for work no rule matches. Null keeps the thread's current model. */
  defaultRoute: Schema.NullOr(
    Schema.Struct({ selection: ModelSelection, efforts: AgentRoutingEfforts }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  delegation: Schema.Literals(["direct", "auto", "always"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("direct" as const)),
  ),
  maxConcurrentAgents: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(3)),
  ),
  maxAgentsPerTask: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(6)),
  ),
  maxDepth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(1)),
  ),
  groupQueuedMessages: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  instructions: Schema.String.check(Schema.isMaxLength(16000)).pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
  ),
});
export type AgentRoutingSettings = typeof AgentRoutingSettings.Type;
export const DEFAULT_AGENT_ROUTING_SETTINGS = Schema.decodeSync(AgentRoutingSettings)({});

/** Settings-page preview: run the real router on a sample task without starting any work. */
export const AgentRoutePreviewInput = Schema.Struct({
  settings: AgentRoutingSettings,
  task: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
});
export type AgentRoutePreviewInput = typeof AgentRoutePreviewInput.Type;

export const AgentRoutePreviewResult = Schema.Struct({
  source: Schema.Literals(["manual", "lock", "rule", "default", "unmatched"]),
  ruleId: Schema.NullOr(Schema.String),
  selection: Schema.NullOr(ModelSelection),
  effort: Schema.NullOr(Schema.String),
  usedFallback: Schema.Boolean,
  routerReason: Schema.NullOr(Schema.String),
  /** Set when the chosen route cannot run (unavailable model, unsupported effort). */
  problem: Schema.NullOr(Schema.String),
});
export type AgentRoutePreviewResult = typeof AgentRoutePreviewResult.Type;

export class AgentRoutePreviewError extends Schema.TaggedError<AgentRoutePreviewError>()(
  "AgentRoutePreviewError",
  { message: Schema.String },
) {}
