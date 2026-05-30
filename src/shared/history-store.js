import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DEFAULT_MODEL, normalizeModel } from "./models.js";

const EMPTY_HISTORY = {
  selectedModel: DEFAULT_MODEL,
  messages: [],
  workspacePath: "",
  agentMode: false,
  panelWidthMode: "standard",
  // Rolling in-session memory: a compact summary of turns older than the
  // verbatim window, and how many of the oldest messages it already covers.
  conversationSummary: "",
  summarizedCount: 0
};

function normalizeHistory(value) {
  if (!value || typeof value !== "object") {
    return { ...EMPTY_HISTORY };
  }

  return {
    selectedModel: normalizeModel(value.selectedModel),
    messages: Array.isArray(value.messages) ? value.messages : [],
    workspacePath: typeof value.workspacePath === "string" ? value.workspacePath : "",
    agentMode: typeof value.agentMode === "boolean" ? value.agentMode : false,
    panelWidthMode: value.panelWidthMode === "wide" ? "wide" : "standard",
    conversationSummary: typeof value.conversationSummary === "string" ? value.conversationSummary : "",
    summarizedCount: Number.isInteger(value.summarizedCount) && value.summarizedCount >= 0 ? value.summarizedCount : 0
  };
}

function extractToolName(content) {
  const text = String(content || "");
  const colonMatch = text.match(/^\[TOOL_RESULT:\s*([^\]\s]+)/);
  if (colonMatch) return colonMatch[1];
  const legacyMatch = text.match(/^\[TOOL_RESULT\]\s*([^\s:]+)/);
  if (legacyMatch) return legacyMatch[1];
  return "tool";
}

function isToolResultMessage(message) {
  return !!message && typeof message.content === "string" && message.content.startsWith("[TOOL_RESULT");
}

function countsAsConversationTurn(message) {
  if (!message || message.pending || message.streaming || isToolResultMessage(message)) return false;
  return (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" &&
    message.content.trim().length > 0;
}

export function pruneStaleToolResults(messages, { keepRecentTurns = 5 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let turnsAfter = 0;
  const out = new Array(list.length);

  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i];
    if (isToolResultMessage(message) && turnsAfter > keepRecentTurns) {
      const toolName = extractToolName(message.content);
      out[i] = {
        ...message,
        content: `[TOOL_RESULT: ${toolName} - Output truncated to save memory]`
      };
    } else {
      out[i] = message && typeof message === "object" ? { ...message } : message;
    }

    if (countsAsConversationTurn(message)) turnsAfter += 1;
  }

  return out;
}

export function createHistoryStore(filePath) {
  return {
    async load() {
      try {
        const raw = await readFile(filePath, "utf8");
        return normalizeHistory(JSON.parse(raw));
      } catch (error) {
        if (error.code === "ENOENT") {
          return { ...EMPTY_HISTORY };
        }

        throw error;
      }
    },

    async save(history) {
      const normalized = normalizeHistory(history);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      return normalized;
    },

    // Wipe the conversation transcript while preserving the user's preferences
    // (model, workspace, mode, panel width). Used to reset history on every
    // launch so a new session always starts with a clean conversation.
    async clearMessages() {
      const current = await this.load();
      return this.save({ ...current, messages: [], conversationSummary: "", summarizedCount: 0 });
    }
  };
}
