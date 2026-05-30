import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHistoryStore, pruneStaleToolResults } from "../src/shared/history-store.js";
import { DEFAULT_MODEL } from "../src/shared/models.js";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "orbit-history-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("createHistoryStore", () => {
  it("starts with empty history and a default model when no file exists", async () => {
    const store = createHistoryStore(join(tempDir, "chat-history.json"));

    await expect(store.load()).resolves.toEqual({
      selectedModel: DEFAULT_MODEL,
      messages: [],
      workspacePath: "",
      agentMode: false,
      panelWidthMode: "standard",
      conversationSummary: "",
      summarizedCount: 0
    });
  });

  it("persists model choice and messages to local JSON", async () => {
    const filePath = join(tempDir, "chat-history.json");
    const store = createHistoryStore(filePath);
    const now = "2026-05-25T10:00:00.000Z";

    await store.save({
      selectedModel: "Voyager 1",
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "Summarize my screen",
          timestamp: now,
          screenshotPath: "screen.png"
        }
      ]
    });

    await expect(store.load()).resolves.toEqual({
      selectedModel: "Voyager 1",
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "Summarize my screen",
          timestamp: now,
          screenshotPath: "screen.png"
        }
      ],
      workspacePath: "",
      agentMode: false,
      panelWidthMode: "standard",
      conversationSummary: "",
      summarizedCount: 0
    });

    const raw = await readFile(filePath, "utf8");
    expect(JSON.parse(raw).messages).toHaveLength(1);
  });

  it("clears transcript and rolling memory together", async () => {
    const store = createHistoryStore(join(tempDir, "chat-history.json"));

    await store.save({
      selectedModel: "Voyager 1",
      messages: [{ role: "user", content: "remember this" }],
      conversationSummary: "The user is building Orbit.",
      summarizedCount: 12
    });

    await expect(store.clearMessages()).resolves.toMatchObject({
      messages: [],
      conversationSummary: "",
      summarizedCount: 0
    });
  });
});

describe("pruneStaleToolResults", () => {
  it("truncates old tool payloads while preserving recent tool results", () => {
    const messages = [
      { role: "user", content: "Question" },
      { role: "assistant", content: '<read_file path="src/app.js" />' },
      { role: "user", content: `[TOOL_RESULT: read_file path="src/app.js"]\n${"x".repeat(2000)}` },
      { role: "assistant", content: "First follow-up" },
      { role: "user", content: "Next question" },
      { role: "assistant", content: "Second follow-up" },
      { role: "user", content: "Another question" },
      { role: "assistant", content: '<web_search query="Orbit" />' },
      { role: "user", content: "[TOOL_RESULT] web_search query=\"Orbit\":\nFresh payload" },
      { role: "assistant", content: "Recent answer" }
    ];

    const pruned = pruneStaleToolResults(messages, { keepRecentTurns: 4 });

    expect(pruned[2].content).toBe("[TOOL_RESULT: read_file - Output truncated to save memory]");
    expect(pruned[8].content).toBe("[TOOL_RESULT] web_search query=\"Orbit\":\nFresh payload");
    expect(messages[2].content).toContain("x".repeat(20));
  });
});
