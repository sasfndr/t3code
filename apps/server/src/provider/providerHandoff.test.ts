import { describe, expect, it } from "vite-plus/test";
import { MessageId, type OrchestrationMessage } from "@t3tools/contracts";
import { buildProviderHandoff } from "./providerHandoff.ts";

const message = (
  id: string,
  text: string,
  role: OrchestrationMessage["role"] = "user",
): OrchestrationMessage => ({
  id: MessageId.make(id),
  text,
  role,
  turnId: null,
  streaming: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const prepare = (messages: OrchestrationMessage[], sourceMessageId = "current") =>
  buildProviderHandoff({
    thread: { title: "Cross-provider work", messages, proposedPlans: [] },
    sourceMessageId: MessageId.make(sourceMessageId),
    transcriptPath: "/private/handoff.md",
    resolveAttachment: () => "/private/reference.png",
  });

describe("provider conversation handoff", () => {
  it("carries prior conversation and attachment paths without replaying the current or queued prompts", () => {
    const first = {
      ...message("first", "Use the orange logo."),
      attachments: [
        {
          type: "image" as const,
          id: "image-1",
          name: "logo.png",
          mimeType: "image/png",
          sizeBytes: 20,
        },
      ],
    };
    const result = prepare([
      first,
      message("answer", "Logo is saved.", "assistant"),
      message("private", "private thought", "reasoning"),
      message("current", "Continue now."),
      message("queued", "Do this later."),
    ]);
    expect(result.prompt).toContain("Use the orange logo.");
    expect(result.prompt).toContain("Logo is saved.");
    expect(result.prompt).toContain("/private/reference.png");
    expect(result.transcript).not.toContain("Continue now.");
    expect(result.transcript).not.toContain("Do this later.");
    expect(result.transcript).not.toContain("private thought");
  });
  it("bounds the prompt while retaining full long history on disk", () => {
    const result = prepare([
      message("first", "Original objective"),
      message("long", "x".repeat(100_000), "assistant"),
      message("recent", "Latest decision"),
      message("current", "Continue"),
    ]);
    expect(result.prompt.length).toBeLessThan(50_000);
    expect(result.prompt).toContain("Original objective");
    expect(result.prompt).toContain("Latest decision");
    expect(result.prompt).toContain("/private/handoff.md");
    expect(result.transcript).toContain("x".repeat(100_000));
  });
  it("fails closed when the exact message boundary cannot be found", () => {
    expect(() => prepare([message("first", "Saved context")])).toThrow("boundary");
  });
});
