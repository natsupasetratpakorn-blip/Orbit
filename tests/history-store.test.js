import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHistoryStore } from "../src/shared/history-store.js";
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
