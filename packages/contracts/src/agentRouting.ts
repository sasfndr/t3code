import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ModelSelection } from "./orchestration.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AgentRoutingPriority = Schema.Literals(["fast", "balanced", "thorough"]);
export type AgentRoutingPriority = typeof AgentRoutingPriority.Type;
export const AgentRoutingRule = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  /** Plain words/phrases, never executable regular expressions. First matching rule wins. */
  match: Schema.Array(TrimmedNonEmptyString),
  selection: ModelSelection,
  efforts: Schema.Struct({ fast: Schema.String, balanced: Schema.String, thorough: Schema.String }),
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
