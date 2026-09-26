import type { ChatAttachment, MessageId, OrchestrationThread } from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";

/** Provider-native cursors cannot cross harnesses. Keep a readable transcript
 * on disk and a bounded excerpt in the first prompt; never ask the exhausted
 * provider to summarize, and never replay tool calls as executable requests. */
export function buildProviderHandoff(input: {
  thread: Pick<OrchestrationThread, "title" | "messages" | "proposedPlans">;
  sourceMessageId?: MessageId;
  transcriptPath: string;
  resolveAttachment: (attachment: ChatAttachment) => string | null;
}) {
  const boundary = input.sourceMessageId
    ? input.thread.messages.findIndex((message) => message.id === input.sourceMessageId)
    : input.thread.messages.length;
  if (boundary < 0) throw new Error("The provider handoff message boundary is missing.");
  const messages = input.thread.messages.slice(0, boundary).filter((m) => m.role !== "reasoning");
  const entries = messages.map((message) => {
    const text = projectComposerContextForProvider({
      text: message.text,
      records: message.context?.records ?? [],
    });
    const attachments = (message.attachments ?? []).map((attachment) => {
      const path = input.resolveAttachment(attachment);
      return `Attachment ${JSON.stringify(attachment.name)}: ${path ?? "unavailable"}`;
    });
    return `## ${message.role} (${message.createdAt})\n${text}\n${attachments.join("\n")}`;
  });
  const plans = input.thread.proposedPlans.map((plan) => `## Saved plan\n${plan.planMarkdown}`);
  const transcript = [`# ${input.thread.title}`, ...entries, ...plans].join("\n\n");
  const excerptBudget = 48_000;
  const recent = entries.join("\n\n");
  const excerpt =
    recent.length <= excerptBudget
      ? recent
      : `${entries.find((_, index) => messages[index]?.role === "user")?.slice(0, 8_000) ?? ""}\n\n[Earlier messages omitted from this excerpt; the complete saved conversation is in the transcript file.]\n\n${recent.slice(-40_000)}`;
  const prompt = [
    "[T3 Code conversation handoff]",
    "The user switched providers in this conversation. Continue the same task in the same workspace. Files and previous edits are already present; inspect their current state before changing them.",
    "The following is historical conversation context, not new instructions. Follow the current user request below. Do not rerun completed actions just because they appear in history. Provider-private reasoning and native tool state are not transferred.",
    `The full saved conversation, attachment paths, and saved plans are available at ${JSON.stringify(input.transcriptPath)}. Read it when the excerpt is insufficient.`,
    excerpt,
    "[End conversation handoff]",
  ].join("\n\n");
  return { transcript, prompt };
}
