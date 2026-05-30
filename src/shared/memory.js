// Conversation memory: keep the model's context small while letting it
// "remember" far past the verbatim window. Two artifacts do the work:
//
//   • conversationSummary — a compact running prose summary of older turns that
//     have scrolled out of the verbatim window. Sent in the system prompt.
//   • userFacts — durable, cross-session facts about the user (name, prefs,
//     what they're building). Persisted between sessions and always injected.
//
// The functions here are pure so they can be unit-tested in isolation; the
// actual model call that produces a summary lives in ai-service.js.

// How many of the most-recent messages we always send verbatim. Anything older
// is represented only by conversationSummary.
export const VERBATIM_MESSAGES = 30;
// Once the unsummarized tail grows past this, fold its oldest part into the
// summary so the tail shrinks back toward VERBATIM_MESSAGES. The gap (threshold
// minus verbatim) batches summarization so we don't call the model every turn.
export const SUMMARIZE_THRESHOLD = 44;
// Hard cap on stored durable facts so the injected block stays small.
export const MAX_USER_FACTS = 40;

// The slice of history that still needs to be sent verbatim because it isn't
// captured by the summary yet: everything from summarizedCount onward. This is
// gap-free by construction — we never drop a message that isn't in the summary.
export function unsummarizedTail(messages, summarizedCount = 0) {
  const list = Array.isArray(messages) ? messages : [];
  const start = Math.min(Math.max(0, summarizedCount), list.length);
  return list.slice(start);
}

// Decide whether to fold older messages into the summary, and which ones.
// Returns { shouldSummarize, fromIndex, toIndex, newSummarizedCount }. We keep
// the last `keep` messages verbatim and summarize everything before them.
export function planSummarization(
  totalLength,
  summarizedCount = 0,
  { keep = VERBATIM_MESSAGES, threshold = SUMMARIZE_THRESHOLD } = {}
) {
  const total = Math.max(0, totalLength | 0);
  const already = Math.min(Math.max(0, summarizedCount | 0), total);
  const tail = total - already;
  if (tail <= threshold) {
    return { shouldSummarize: false, fromIndex: already, toIndex: already, newSummarizedCount: already };
  }
  const toIndex = Math.max(already, total - keep);
  return {
    shouldSummarize: toIndex > already,
    fromIndex: already,
    toIndex,
    newSummarizedCount: toIndex
  };
}

// Render a conversation slice as a compact transcript for the summarizer.
export function transcriptFor(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.trim()}`)
    .join("\n");
}

// Merge freshly-extracted durable facts into the existing set: trim, drop
// blanks, dedupe case-insensitively (newest wins on a near-duplicate), and cap.
export function mergeUserFacts(existing = [], incoming = [], cap = MAX_USER_FACTS) {
  const clean = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .map((f) => String(f || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);

  const result = [];
  const seen = new Set();
  // Existing first (stable order), then incoming. Dedupe by lowercase text.
  for (const fact of [...clean(existing), ...clean(incoming)]) {
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(fact);
  }
  // Keep the most recent `cap` facts (incoming are appended last, so slice tail).
  return result.slice(-cap);
}

// Build the system-prompt block that injects what the model "remembers". Empty
// string when there's nothing to add, so it costs zero tokens on fresh chats.
export function cleanMessagesForAI(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => {
      if (!m || m.pending || m.streaming) return false;
      if (m.role !== "user" && m.role !== "assistant") return false;
      return typeof m.content === "string" && m.content.trim();
    })
    .map((m) => ({ role: m.role, content: m.content }));
}

export function buildChatContextPayload(chat = {}, { projectMemory = "" } = {}) {
  const clean = cleanMessagesForAI(chat?.messages);
  const summarizedCount = Number.isInteger(chat?.summarizedCount) && chat.summarizedCount >= 0
    ? chat.summarizedCount
    : 0;

  return {
    messages: unsummarizedTail(clean, summarizedCount),
    conversationSummary: typeof chat?.conversationSummary === "string" ? chat.conversationSummary : "",
    projectMemory: typeof projectMemory === "string" ? projectMemory.trim() : ""
  };
}

export function messageNeedsScreen(text) {
  const t = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/\b(my screen|on screen|on-screen|the screen|my desktop|this screenshot|the screenshot|this image|the image|what app|which app|what window|currently (open|showing|on|displayed))\b/.test(t)) {
    return true;
  }

  const actionRef = /\b(read|explain|fix|solve|translate|summari[sz]e|describe|inspect|look at|what does)\b/.test(t);
  const deicticRef = /\b(this|that|these|those|here|shown|visible|above|below|selected|highlighted)\b/.test(t);
  const visualSubject = /\b(error|bug|code|page|window|image|picture|screenshot|question|problem|text|line|button|ui|screen)\b/.test(t);
  return actionRef && (deicticRef || visualSubject);
}

export function buildMemoryBlock({ userFacts = [], conversationSummary = "", projectMemory = "" } = {}) {
  const facts = (Array.isArray(userFacts) ? userFacts : []).map((f) => String(f || "").trim()).filter(Boolean);
  const summary = String(conversationSummary || "").trim();
  const project = String(projectMemory || "").trim();
  if (facts.length === 0 && !summary && !project) return "";

  const lines = ["\n\n## MEMORY (what you already know — use it, don't re-ask)"];
  if (facts.length > 0) {
    lines.push("", "What you know about this user (persists across sessions):");
    for (const f of facts) lines.push(`- ${f}`);
  }
  if (project) {
    lines.push("", "Project memory (persists for the active project):", project);
  }
  if (summary) {
    lines.push(
      "",
      "Summary of earlier in this conversation (older messages not shown verbatim below):",
      summary
    );
  }
  lines.push(
    "",
    "Treat the above as established context. Resolve references against it and never ask the user to repeat something it already covers."
  );
  return lines.join("\n");
}
