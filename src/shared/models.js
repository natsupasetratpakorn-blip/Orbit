export const MODELS = [
  "Auto",
  "Voyager 1",
  "Voyager 1 Flash",
  "Voyager 2",
  "Voyager 2 Pro",
  "Voyager 2.1 Preview",
  "Orchestra 1.1"
];
export const DEFAULT_MODEL = "Voyager 1 Flash";

export const MODEL_IDS = {
  "Voyager 1": "gemini-2.5-flash",
  "Voyager 1 Flash": "gemini-2.5-flash-lite",
  "Voyager 2": "gemini-3.1-flash-lite",
  "Voyager 2 Pro": "gemini-3.1-pro",
  "Voyager 2.1 Preview": "gemini-3.5-flash",
  "Orchestra 1.1": "gemini-2.5-flash-lite"
};

// Heuristic router for "Auto" model. Looks at prompt length, presence of code
// fences/keywords, and mode to pick between Flash (cheap/fast) and Pro
// (heavy reasoning). Returns one of the concrete MODELS entries.
export function routeAutoModel({ text = "", mode = "ask", agentMode = false } = {}) {
  const t = String(text || "");
  const len = t.length;
  const hasCodeFence = /```/.test(t);
  const hasCodeyKeyword = /\b(refactor|debug|stack trace|architect|design|implement|algorithm|optimize|complexity|tests?|migration|kubernetes|race condition|deadlock)\b/i.test(t);
  const isLong = len > 600 || t.split("\n").length > 12;

  if (mode === "planning") return "Orchestra 1.1";
  if (agentMode || hasCodeFence || hasCodeyKeyword || isLong) {
    return "Voyager 2.1 Preview";
  }
  return "Voyager 1 Flash";
}

export function normalizeModel(model) {
  return MODELS.includes(model) ? model : DEFAULT_MODEL;
}

// ─── Presets ───────────────────────────────────────────────────────────────
// A preset tunes the model's system prompt toward a use-case (the actual
// prompt text lives in ai-service.js, keyed by these ids). The renderer uses
// this list to build the settings dropdown; the id is threaded through to the
// AI request. "general" is the neutral default (no extra steering).
export const PRESETS = [
  { id: "general", label: "General", icon: "✦", desc: "Balanced everyday assistant" },
  { id: "studying", label: "Studying", icon: "✎", desc: "Patient tutor that explains and quizzes" },
  { id: "coding", label: "Coding", icon: "⌘", desc: "Senior software engineer" },
  { id: "math", label: "Math", icon: "∑", desc: "Rigorous step-by-step problem solver" },
  { id: "writing", label: "Writing", icon: "✍", desc: "Editor for clear, polished prose" }
];
export const DEFAULT_PRESET = "general";

export function normalizePreset(preset) {
  return PRESETS.some((p) => p.id === preset) ? preset : DEFAULT_PRESET;
}
