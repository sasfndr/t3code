import { ThreadId, type OrchestrationThread } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

export const AgentTaskLink = Schema.Struct({
  childThreadId: ThreadId,
  parentThreadId: ThreadId,
  rootThreadId: ThreadId,
  rootTurnId: Schema.NullOr(Schema.String),
  depth: Schema.Int,
  taskKey: Schema.String,
  files: Schema.Array(Schema.String),
});
export type AgentTaskLink = typeof AgentTaskLink.Type;
const decodeLink = Schema.decodeUnknownOption(AgentTaskLink);
export function agentTaskLinks(thread: Pick<OrchestrationThread, "activities">): AgentTaskLink[] {
  return thread.activities.flatMap((activity) => {
    if (activity.kind !== "orchestrator.task") return [];
    const link = decodeLink(activity.payload);
    return Option.isSome(link) ? [link.value] : [];
  });
}
export function agentParentLink(
  thread: Pick<OrchestrationThread, "activities">,
): AgentTaskLink | undefined {
  const activity = thread.activities.find((entry) => entry.kind === "orchestrator.parent");
  const link = decodeLink(activity?.payload);
  return Option.isSome(link) ? link.value : undefined;
}

/** Child-side ownership survives deletion of the parent's projection. */
export function delegatedDescendants(
  threads: readonly OrchestrationThread[],
  parentId: ThreadId,
): ThreadId[] {
  return delegatedDescendantsFromActivities(
    threads.flatMap((thread) => thread.activities),
    parentId,
  );
}

export function delegatedDescendantsFromActivities(
  activities: OrchestrationThread["activities"],
  parentId: ThreadId,
): ThreadId[] {
  const links = activities.flatMap((activity) => {
    if (activity.kind !== "orchestrator.parent") return [];
    const link = decodeLink(activity.payload);
    return Option.isSome(link) ? [link.value] : [];
  });
  const found = new Set<ThreadId>([parentId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of links) {
      if (found.has(link.parentThreadId) && !found.has(link.childThreadId)) {
        found.add(link.childThreadId);
        changed = true;
      }
    }
  }
  found.delete(parentId);
  return [...found];
}
