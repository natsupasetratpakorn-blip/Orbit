import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DEFAULT_MODEL, normalizeModel } from "./models.js";

const EMPTY_HISTORY = {
  selectedModel: DEFAULT_MODEL,
  messages: [],
  workspacePath: "",
  agentMode: false,
  panelWidthMode: "standard"
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
    panelWidthMode: value.panelWidthMode === "wide" ? "wide" : "standard"
  };
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
      return this.save({ ...current, messages: [] });
    }
  };
}
