import { describe, expect, it } from "vitest";

import {
  unsummarizedTail,
  planSummarization,
  transcriptFor,
  mergeUserFacts,
  buildMemoryBlock,
  buildChatContextPayload,
  messageNeedsScreen,
  VERBATIM_MESSAGES,
  SUMMARIZE_THRESHOLD
} from "../src/shared/memory.js";

const makeMessages = (n) =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `msg ${i}`
  }));

describe("unsummarizedTail", () => {
  it("returns everything after the summarized count", () => {
    const msgs = makeMessages(10);
    expect(unsummarizedTail(msgs, 7).map((m) => m.content)).toEqual(["msg 7", "msg 8", "msg 9"]);
  });
  it("never drops messages and clamps a too-large count", () => {
    expect(unsummarizedTail(makeMessages(3), 99)).toEqual([]);
    expect(unsummarizedTail(makeMessages(3), -5)).toHaveLength(3);
  });
});

describe("planSummarization", () => {
  it("does nothing while the tail fits under the threshold", () => {
    const plan = planSummarization(SUMMARIZE_THRESHOLD, 0);
    expect(plan.shouldSummarize).toBe(false);
    expect(plan.newSummarizedCount).toBe(0);
  });

  it("folds the oldest overflow, keeping the verbatim window intact", () => {
    const total = SUMMARIZE_THRESHOLD + 6; // tail over threshold
    const plan = planSummarization(total, 0);
    expect(plan.shouldSummarize).toBe(true);
    expect(plan.fromIndex).toBe(0);
    // Keeps exactly VERBATIM_MESSAGES verbatim after summarizing.
    expect(total - plan.newSummarizedCount).toBe(VERBATIM_MESSAGES);
    expect(plan.toIndex).toBe(total - VERBATIM_MESSAGES);
  });

  it("advances from an existing summarized count without re-summarizing", () => {
    const plan = planSummarization(100, 50);
    expect(plan.fromIndex).toBe(50);
    expect(plan.toIndex).toBe(70); // 100 - 30
    expect(plan.newSummarizedCount).toBe(70);
  });
});

describe("transcriptFor", () => {
  it("formats only valid user/assistant turns", () => {
    const out = transcriptFor([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "system", content: "ignored" },
      { role: "assistant", content: "   " }
    ]);
    expect(out).toBe("User: hi\nAssistant: hello");
  });
});

describe("mergeUserFacts", () => {
  it("dedupes case-insensitively and trims", () => {
    const merged = mergeUserFacts(["Likes dark mode"], ["likes dark mode  ", "Uses Windows"]);
    expect(merged).toEqual(["Likes dark mode", "Uses Windows"]);
  });
  it("caps to the most recent N facts", () => {
    const existing = Array.from({ length: 40 }, (_, i) => `fact ${i}`);
    const merged = mergeUserFacts(existing, ["newest"], 40);
    expect(merged).toHaveLength(40);
    expect(merged[merged.length - 1]).toBe("newest");
    expect(merged[0]).toBe("fact 1"); // oldest dropped
  });
});

describe("buildMemoryBlock", () => {
  it("returns empty string when there is nothing to remember", () => {
    expect(buildMemoryBlock({})).toBe("");
    expect(buildMemoryBlock({ userFacts: [], conversationSummary: "" })).toBe("");
  });
  it("includes facts and summary when present", () => {
    const block = buildMemoryBlock({
      userFacts: ["Building Orbit"],
      conversationSummary: "Discussed gaming keyboards."
    });
    expect(block).toContain("Building Orbit");
    expect(block).toContain("Discussed gaming keyboards.");
    expect(block).toContain("MEMORY");
  });

  it("includes project memory when present", () => {
    const block = buildMemoryBlock({
      projectMemory: "Orbit is an Electron app with a floating overlay and full app."
    });

    expect(block).toContain("Project memory");
    expect(block).toContain("floating overlay");
  });
});

describe("buildChatContextPayload", () => {
  it("sends only clean unsummarized messages plus chat and project memory", () => {
    const payload = buildChatContextPayload({
      messages: [
        { role: "user", content: "old user" },
        { role: "assistant", content: "old assistant" },
        { role: "user", content: "new user" },
        { role: "assistant", content: "" },
        { role: "system", content: "ignored" },
        { role: "assistant", content: "streaming", streaming: true }
      ],
      conversationSummary: "Older turns are summarized.",
      summarizedCount: 2
    }, {
      projectMemory: "Project prefers dark UI."
    });

    expect(payload.messages).toEqual([{ role: "user", content: "new user" }]);
    expect(payload.conversationSummary).toBe("Older turns are summarized.");
    expect(payload.projectMemory).toBe("Project prefers dark UI.");
  });
});

describe("messageNeedsScreen", () => {
  it("detects screen-dependent requests without attaching screenshots to ordinary questions", () => {
    expect(messageNeedsScreen("Can you fix this error on my screen?")).toBe(true);
    expect(messageNeedsScreen("Read this and explain what it says")).toBe(true);
    expect(messageNeedsScreen("What is a prime number?")).toBe(false);
    expect(messageNeedsScreen("How do I write a JavaScript class?")).toBe(false);
  });
});
