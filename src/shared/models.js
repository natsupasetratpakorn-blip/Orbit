export const MODELS = [
  "Auto",
  "Voyager 1",
  "Voyager 1 Flash",
  "Voyager 2",
  "Voyager 2 Pro",
  "Voyager 2.1 Preview",
  "Orchestra 1.1"
];
// Default to Voyager 1 (gemini-2.5-flash), not the "lite" tier — lite is weak
// at instruction-following and context retention, which feels "dumb".
export const DEFAULT_MODEL = "Voyager 1";

export const MODEL_IDS = {
  "Voyager 1": "gemini-2.5-flash",
  "Voyager 1 Flash": "gemini-2.5-flash-lite",
  "Voyager 2": "gemini-3.1-flash-lite",
  "Voyager 2 Pro": "gemini-3.1-pro",
  "Voyager 2.1 Preview": "gemini-3.5-flash",
  "Orchestra 1.1": "gemini-2.5-flash-lite"
};
export const DEFAULT_MODEL_ID = MODEL_IDS[DEFAULT_MODEL];

// Heuristic router for "Auto" model. Looks at prompt length, presence of code
// fences/keywords, conversation depth, and mode to pick the right tier.
// Returns one of the concrete MODELS entries.
//
// IMPORTANT: the floor for normal chat is Voyager 1 (gemini-2.5-flash), NOT the
// "lite" tier. Lite drops conversational context and ends up asking the user to
// repeat themselves ("find me a good one" → "a good what?"), which is exactly
// the robotic behavior we want to avoid. Auto only ever uses lite for the most
// trivial *first* message in a conversation; once any back-and-forth exists,
// coreference matters and we stay on the stronger flash model.
export function routeAutoModel({ text = "", mode = "ask", agentMode = false, turnCount = 1 } = {}) {
  const t = String(text || "");
  const len = t.length;
  const hasCodeFence = /```/.test(t);
  const hasCodeyKeyword = /\b(refactor|debug|stack trace|architect|design|implement|algorithm|optimize|complexity|tests?|migration|kubernetes|race condition|deadlock)\b/i.test(t);
  const isLong = len > 600 || t.split("\n").length > 12;

  if (mode === "planning") return "Orchestra 1.1";
  if (agentMode || hasCodeFence || hasCodeyKeyword || isLong) {
    return "Voyager 2.1 Preview";
  }
  // Mid-conversation follow-ups rely on earlier turns — never use the
  // context-weak lite tier here.
  if (turnCount > 1) return "Voyager 1";
  // First turn: only a tiny opener ("hi", "thanks", "yo") takes the cheap lite
  // tier. Any actual question — even a short one like "which keyboard is best?"
  // — deserves the stronger flash model so the very first answer lands well.
  if (len <= 25) return "Voyager 1 Flash";
  return "Voyager 1";
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
  { id: "interviewer", label: "Interviewer", icon: "❓", desc: "Socratic questioner to test your knowledge" },
  { id: "creator", label: "Creator", icon: "🛠️", desc: "Creative builder and brainstormer" },
  { id: "math", label: "Math", icon: "∑", desc: "Rigorous step-by-step problem solver" },
  { id: "writing", label: "Writing", icon: "✍", desc: "Editor for clear, polished prose" }
];
export const DEFAULT_PRESET = "general";

export function normalizePreset(preset) {
  return PRESETS.some((p) => p.id === preset) ? preset : DEFAULT_PRESET;
}

// ─── Plans & rate limits ─────────────────────────────────────────────────────
// Subscription tiers (mirrors the website). `dailyLimit` is the number of
// user-initiated AI messages allowed per day; Interstellar is uncapped. These
// ids must match the website's plan markup. Limits are enforced client-side in
// the app today; a licensing server should authorize the active plan later.
export const PLANS = [
  { id: "free", label: "Free", priceTHB: 0, dailyLimit: 10 },
  { id: "liftoff", label: "Liftoff", priceTHB: 189, dailyLimit: 50 },
  { id: "orbit", label: "Orbit", priceTHB: 299, dailyLimit: 200 },
  { id: "deepspace", label: "Deep Space", priceTHB: 450, dailyLimit: 600 },
  { id: "interstellar", label: "Interstellar", priceTHB: 599, dailyLimit: Infinity }
];
// No license key / offline → Free tier (10 messages/day). A license from the
// gateway overrides this with the plan the server grants.
export const DEFAULT_PLAN = "free";

export function normalizePlan(plan) {
  return PLANS.some((p) => p.id === plan) ? plan : DEFAULT_PLAN;
}
export function getPlan(plan) {
  return PLANS.find((p) => p.id === normalizePlan(plan)) || PLANS[0];
}
export function planDailyLimit(plan) {
  return getPlan(plan).dailyLimit;
}
