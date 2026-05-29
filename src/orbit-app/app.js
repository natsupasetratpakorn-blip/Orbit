import {
  addMessageToActiveChat,
  createDefaultOrbitState,
  createNewChat,
  getActiveChat,
  getActiveProject,
  selectProject
} from "../shared/orbit-state.js";
import { parseAIResponse, renderMarkdown, parseQuestions } from "../shared/parser.js";
import { PRESETS, DEFAULT_PRESET, normalizePreset } from "../shared/models.js";
import { transcribeWithWhisper, warmupWhisper } from "../orbit-overlay/whisper.js";

// ─── Persistence ─────────────────────────────────────────────────────────
const STORAGE_KEY = "orbit.antigravity.workspace";
const DEFAULT_MODEL = "Voyager 1 Flash";
const MODES = ["ask", "agents", "planning"];
const MODE_LABELS = { ask: "❯ Ask", agents: "▣ Agents", planning: "☰ Planning" };

const SLASH_COMMANDS = [
  { name: "/explain", desc: "Walk me through what's on screen / attached" },
  { name: "/fix", desc: "Find a root-cause fix for a bug" },
  { name: "/test", desc: "Write tests covering the code in context" },
  { name: "/refactor", desc: "Refactor for readability, behavior-preserving" },
  { name: "/summarize", desc: "Tight bullet-point summary" },
  { name: "/ask", desc: "Switch to Ask mode" },
  { name: "/agents", desc: "Switch to Agents mode" },
  { name: "/planning", desc: "Switch to Planning mode" },
  { name: "/clear", desc: "Clear the current conversation" },
  { name: "/screenshot", desc: "Toggle auto-attached screenshot" },
  { name: "/region", desc: "Capture a screen region for the next message" },
  { name: "/summon-agents", desc: "Spawn N parallel background agents: /summon-agents 3 <task>" },
  { name: "/calibrate", desc: "Verify click/type pixel coordinates" }
];

// ─── Element refs ────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const projectsList = $("#projectsList");
const conversationsList = $("#conversationsList");
const filesList = $("#filesList");
const newChatButton = $("#newChatButton");
const historyButton = $("#historyButton");
const tasksButton = $("#tasksButton");
const settingsButton = $("#settingsButton");
const menuDropdown = $("#menuDropdown");
const addProjectButton = $("#addProjectButton");
const addFileButton = $("#addFileButton");
const activeProjectName = $("#activeProjectName");
const messagesEl = $("#messages");
const emptyState = $("#emptyState");
const composer = $("#composer");
const promptInput = $("#promptInput");
const modelSelectBtn = $("#modelSelectBtn");
const modelSelectLabel = $("#modelSelectLabel");
const modelSelectOptions = $("#modelSelectOptions");
const modeButton = $("#modeButton");
const sendButton = $("#sendButton");
const micButton = $("#micButton");
const micVisualizer = $("#micVisualizer");
const attachButton = $("#attachButton");
const regionButton = $("#regionButton");
const screenshotToggleButton = $("#screenshotToggleButton");
const attachedFilesRow = $("#attachedFilesRow");
const slashMenuEl = $("#slashMenu");
const solarCanvas = $("#solarCanvas");
const cursorGlow = $("#cursorGlow");
const viewModeButton = $("#viewModeButton");
const chatStatTokens = $("#chatStatTokens");
const chatStatMessages = $("#chatStatMessages");

// ─── State ───────────────────────────────────────────────────────────────
let state = loadState();
let selectedModel = state.selectedModel || DEFAULT_MODEL;
let currentMode = MODES.includes(state.currentMode) ? state.currentMode : "ask";
let selectedPreset = normalizePreset(state.selectedPreset);
let attachScreenshot = !!state.attachScreenshot;
let attachedFiles = []; // { name, path }
let pendingRegionShot = null; // path of a one-shot region capture
let isListening = false;
let audioCtx = null;
let micStream = null;
let micAnalyser = null;
let micVisualizerRAF = null;
let mediaRecorder = null;
let audioChunks = [];
let streaming = false;
let streamingMessageId = null;
let currentStreamId = null; // active AI stream id, used to abort/stop mid-stream
// Autonomous tool loop guard. Each fresh user turn resets the counter; the
// auto-fire → tool → AI → re-render loop increments it and stops at the cap so
// a model that keeps emitting tools can't run forever (and burn cost).
let agentStepsThisTurn = 0;
const MAX_AGENT_STEPS = 12;

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (parsed?.projects?.length) {
      parsed.projects = parsed.projects.map((p) => ({
        ...p,
        files: Array.isArray(p.files) ? p.files : [],
        workspacePath: typeof p.workspacePath === "string" ? p.workspacePath : ""
      }));
      // Reset conversation history on every launch — keep projects, files,
      // and preferences, but start each session with a single empty chat.
      return resetConversations(parsed);
    }
  } catch { /* fall through */ }
  const def = createDefaultOrbitState();
  def.projects = def.projects.map((p) => ({ ...p, files: [], workspacePath: "" }));
  return def;
}

// Collapse every project's conversations down to one fresh, empty chat so the
// transcript doesn't carry over between launches. Projects, attached files, and
// workspace paths are preserved.
function resetConversations(s) {
  const now = new Date().toISOString();
  s.projects = (s.projects || []).map((p) => {
    const chat = { id: crypto.randomUUID(), title: "New Conversation", createdAt: now, messages: [] };
    return { ...p, chats: [chat] };
  });
  const first = s.projects[0];
  s.activeProjectId = first?.id ?? s.activeProjectId ?? null;
  s.activeChatId = first?.chats[0]?.id ?? null;
  return s;
}

function persistState() {
  state.selectedModel = selectedModel;
  state.currentMode = currentMode;
  state.selectedPreset = selectedPreset;
  state.attachScreenshot = attachScreenshot;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ─── Utility: toast ──────────────────────────────────────────────────────
function toast(msg, variant = "default", duration = 3000) {
  let container = document.querySelector(".toast-container");
  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.append(container);
  }
  const el = document.createElement("div");
  el.className = `toast toast-${variant}`;
  el.textContent = msg;
  container.append(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 220);
  }, duration);
}

function formatAge(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function approxTokens(text) {
  return Math.ceil((text || "").length / 4);
}

function basename(p) {
  return (p || "").split(/[\\/]/).pop() || p;
}

// ─── Sidebar rendering ───────────────────────────────────────────────────
function renderProjects() {
  const activeProject = getActiveProject(state);
  activeProjectName.textContent = activeProject?.name ?? "Orbit";
  // Update or attach the workspace folder badge next to the active project chip.
  renderActiveProjectFolderBadge(activeProject);
  projectsList.innerHTML = "";

  state.projects.forEach((project) => {
    const item = document.createElement("div");
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    item.className = `project-row${project.id === state.activeProjectId ? " is-active" : ""}`;
    const dotColor = colorForId(project.id);
    item.innerHTML = `
      <span class="folder-outline" style="--dot:${dotColor}"></span>
      <span class="project-meta">
        <span class="project-name"></span>
        <span class="project-subline"></span>
      </span>
      <button type="button" class="row-delete" aria-label="Delete project" title="Delete project">×</button>
    `;
    item.querySelector(".project-name").textContent = project.name;
    const subline = project.workspacePath
      ? `▤ ${basename(project.workspacePath)}`
      : (project.chats.at(-1)?.title ?? "No conversations yet");
    const sublineEl = item.querySelector(".project-subline");
    sublineEl.textContent = subline;
    if (project.workspacePath) sublineEl.title = project.workspacePath;
    item.addEventListener("click", () => {
      state = selectProject(state, project.id);
      render();
      persistState();
    });
    item.addEventListener("dblclick", () => renameProject(project.id));
    item.querySelector(".row-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteProject(project.id);
    });
    projectsList.append(item);
  });
}

function renderConversations() {
  const project = getActiveProject(state);
  conversationsList.innerHTML = "";
  if (!project?.chats.length) {
    conversationsList.innerHTML = `<div class="muted-row">No conversations yet</div>`;
    return;
  }
  [...project.chats].reverse().forEach((chat) => {
    const item = document.createElement("div");
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    item.className = `conversation-row${chat.id === state.activeChatId ? " is-active" : ""}`;
    item.innerHTML = `
      <span class="conversation-title"></span>
      <span class="conversation-age"></span>
      <button type="button" class="row-delete" aria-label="Delete conversation" title="Delete conversation">×</button>
    `;
    item.querySelector(".conversation-title").textContent = chat.title;
    item.querySelector(".conversation-age").textContent = formatAge(chat.createdAt);
    item.addEventListener("click", () => {
      state = { ...state, activeChatId: chat.id };
      render();
      persistState();
    });
    item.addEventListener("dblclick", () => renameChat(chat.id));
    item.querySelector(".row-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteChat(chat.id);
    });
    conversationsList.append(item);
  });
}

function renderFiles() {
  const project = getActiveProject(state);
  filesList.innerHTML = "";
  const files = project?.files ?? [];
  if (!files.length) {
    filesList.innerHTML = `<div class="muted-row">No files yet</div>`;
    return;
  }
  files.forEach((file, idx) => {
    const row = document.createElement("div");
    row.className = "file-row";
    row.innerHTML = `
      <span class="file-icon">▤</span>
      <span class="file-name" title=""></span>
      <button type="button" class="file-attach" title="Attach to next message">↑</button>
      <button type="button" class="file-remove" title="Remove from project">×</button>
    `;
    const nameEl = row.querySelector(".file-name");
    nameEl.textContent = basename(file.path);
    nameEl.title = file.path;
    row.querySelector(".file-attach").addEventListener("click", () => {
      addAttachment({ name: basename(file.path), path: file.path });
    });
    row.querySelector(".file-remove").addEventListener("click", () => {
      removeProjectFile(idx);
    });
    filesList.append(row);
  });
}

// ─── Message rendering ───────────────────────────────────────────────────
function renderMessages() {
  const activeChat = getActiveChat(state);
  const messages = activeChat?.messages ?? [];
  messagesEl.innerHTML = "";
  emptyState.hidden = messages.length > 0;
  messagesEl.hidden = messages.length === 0;

  let totalTokens = 0;
  messages.forEach((message) => {
    totalTokens += approxTokens(message.content);
    if (message.isToolResult) return;
    // Clarifying-question answers are shown inside the question card itself,
    // so don't also render them as a separate user bubble — keeps the whole
    // ask/answer exchange feeling like one message.
    if (message.role === "user" && typeof message.content === "string" && message.content.startsWith("**User's Answers:**")) return;
    const item = document.createElement("article");
    item.className = `message message-${message.role}`;
    item.dataset.msgId = message.id;
    const role = message.role === "user" ? "You" : "Voyager";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = `${role} · ${new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    item.append(meta);

    const body = document.createElement("div");
    body.className = "message-body";
    if (message.role === "assistant") {
      renderAssistantBody(message, body);
    } else {
      renderUserBody(message, body);
    }
    item.append(body);
    messagesEl.append(item);
  });

  chatStatTokens.textContent = `${formatTokens(totalTokens)} tk`;
  chatStatMessages.textContent = `${messages.filter((m) => !m.isToolResult).length} msg`;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderUserBody(message, container) {
  const txt = document.createElement("div");
  txt.className = "user-text";
  txt.innerHTML = renderMarkdown(message.content);
  container.append(txt);
  if (Array.isArray(message.attachments) && message.attachments.length) {
    const chips = document.createElement("div");
    chips.className = "user-attachments";
    message.attachments.forEach((a) => {
      const chip = document.createElement("span");
      chip.className = "attach-chip-inline";
      chip.textContent = `▤ ${a.name}`;
      chip.title = a.path;
      chips.append(chip);
    });
    container.append(chips);
  }
}

// Per-(message, partIndex) execution state for action cards. Survives
// re-renders so a card doesn't re-run every time the list refreshes.
const cardExecutionStates = {};
const READ_ONLY_TOOL_TYPES = new Set([
  "read_file", "list_workspace", "list_windows", "search_workspace",
  "list_dir", "git_status", "git_diff", "git_log"
]);
const AUTO_RUN_IN_AGENT_MODE = new Set([
  "execute_command", "write_file", "patch_file",
  "type_text", "click_pixel", "scroll", "keystroke", "focus_window", "wait_ms",
  "open_browser", "deploy_agent",
  "delete_file", "move_file", "create_directory"
]);


function renderAskUserQuestionsCard(part, messageId) {
  const card = document.createElement("div");
  card.className = "action-card action-ask-user-questions";
  
  const head = document.createElement("div");
  head.className = "action-card-head";
  head.innerHTML = `
    <span class="action-icon">❓</span>
    <span class="action-label" style="font-weight: 600; color: var(--accent-light);">Clarifying Questions</span>
    <span class="action-status status-idle"></span>
  `;
  card.append(head);

  const qList = parseQuestions(part.content || "");
  if (qList.length === 0) {
    const body = document.createElement("pre");
    body.className = "action-body";
    body.textContent = part.content;
    card.append(body);
    return card;
  }

  const formContainer = document.createElement("div");
  formContainer.className = "action-body ask-questions-form-container";
  
  const form = document.createElement("form");
  form.className = "ask-questions-form";
  
  const inputs = [];
  qList.forEach((q, idx) => {
    const qGroup = document.createElement("div");
    qGroup.className = "ask-question-group";
    qGroup.style.marginBottom = "14px";
    
    const label = document.createElement("label");
    label.className = "ask-question-label";
    label.style.display = "block";
    label.style.marginBottom = "6px";
    label.style.fontWeight = "500";
    label.style.color = "var(--fg-medium)";
    label.textContent = `${idx + 1}. ${q.text}`;
    qGroup.append(label);
    
    let inputEl;
    if (q.type === "select") {
      inputEl = document.createElement("select");
      inputEl.className = "ask-question-select";
      inputEl.style.width = "100%";
      inputEl.style.padding = "8px 12px";
      inputEl.style.borderRadius = "6px";
      inputEl.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
      inputEl.style.border = "1px solid rgba(255, 255, 255, 0.1)";
      inputEl.style.color = "var(--fg-light)";
      inputEl.style.outline = "none";
      
      q.options.forEach(opt => {
        const option = document.createElement("option");
        option.value = opt;
        option.textContent = opt;
        option.style.backgroundColor = "#1e1e1e";
        option.style.color = "#ffffff";
        inputEl.append(option);
      });
    } else {
      inputEl = document.createElement("input");
      inputEl.type = "text";
      inputEl.className = "ask-question-input";
      inputEl.placeholder = "Type your answer...";
      inputEl.style.width = "100%";
      inputEl.style.padding = "8px 12px";
      inputEl.style.borderRadius = "6px";
      inputEl.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
      inputEl.style.border = "1px solid rgba(255, 255, 255, 0.1)";
      inputEl.style.color = "var(--fg-light)";
      inputEl.style.outline = "none";
      
      // Prevent keystrokes from bubbling to window level
      inputEl.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
      });
    }
    
    qGroup.append(inputEl);
    form.append(qGroup);
    inputs.push({ questionText: q.text, element: inputEl });
  });
  
  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "ask-questions-submit-btn";
  submitBtn.textContent = "Submit Answers";
  submitBtn.style.padding = "8px 16px";
  submitBtn.style.borderRadius = "6px";
  submitBtn.style.backgroundColor = "var(--accent)";
  submitBtn.style.border = "none";
  submitBtn.style.color = "#ffffff";
  submitBtn.style.fontWeight = "600";
  submitBtn.style.cursor = "pointer";
  submitBtn.style.transition = "background-color 0.2s, transform 0.1s";
  
  submitBtn.addEventListener("mouseover", () => {
    submitBtn.style.backgroundColor = "var(--accent-light)";
  });
  submitBtn.addEventListener("mouseout", () => {
    submitBtn.style.backgroundColor = "var(--accent)";
  });
  
  // If a later user message already answered these questions, lock the card and
  // restore the submitted values so the Q&A stays visible as one unit (the
  // answer message itself is not rendered as a separate bubble — see
  // renderMessages). Values are parsed back by position from the answer text.
  let isAnswered = false;
  let priorAnswers = [];
  const chat = getActiveChat(state);
  if (chat) {
    const msgIdx = chat.messages.findIndex(m => m.id === messageId);
    if (msgIdx !== -1) {
      for (let i = msgIdx + 1; i < chat.messages.length; i++) {
        const m = chat.messages[i];
        if (m.role === "user" && typeof m.content === "string" && m.content.startsWith("**User's Answers:**")) {
          isAnswered = true;
          priorAnswers = m.content.split("\n")
            .map((line) => line.match(/^\s*\d+\.\s*.+?:\s?(.*)$/))
            .filter(Boolean)
            .map((mm) => mm[1]);
          break;
        }
      }
    }
  }

  if (isAnswered) {
    submitBtn.disabled = true;
    submitBtn.textContent = "✓ Answers Submitted";
    submitBtn.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
    submitBtn.style.color = "var(--fg-dark)";
    submitBtn.style.cursor = "default";
    inputs.forEach((inp, idx) => {
      if (priorAnswers[idx] !== undefined) inp.element.value = priorAnswers[idx];
      inp.element.disabled = true;
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isAnswered) return;
    isAnswered = true;
    
    let answersText = "**User's Answers:**\n";
    inputs.forEach((inp, idx) => {
      answersText += `${idx + 1}. ${inp.questionText}: ${inp.element.value}\n`;
    });
    
    submitBtn.disabled = true;
    submitBtn.textContent = "Answers Submitted";
    submitBtn.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
    submitBtn.style.color = "var(--fg-dark)";
    submitBtn.style.cursor = "default";
    inputs.forEach(inp => inp.element.disabled = true);

    sendMessage(answersText).catch(() => {});
  });

  // Append the submit button to the form — without this the card rendered with
  // no way to send the answers (the original bug: "I can answer but can't send").
  form.append(submitBtn);
  formContainer.append(form);
  card.append(formContainer);
  return card;
}

function renderAssistantBody(message, container) {
  const parts = parseAIResponse(message.content || "");
  if (!parts.length) {
    const p = document.createElement("div");
    p.className = "assistant-text";
    p.innerHTML = renderMarkdown(message.content || "");
    container.append(p);
    return;
  }
  let partIdx = 0;
  for (const part of parts) {
    if (part.type === "text") {
      const p = document.createElement("div");
      p.className = "assistant-text";
      p.innerHTML = renderMarkdown(part.content);
      container.append(p);
    } else if (part.type === "ask_user_questions") {
      container.append(renderAskUserQuestionsCard(part, message.id));
    } else {
      const cardKey = `${message.id}-${part.type}-${partIdx}`;
      container.append(renderActionCard(part, cardKey));
      partIdx++;
    }
  }
}

// After the message list re-renders, auto-fire any tool cards that haven't
// been started yet. Read-only tools always auto-fire. Other tools only
// auto-fire when the active mode is "agents". One per render to avoid
// hammering — the next card fires after its TOOL_RESULT comes back and
// triggers another AI turn → re-render → auto-fire loop.
function maybeAutoFireTools() {
  if (streaming) return;
  const chat = getActiveChat(state);
  if (!chat) return;
  for (let mi = chat.messages.length - 1; mi >= 0; mi--) {
    const msg = chat.messages[mi];
    if (msg.role !== "assistant" || msg.streaming || msg.isToolResult) continue;
    const parts = parseAIResponse(msg.content || "");
    let partIdx = 0;
    for (const part of parts) {
      // Mirror renderAssistantBody's indexing exactly so cardKeys match: text
      // and ask_user_questions parts don't consume a partIdx.
      if (part.type === "text" || part.type === "ask_user_questions") continue;
      const cardKey = `${msg.id}-${part.type}-${partIdx}`;
      partIdx++;
      const cardState = cardExecutionStates[cardKey];
      const canAuto = READ_ONLY_TOOL_TYPES.has(part.type)
        || (currentMode === "agents" && AUTO_RUN_IN_AGENT_MODE.has(part.type));
      if (!cardState && canAuto) {
        // Runaway guard: the auto-fire → tool → AI → re-render → auto-fire loop
        // has no natural end if the model keeps emitting tools. Cap it so it
        // can't loop forever. The counter resets on each fresh user message.
        if (agentStepsThisTurn >= MAX_AGENT_STEPS) {
          cardExecutionStates[cardKey] = {
            status: "error",
            error: `Auto-run paused after ${MAX_AGENT_STEPS} steps. Click Run to continue this tool, or send a new message.`
          };
          render();
          return;
        }
        agentStepsThisTurn += 1;
        cardExecutionStates[cardKey] = { status: "running" };
        executeToolPart(part, cardKey, msg.id).catch(() => {});
        return; // one at a time
      }
    }
    break; // only consider the most recent assistant message
  }
}

const TOOL_LABEL = {
  execute_command: "Run command",
  write_file: "Write file",
  patch_file: "Patch file",
  read_file: "Read file",
  list_workspace: "List workspace",
  list_windows: "List windows",
  search_workspace: "Search workspace",
  type_text: "Type text",
  click_pixel: "Click pixel",
  scroll: "Scroll",
  keystroke: "Keystroke",
  focus_window: "Focus window",
  wait_ms: "Wait",
  open_browser: "Open browser",
  deploy_agent: "Deploy agent",
  list_dir: "List directory",
  delete_file: "Delete file",
  move_file: "Move file",
  create_directory: "Create folder",
  git_status: "Git status",
  git_diff: "Git diff",
  git_log: "Git log"
};

function renderActionCard(part, cardKey) {
  const card = document.createElement("div");
  card.className = `action-card action-${part.type}`;
  card.dataset.cardKey = cardKey;
  const cardState = cardExecutionStates[cardKey] || { status: "idle" };

  const head = document.createElement("div");
  head.className = "action-card-head";
  const label = TOOL_LABEL[part.type] || part.type;
  const subtitle = part.type === "move_file" ? `${part.from} → ${part.to}`
    : part.type === "read_file" && part.start != null ? `${part.path} :${part.start}-${part.end}`
    : part.path ? part.path
    : part.window ? `→ ${part.window}`
    : part.url ? part.url
    : part.type === "click_pixel" || part.type === "scroll" ? `x=${part.x}, y=${part.y}${part.ticks != null ? `, ticks=${part.ticks}` : ""}`
    : part.type === "wait_ms" ? `${part.ms}ms`
    : part.query ? `"${part.query}"`
    : "";
  head.innerHTML = `
    <span class="action-icon"></span>
    <span class="action-label">${escapeHtml(label)}</span>
    ${subtitle ? `<span class="action-path">${escapeHtml(subtitle)}</span>` : ""}
    <span class="action-status status-${cardState.status}"></span>
  `;
  card.append(head);

  if (part.content) {
    const body = document.createElement("pre");
    body.className = "action-body";
    body.textContent = part.content.length > 1000 ? part.content.slice(0, 1000) + "\n…" : part.content;
    card.append(body);
  }

  // Result panel (output / error)
  if (cardState.output || cardState.error) {
    const out = document.createElement("pre");
    out.className = `action-result ${cardState.error ? "is-error" : "is-success"}`;
    out.textContent = cardState.error || (cardState.output.length > 1500 ? cardState.output.slice(0, 1500) + "\n…(truncated)" : cardState.output);
    card.append(out);
  }

  // Footer: Run button + status
  const footer = document.createElement("div");
  footer.className = "action-card-footer";
  const statusText = ({
    idle: "Idle",
    running: "Running…",
    success: "✓ Done",
    error: "× Failed"
  })[cardState.status] || cardState.status;
  footer.innerHTML = `<span class="action-status-text">${statusText}</span>`;
  if (cardState.status === "idle" || cardState.status === "error") {
    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "action-run-btn";
    runBtn.textContent = cardState.status === "error" ? "Retry" : "Run";
    runBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      cardExecutionStates[cardKey] = { status: "running" };
      const msgId = card.closest("[data-msg-id]")?.dataset.msgId;
      executeToolPart(part, cardKey, msgId).catch(() => {});
      render();
    });
    footer.append(runBtn);
  }
  card.append(footer);

  return card;
}

// Dispatch one tool to the right preload API, persist the result on the
// card, append a [TOOL_RESULT] user message so the AI sees it next turn,
// then re-render and trigger a follow-up AI turn.
async function executeToolPart(part, cardKey, messageId) {
  const activeProject = getActiveProject(state);
  const workspacePath = activeProject?.workspacePath || "";
  let toolResult = "";
  let ok = true;
  let output = "";

  try {
    switch (part.type) {
      case "execute_command": {
        if (!workspacePath) { ok = false; output = "No project folder set."; break; }
        const res = await window.orbit.runWorkspaceCommand({ workspacePath, command: (part.content || "").trim(), shell: part.shell || undefined });
        ok = !!res?.ok;
        output = `exit code: ${res?.exitCode}\n${(res?.stdout || "").trim()}${res?.stderr ? "\n--- stderr ---\n" + res.stderr.trim() : ""}`.trim() || "(no output)";
        toolResult = `[TOOL_RESULT: execute_command]\n${output}`;
        break;
      }
      case "write_file": {
        if (!workspacePath) { ok = false; output = "No project folder set."; break; }
        const res = await window.orbit.writeWorkspaceFile({ workspacePath, relativePath: part.path, content: part.content || "" });
        ok = !!res?.ok;
        output = ok ? `Wrote ${part.path}` : (res?.error || "Write failed");
        toolResult = `[TOOL_RESULT: write_file path="${part.path}"]\n${output}`;
        break;
      }
      case "patch_file": {
        // No dedicated patch IPC in this app yet — fall back to read+apply+write.
        if (!workspacePath) { ok = false; output = "No project folder set."; break; }
        const read = await window.orbit.readWorkspaceFile({ workspacePath, relativePath: part.path });
        if (!read?.ok) { ok = false; output = `Read failed: ${read?.error || "unknown"}`; toolResult = `[TOOL_RESULT: patch_file path="${part.path}" FAILED] ${output}`; break; }
        const { applySearchReplacePatches } = await import("../shared/parser.js");
        let next;
        try { next = applySearchReplacePatches(read.content, part.content || ""); }
        catch (e) { ok = false; output = `Patch failed: ${e.message}`; toolResult = `[TOOL_RESULT: patch_file path="${part.path}" FAILED] ${output}`; break; }
        const write = await window.orbit.writeWorkspaceFile({ workspacePath, relativePath: part.path, content: next });
        ok = !!write?.ok;
        output = ok ? `Patched ${part.path}` : (write?.error || "Write failed");
        toolResult = `[TOOL_RESULT: patch_file path="${part.path}"]\n${output}`;
        break;
      }
      case "read_file": {
        if (!workspacePath) { ok = false; output = "No project folder set."; break; }
        const res = await window.orbit.readWorkspaceFile({ workspacePath, relativePath: part.path });
        ok = !!res?.ok;
        if (ok && part.start != null && part.end != null) {
          // Precise line-range read: slice the requested 1-indexed range and
          // prefix each line with its number so the model can cite path:line.
          const lines = String(res.content).split(/\r?\n/);
          const start = Math.max(1, part.start);
          const end = Math.min(lines.length, part.end);
          output = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join("\n");
          toolResult = `[TOOL_RESULT: read_file path="${part.path}" lines=${start}-${end}]\n${truncateForAI(output)}`;
        } else {
          output = ok ? res.content : (res?.error || "Read failed");
          toolResult = `[TOOL_RESULT: read_file path="${part.path}"]\n${truncateForAI(output)}`;
        }
        break;
      }
      case "list_dir": {
        if (!workspacePath) { ok = false; output = "No project folder set."; break; }
        const res = await window.orbit.getWorkspaceInfo(workspacePath);
        if (res && res.ok !== false) {
          ok = true;
          const prefix = (part.path || "").replace(/^[./]+|\/+$/g, "");
          const all = (res.files || []).map((f) => (typeof f === "string" ? f : f.path));
          const inDir = prefix
            ? all.filter((p) => p === prefix || p.startsWith(prefix + "/"))
            : all;
          // Collapse to the immediate children (files + subfolders) of the dir.
          const depth = prefix ? prefix.split("/").length : 0;
          const children = new Set();
          for (const p of inDir) {
            const segs = p.split("/");
            if (segs.length > depth + 1) children.add(segs.slice(0, depth + 1).join("/") + "/");
            else children.add(p);
          }
          const list = Array.from(children).sort();
          output = list.length ? list.map((c) => `- ${c}`).join("\n") : "(empty or no such directory)";
        } else {
          ok = false; output = res?.error || "list_dir failed";
        }
        toolResult = `[TOOL_RESULT: list_dir path="${part.path}"]\n${output}`;
        break;
      }
      case "delete_file": {
        if (!workspacePath) { ok = false; output = "No project folder set."; break; }
        const res = await window.orbit.deleteWorkspaceFile({ workspacePath, relativePath: part.path });
        ok = !!res?.ok;
        output = ok ? `Deleted ${part.path}` : (res?.error || "delete failed");
        toolResult = `[TOOL_RESULT: delete_file path="${part.path}"]\n${output}`;
        break;
      }
      case "move_file": {
        if (!workspacePath) { ok = false; output = "No project folder set."; break; }
        const res = await window.orbit.moveWorkspaceFile({ workspacePath, from: part.from, to: part.to });
        ok = !!res?.ok;
        output = ok ? `Moved ${part.from} → ${part.to}` : (res?.error || "move failed");
        toolResult = `[TOOL_RESULT: move_file]\n${output}`;
        break;
      }
      case "create_directory": {
        if (!workspacePath) { ok = false; output = "No project folder set."; break; }
        const res = await window.orbit.createWorkspaceDir({ workspacePath, relativePath: part.path });
        ok = !!res?.ok;
        output = ok ? `Created ${part.path}` : (res?.error || "mkdir failed");
        toolResult = `[TOOL_RESULT: create_directory path="${part.path}"]\n${output}`;
        break;
      }
      case "git_status":
      case "git_diff":
      case "git_log": {
        if (!workspacePath) { ok = false; output = "No project folder set."; break; }
        const cmd = part.type === "git_status"
          ? "git status --porcelain=v1 -b"
          : part.type === "git_diff"
            ? `git --no-pager diff${part.path ? ` -- "${part.path}"` : ""}`
            : `git --no-pager log --oneline -n ${Math.min(Math.max(part.count || 20, 1), 100)}`;
        const res = await window.orbit.runWorkspaceCommand({ workspacePath, command: cmd });
        ok = !!res?.ok;
        output = `${(res?.stdout || "").trim()}${res?.stderr ? "\n--- stderr ---\n" + res.stderr.trim() : ""}`.trim() || "(no output)";
        toolResult = `[TOOL_RESULT: ${part.type}]\n${truncateForAI(output)}`;
        break;
      }
      case "list_workspace": {
        if (!workspacePath) { ok = false; output = "No project folder set."; break; }
        const res = await window.orbit.getWorkspaceInfo(workspacePath);
        if (res && res.ok !== false) {
          const files = res.files || [];
          ok = true;
          output = files.slice(0, 250).map((f) => `- ${typeof f === "string" ? f : f.path}`).join("\n") + (files.length > 250 ? `\n…and ${files.length - 250} more` : "");
        } else {
          ok = false; output = res?.error || "list_workspace failed";
        }
        toolResult = `[TOOL_RESULT: list_workspace]\n${output}`;
        break;
      }
      case "search_workspace": {
        if (!workspacePath) { ok = false; output = "No project folder set."; break; }
        const res = await window.orbit.searchWorkspace({ workspacePath, query: part.query, isRegex: part.mode === "regex" });
        ok = !!res?.ok;
        output = ok
          ? (res.results || []).map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") || "(no matches)"
          : (res?.error || "search failed");
        toolResult = `[TOOL_RESULT: search_workspace]\n${truncateForAI(output)}`;
        break;
      }
      case "list_windows": {
        const res = await window.orbit.listWindows();
        ok = !!res?.ok;
        output = ok
          ? (res.windows || []).map((w) => `[${w.pid}] ${w.processName} — "${w.title}"`).join("\n")
          : (res?.error || "list_windows failed");
        toolResult = `[TOOL_RESULT: list_windows]\n${output}`;
        break;
      }
      case "type_text": {
        const res = await window.orbit.typeIntoWindow({ windowTitle: part.window || null, text: part.content || "" });
        ok = !!res?.ok;
        output = ok ? `Typed ${(part.content || "").length} chars` : (res?.error || "type failed");
        toolResult = `[TOOL_RESULT: type_text${part.window ? ` window="${part.window}"` : ""}]\n${output}`;
        break;
      }
      case "click_pixel": {
        const res = await window.orbit.clickPixel({ x: part.x, y: part.y, button: part.button || "left", count: part.count || 1 });
        ok = !!res?.ok;
        output = ok ? `Clicked (${part.x}, ${part.y})` : (res?.error || "click failed");
        toolResult = `[TOOL_RESULT: click_pixel x=${part.x} y=${part.y}]\n${output}`;
        break;
      }
      case "scroll": {
        const res = await window.orbit.scrollAt({ x: part.x, y: part.y, ticks: part.ticks });
        ok = !!res?.ok;
        output = ok ? `Scrolled ${part.ticks} ticks at (${part.x}, ${part.y})` : (res?.error || "scroll failed");
        toolResult = `[TOOL_RESULT: scroll]\n${output}`;
        break;
      }
      case "keystroke": {
        const res = await window.orbit.keystroke({ windowTitle: part.window || null, keys: part.content || "" });
        ok = !!res?.ok;
        output = ok ? `Sent "${part.content}"` : (res?.error || "keystroke failed");
        toolResult = `[TOOL_RESULT: keystroke]\n${output}`;
        break;
      }
      case "focus_window": {
        const res = await window.orbit.focusWindow({ windowTitle: part.window });
        ok = !!res?.ok;
        output = ok ? `Focused "${part.window}"` : (res?.error || "focus failed");
        toolResult = `[TOOL_RESULT: focus_window]\n${output}`;
        break;
      }
      case "wait_ms": {
        const res = await window.orbit.waitMs({ ms: part.ms });
        ok = true;
        output = `Waited ${res?.waitedMs ?? part.ms}ms`;
        toolResult = `[TOOL_RESULT: wait_ms]\n${output}`;
        break;
      }
      case "open_browser": {
        const res = await window.orbit.openBrowser({ url: part.url });
        ok = !!res?.ok;
        output = ok ? `Opened ${part.url}` : (res?.error || "open_browser failed");
        toolResult = `[TOOL_RESULT: open_browser]\n${output}`;
        break;
      }
      case "deploy_agent": {
        if (!workspacePath) { ok = false; output = "No project folder set."; break; }
        const res = await window.orbit.deployAgent({ workspacePath, task: part.task, model: selectedModel });
        ok = !!res?.ok;
        output = ok ? `Deployed agent ${res.agentId}` : (res?.error || "deploy failed");
        toolResult = `[TOOL_RESULT: deploy_agent]\n${output}`;
        break;
      }
      default:
        ok = false;
        output = `Unknown tool: ${part.type}`;
        toolResult = `[TOOL_RESULT: ${part.type} FAILED]\n${output}`;
    }
  } catch (err) {
    ok = false;
    output = err?.message || String(err);
    toolResult = `[TOOL_RESULT: ${part.type} FAILED]\n${output}`;
  }

  cardExecutionStates[cardKey] = { status: ok ? "success" : "error", output, error: ok ? null : output };

  // Append a synthetic user message carrying the tool result so the AI can
  // act on it next turn. Marked isToolResult so it doesn't render in the UI.
  state = addMessageToActiveChat(state, {
    id: crypto.randomUUID(),
    role: "user",
    content: toolResult,
    timestamp: new Date().toISOString(),
    isToolResult: true
  });
  render();
  persistState();

  // Continue the conversation so the AI can react. Skip if currently streaming
  // (something else is in flight) — the auto-fire loop will pick up the next
  // pending card after the current turn settles.
  if (!streaming) await triggerAITurn({ attachmentsForThisTurn: [] });
}

function truncateForAI(s) {
  const v = String(s || "");
  if (v.length <= 12000) return v;
  return v.slice(0, 12000) + `\n\n[…truncated ${v.length - 12000} chars…]`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatTokens(n) {
  if (n < 1000) return n;
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}

// ─── Send pipeline ───────────────────────────────────────────────────────
function titleFromPrompt(prompt) {
  const clean = prompt.replace(/\s+/g, " ").trim();
  if (!clean) return "New Conversation";
  return clean.length > 32 ? `${clean.slice(0, 32)}…` : clean;
}

function maybeRetitleFirstChat() {
  const project = getActiveProject(state);
  const chat = getActiveChat(state);
  if (!project || !chat) return;
  // Only retitle if it still has the default name
  if (chat.title && chat.title !== "New Conversation" && chat.title !== "Voyager AI") return;
  const title = titleFromPrompt(promptInput.value);
  state = {
    ...state,
    projects: state.projects.map((p) => {
      if (p.id !== state.activeProjectId) return p;
      return {
        ...p,
        chats: p.chats.map((c) => (c.id === state.activeChatId ? { ...c, title } : c))
      };
    })
  };
}

async function sendMessage(rawText) {
  const text = rawText.trim();
  if (!text) return;
  if (streaming) return; // already in flight

  if (text.startsWith("/")) {
    const handled = await tryRunSlashCommand(text);
    if (handled) {
      promptInput.value = "";
      autoResize();
      return;
    }
  }

  // Fresh user turn — reset the autonomous tool-loop counter so the agent
  // loop can run again from zero for this request.
  agentStepsThisTurn = 0;

  const attachmentsSnapshot = attachedFiles.slice();
  const userMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: text,
    timestamp: new Date().toISOString(),
    attachments: attachmentsSnapshot
  };

  maybeRetitleFirstChat();
  state = addMessageToActiveChat(state, userMessage);
  promptInput.value = "";
  attachedFiles = [];
  renderAttachedRow();
  autoResize();
  render();
  persistState();

  await triggerAITurn({ attachmentsForThisTurn: attachmentsSnapshot });
}

// One round-trip with the AI: capture screenshot if needed, append a
// streaming assistant placeholder, stream chunks in, and finalize. Used
// both by sendMessage and by tool-result follow-ups (which pass `null`
// attachments).
// Build a compact workspace context for the AI: path, file count, and the
// top-level entries. The main process expects `workspaceContext` (not a raw
// path), and ai-service uses this to tell the model which folder is open.
async function buildWorkspaceContext(workspacePath) {
  if (!workspacePath) return null;
  try {
    const info = await window.orbit?.getWorkspaceInfo?.(workspacePath);
    const files = (info?.files || []).map((f) => (typeof f === "string" ? f : f.path)).filter(Boolean);
    const topLevel = new Set();
    for (const f of files) {
      const head = f.split("/")[0];
      if (head) topLevel.add(head);
    }
    return {
      path: info?.path || workspacePath,
      fileCount: files.length,
      topLevel: Array.from(topLevel).slice(0, 40).sort(),
      files: files.slice(0, 250)
    };
  } catch {
    return { path: workspacePath, fileCount: 0, topLevel: [] };
  }
}

async function triggerAITurn({ attachmentsForThisTurn = [] } = {}) {
  if (streaming) return;
  streaming = true;
  sendButton.disabled = false; // keep enabled so it can act as a Stop button
  sendButton.classList.add("is-streaming");
  sendButton.title = "Stop";

  const streamId = crypto.randomUUID();
  currentStreamId = streamId;
  streamingMessageId = crypto.randomUUID();
  state = addMessageToActiveChat(state, {
    id: streamingMessageId,
    role: "assistant",
    content: "",
    timestamp: new Date().toISOString(),
    streaming: true
  });
  render();
  decorateStreamingMessage();

  let chunkOff = null;
  if (window.orbit?.onAIChunk) {
    chunkOff = window.orbit.onAIChunk((data) => {
      if (!data || data.streamId !== streamId) return;
      if (typeof data.text === "string" && data.text) appendStreamingDelta(data.text);
    });
  }

  let screenshotPath = null;
  if (pendingRegionShot) {
    screenshotPath = pendingRegionShot;
    pendingRegionShot = null;
  } else if (attachScreenshot) {
    try { screenshotPath = await window.orbit?.captureScreen?.(); } catch { /* ignore */ }
  }

  const activeChat = getActiveChat(state);
  const cleanMessages = activeChat.messages.filter((m) => !m.streaming);

  let finalText = "";
  let stopped = false;
  try {
    const activeProject = getActiveProject(state);
    const workspaceContext = await buildWorkspaceContext(activeProject?.workspacePath || "");
    const response = await window.orbit?.sendToAI?.({
      streamId,
      model: selectedModel,
      messages: cleanMessages,
      screenshotPath,
      attachments: attachmentsForThisTurn.map((a) => a.path),
      workspaceContext,
      agentMode: currentMode === "agents",
      mode: currentMode,
      preset: selectedPreset
    });
    if (response && response.ok === false) {
      // Backend reported a failure (e.g. user Stop, auth, timeout). Show it
      // instead of silently leaving an empty bubble.
      stopped = !!response.stopped;
      finalText = stopped
        ? (getStreamedText() || "_Stopped._")
        : `_Request failed: ${response.error || "unknown error"}_`;
    } else {
      finalText = response?.text || response?.content || "";
    }
  } catch (err) {
    finalText = `_Request failed: ${err?.message || err}_`;
  } finally {
    if (chunkOff) try { chunkOff(); } catch { /* ignore */ }
  }

  const finalizedId = streamingMessageId;
  state = {
    ...state,
    projects: state.projects.map((p) => {
      if (p.id !== state.activeProjectId) return p;
      return {
        ...p,
        chats: p.chats.map((c) => {
          if (c.id !== state.activeChatId) return c;
          return {
            ...c,
            messages: c.messages.map((m) => (m.id === finalizedId ? { ...m, content: finalText || m.content || "_(empty response)_", streaming: false } : m))
          };
        })
      };
    })
  };
  streamingMessageId = null;
  streaming = false;
  currentStreamId = null;
  sendButton.disabled = false;
  sendButton.classList.remove("is-streaming");
  sendButton.title = "Send";
  render();
  persistState();
}

// Read whatever text already streamed into the in-flight assistant bubble so a
// stopped response can keep the partial content instead of discarding it.
function getStreamedText() {
  const chat = getActiveChat(state);
  const msg = chat?.messages.find((m) => m.id === streamingMessageId);
  return (msg?.content || "").trim();
}

function decorateStreamingMessage() {
  if (!streamingMessageId) return;
  const el = messagesEl.querySelector(`[data-msg-id="${streamingMessageId}"]`);
  if (el) el.classList.add("is-streaming");
}

function appendStreamingDelta(delta) {
  // Mutate state.content for the streaming message and rerender ONLY that
  // message's body to avoid recomputing the whole list each chunk.
  if (!streamingMessageId) return;
  let target = null;
  state = {
    ...state,
    projects: state.projects.map((p) => {
      if (p.id !== state.activeProjectId) return p;
      return {
        ...p,
        chats: p.chats.map((c) => {
          if (c.id !== state.activeChatId) return c;
          return {
            ...c,
            messages: c.messages.map((m) => {
              if (m.id !== streamingMessageId) return m;
              target = { ...m, content: (m.content || "") + delta };
              return target;
            })
          };
        })
      };
    })
  };
  const el = messagesEl.querySelector(`[data-msg-id="${streamingMessageId}"]`);
  if (el && target) {
    const body = el.querySelector(".message-body");
    if (body) {
      body.innerHTML = "";
      renderAssistantBody(target, body);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }
}

// ─── Projects / chats CRUD ───────────────────────────────────────────────
async function createProject() {
  const count = state.projects.length + 1;
  const defaultName = `New Project ${count}`;
  const name = await showCustomPrompt({ title: "New Project", message: "Enter a name for the new project:", defaultValue: defaultName });
  if (name == null) return; // cancelled
  let workspacePath = "";
  try {
    workspacePath = (await window.orbit?.selectWorkspaceDir?.()) || "";
  } catch { /* user cancelled or no picker */ }
  if (!workspacePath) {
    const proceed = await showCustomConfirm({
      title: "No Folder Selected",
      message: "Create the project anyway? (You can attach a folder later from the project chip.)",
      confirmText: "Create Project",
      cancelText: "Cancel"
    });
    if (!proceed) return;
  }
  const now = new Date().toISOString();
  const project = {
    id: crypto.randomUUID(),
    name: name.trim() || defaultName,
    workspacePath,
    updatedAt: now,
    files: [],
    chats: [
      { id: crypto.randomUUID(), title: "New Conversation", createdAt: now, messages: [] }
    ]
  };
  state = {
    ...state,
    activeProjectId: project.id,
    activeChatId: project.chats[0].id,
    projects: [...state.projects, project]
  };
  render();
  persistState();
  toast(`Created "${project.name}"${workspacePath ? ` · ${basename(workspacePath)}` : ""}`, "success", 4000);
}

async function changeProjectFolder(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;
  let workspacePath = "";
  try {
    workspacePath = (await window.orbit?.selectWorkspaceDir?.()) || "";
  } catch { /* ignore */ }
  if (!workspacePath) return;
  state = {
    ...state,
    projects: state.projects.map((p) => (p.id === projectId ? { ...p, workspacePath } : p))
  };
  render();
  persistState();
  toast(`Folder set: ${basename(workspacePath)}`, "success");
}

async function renameProject(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;
  const next = await showCustomPrompt({ title: "Rename Project", message: "Enter new name for the project:", defaultValue: project.name });
  if (next == null) return;
  state = {
    ...state,
    projects: state.projects.map((p) => (p.id === projectId ? { ...p, name: next.trim() || p.name } : p))
  };
  render();
  persistState();
}

async function deleteChat(chatId) {
  const project = getActiveProject(state);
  const chat = project?.chats.find((c) => c.id === chatId);
  if (!project || !chat) return;
  const proceed = await showCustomConfirm({
    title: "Delete Conversation",
    message: `Delete "${chat.title}"?\n\nThis will remove the conversation and its messages permanently.`,
    isDanger: true,
    confirmText: "Delete",
    cancelText: "Cancel"
  });
  if (!proceed) return;
  const remaining = project.chats.filter((c) => c.id !== chatId);
  // If we just deleted the last chat in this project, leave one empty chat
  // behind so the user always has something to type into.
  const nextChats = remaining.length > 0
    ? remaining
    : [{ id: crypto.randomUUID(), title: "New Conversation", createdAt: new Date().toISOString(), messages: [] }];
  const newActiveId = state.activeChatId === chatId ? nextChats[nextChats.length - 1].id : state.activeChatId;
  state = {
    ...state,
    activeChatId: newActiveId,
    projects: state.projects.map((p) => (p.id === project.id ? { ...p, chats: nextChats } : p))
  };
  // If the streaming response targeted this chat, drop the in-flight marker
  // so the next AI response can't write to a dead chat.
  if (streamingMessageId) streamingMessageId = null;
  render();
  persistState();
  toast(`Deleted "${chat.title}"`, "success");
}

async function deleteProject(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;
  if (state.projects.length === 1) {
    toast("Can't delete the only project. Create another first.", "error", 4000);
    return;
  }
  const proceed = await showCustomConfirm({
    title: "Delete Project",
    message: `Delete project "${project.name}"?\n\nAll ${project.chats.length} conversation(s) inside will be permanently deleted.`,
    isDanger: true,
    confirmText: "Delete Project",
    cancelText: "Cancel"
  });
  if (!proceed) return;
  const remaining = state.projects.filter((p) => p.id !== projectId);
  const nextActive = remaining[0];
  state = {
    ...state,
    projects: remaining,
    activeProjectId: state.activeProjectId === projectId ? nextActive.id : state.activeProjectId,
    activeChatId: state.activeProjectId === projectId ? nextActive.chats[0]?.id : state.activeChatId
  };
  render();
  persistState();
  toast(`Deleted "${project.name}"`, "success");
}

async function renameChat(chatId) {
  const project = getActiveProject(state);
  const chat = project?.chats.find((c) => c.id === chatId);
  if (!chat) return;
  const next = await showCustomPrompt({ title: "Rename Conversation", message: "Enter new name for the conversation:", defaultValue: chat.title });
  if (next == null) return;
  state = {
    ...state,
    projects: state.projects.map((p) => {
      if (p.id !== state.activeProjectId) return p;
      return { ...p, chats: p.chats.map((c) => (c.id === chatId ? { ...c, title: next.trim() || c.title } : c)) };
    })
  };
  render();
  persistState();
}

async function addFilesToProject() {
  const project = getActiveProject(state);
  if (!project) return;
  let path = null;
  try {
    path = await window.orbit?.selectWorkspaceDir?.();
  } catch { /* ignore */ }
  if (!path) {
    // Fall back to inviting them to drop a file
    toast("File picker not available; drag a file onto the window instead.", "default", 5000);
    return;
  }
  state = {
    ...state,
    projects: state.projects.map((p) => {
      if (p.id !== project.id) return p;
      const existing = (p.files || []).some((f) => f.path === path);
      if (existing) return p;
      return { ...p, files: [...(p.files || []), { path }] };
    })
  };
  render();
  persistState();
  toast(`Attached ${basename(path)} to project`, "success");
}

function removeProjectFile(idx) {
  const project = getActiveProject(state);
  if (!project) return;
  state = {
    ...state,
    projects: state.projects.map((p) => {
      if (p.id !== project.id) return p;
      return { ...p, files: (p.files || []).filter((_, i) => i !== idx) };
    })
  };
  render();
  persistState();
}

// ─── Composer: attachments ──────────────────────────────────────────────
function addAttachment(att) {
  if (attachedFiles.some((a) => a.path === att.path)) return;
  attachedFiles.push(att);
  renderAttachedRow();
}

function renderAttachedRow() {
  attachedFilesRow.innerHTML = "";
  if (attachedFiles.length === 0) {
    attachedFilesRow.hidden = true;
    return;
  }
  attachedFilesRow.hidden = false;
  attachedFiles.forEach((a, idx) => {
    const chip = document.createElement("span");
    chip.className = "attach-chip";
    chip.innerHTML = `<span>▤ ${escapeHtml(a.name)}</span><button type="button" aria-label="Remove">×</button>`;
    chip.title = a.path;
    chip.querySelector("button").addEventListener("click", () => {
      attachedFiles.splice(idx, 1);
      renderAttachedRow();
    });
    attachedFilesRow.append(chip);
  });
}

async function attachViaPicker() {
  try {
    const files = await window.orbit?.selectFiles?.();
    if (!Array.isArray(files) || files.length === 0) return;
    files.forEach((f) => addAttachment({ name: f.name || basename(f.path), path: f.path }));
    toast(files.length === 1 ? `Attached ${files[0].name}` : `Attached ${files.length} files`, "success");
  } catch (err) {
    toast(`Attach failed: ${err.message}`, "error");
  }
}

async function captureRegionForNextMessage() {
  try {
    const path = await window.orbit?.captureRegion?.();
    if (path) {
      pendingRegionShot = path;
      toast("Region captured — it will be attached to your next message.", "success");
    }
  } catch (err) {
    toast(`Region capture failed: ${err.message}`, "error");
  }
}

// ─── Slash command handling ─────────────────────────────────────────────
async function tryRunSlashCommand(input) {
  const c = input.trim();
  const head = c.split(/\s+/)[0].toLowerCase();
  switch (head) {
    case "/clear":
      clearActiveChat();
      return true;
    case "/ask":
    case "/agents":
    case "/planning":
      setMode(head.slice(1));
      return true;
    case "/screenshot":
      attachScreenshot = !attachScreenshot;
      updateScreenshotToggleUI();
      persistState();
      toast(attachScreenshot ? "Screenshot will be auto-attached" : "Screenshot detach", "success");
      return true;
    case "/region":
      await captureRegionForNextMessage();
      return true;
    case "/calibrate":
      openCalibrationModal();
      return true;
    case "/summon-agents": {
      const rest = c.slice("/summon-agents".length).trim();
      const m = rest.match(/^(\d+)\s+(.+)$/s);
      if (!m) {
        toast("Usage: /summon-agents <N> <task>", "error", 5000);
        return true;
      }
      const n = Math.max(1, Math.min(8, parseInt(m[1], 10)));
      const task = m[2].trim();
      const workspacePath = getActiveProject(state)?.workspacePath || state.workspacePath || null;
      if (!workspacePath) {
        toast("This project has no folder. Click ▤ Choose folder above the chat to set one.", "error", 6000);
        return true;
      }
      toast(`Summoning ${n} agents…`, "success");
      const launches = Array.from({ length: n }, () =>
        window.orbit?.deployAgent?.({ workspacePath, task, model: selectedModel }).catch((e) => ({ ok: false, error: e?.message }))
      );
      Promise.all(launches).then((rs) => {
        const ok = rs.filter((r) => r && r.ok).length;
        toast(`Summoned ${ok}/${rs.length}`, ok === rs.length ? "success" : "error");
      });
      return true;
    }
    default:
      return false; // let it flow to AI as a template prompt
  }
}

function clearActiveChat() {
  const project = getActiveProject(state);
  const chat = getActiveChat(state);
  if (!project || !chat) return;
  state = {
    ...state,
    projects: state.projects.map((p) => {
      if (p.id !== project.id) return p;
      return { ...p, chats: p.chats.map((c) => (c.id === chat.id ? { ...c, messages: [] } : c)) };
    })
  };
  render();
  persistState();
  toast("Conversation cleared", "success");
}

// ─── Slash menu autocomplete ────────────────────────────────────────────
let slashSelectedIdx = 0;
let slashFiltered = [];

function updateSlashMenu() {
  const value = promptInput.value;
  if (!value.startsWith("/")) {
    hideSlashMenu();
    return;
  }
  const q = value.split(/\s+/)[0].toLowerCase();
  slashFiltered = SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
  if (!slashFiltered.length) {
    hideSlashMenu();
    return;
  }
  slashSelectedIdx = Math.min(slashSelectedIdx, slashFiltered.length - 1);
  slashMenuEl.innerHTML = slashFiltered.map((cmd, i) => `
    <div class="slash-item${i === slashSelectedIdx ? " is-selected" : ""}" data-cmd="${cmd.name}">
      <span class="slash-name">${cmd.name}</span>
      <span class="slash-desc">${escapeHtml(cmd.desc)}</span>
    </div>
  `).join("");
  slashMenuEl.hidden = false;
  slashMenuEl.querySelectorAll(".slash-item").forEach((el) => {
    el.addEventListener("click", () => {
      promptInput.value = el.dataset.cmd + " ";
      hideSlashMenu();
      promptInput.focus();
    });
  });
}

function hideSlashMenu() {
  slashFiltered = [];
  slashSelectedIdx = 0;
  slashMenuEl.hidden = true;
}

// ─── Mode + model selectors ─────────────────────────────────────────────
function setMode(mode) {
  if (!MODES.includes(mode)) return;
  currentMode = mode;
  modeButton.textContent = MODE_LABELS[mode];
  modeButton.dataset.mode = mode;
  persistState();
}

function cycleMode() {
  const idx = MODES.indexOf(currentMode);
  setMode(MODES[(idx + 1) % MODES.length]);
  toast(`Mode: ${currentMode}`, "success", 1500);
}

function expandSelectedModelCategory() {
  modelSelectOptions.querySelectorAll(".custom-select-category").forEach((cat) => {
    const hasSel = !!cat.querySelector(".custom-select-option.selected");
    cat.classList.toggle("is-open", hasSel);
  });
}

function setSelectedModel(name) {
  selectedModel = name;
  modelSelectLabel.textContent = name;
  modelSelectOptions.querySelectorAll(".custom-select-option").forEach((o) => {
    o.classList.toggle("selected", o.dataset.value === name);
  });
  persistState();
}

// ─── Mic with visualizer (local Whisper, same as the overlay) ─────────────
// The app used to use the cloud Web Speech API (webkitSpeechRecognition),
// which streams mic audio to Google and was failing (net::ERR_FAILED on the
// upload stream) on this machine. We now record locally and transcribe with
// the offline Whisper model — identical to the overlay, no network upload.

// Pick the most likely real microphone instead of trusting the system default,
// which is often a virtual/dead input (Stereo Mix, loopback) that records
// silence — the reason dictation "detected nothing". Mirrors the overlay.
async function pickBestMicDeviceId() {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch { /* user may still grant below */ }
  let inputs = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    inputs = devices.filter((d) => d.kind === "audioinput");
  } catch { return null; }
  if (inputs.length === 0) return null;
  const score = (label) => {
    const l = (label || "").toLowerCase();
    if (!l) return 0;
    if (/(voicemod|stereo mix|line in|cable|vb-audio|voicemeeter|virtual|loopback|hdmi|monitor of|nvidia broadcast|krisp)/.test(l)) return -50;
    if (l.startsWith("default -") || l.startsWith("communications -")) return -5;
    if (/(razer|blackshark|hyperx|steelseries|sennheiser|shure|blue yeti|samson|rode|audio[- ]technica|airpods|jabra|logitech)/.test(l)) return 100;
    if (/(microphone|mic|headset|bluetooth)/.test(l)) return 10;
    return 1;
  };
  inputs.sort((a, b) => score(b.label) - score(a.label));
  return inputs[0]?.deviceId || null;
}

async function startMic() {
  if (isListening) return;
  audioChunks = [];
  try {
    const deviceId = await pickBestMicDeviceId();
    const audioConstraints = { echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1, sampleRate: 48000 };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };
    micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    const track = micStream.getAudioTracks()[0];
    if (track) console.log(`[App Mic] recording via "${track.label}"`);
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    const src = audioCtx.createMediaStreamSource(micStream);
    micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 64;
    src.connect(micAnalyser);
  } catch (err) {
    toast(`Mic access denied: ${err.message}`, "error");
    return;
  }

  let mimeType = "audio/webm";
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) mimeType = "audio/webm;codecs=opus";

  try {
    mediaRecorder = new MediaRecorder(micStream, { mimeType });
  } catch (err) {
    toast(`Recorder failed: ${err.message}`, "error");
    teardownMic();
    return;
  }

  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    const blob = new Blob(audioChunks, { type: mimeType });
    teardownMic();
    const prevPlaceholder = promptInput.placeholder;
    micButton.disabled = true;
    promptInput.placeholder = "Transcribing with Whisper…";
    try {
      const transcript = await transcribeWithWhisper(blob, {
        onProgress: (p) => {
          if (p.status === "progress" && p.file && p.progress != null) {
            promptInput.placeholder = `Downloading Whisper model… ${Math.round(p.progress)}%`;
          }
        }
      });
      if (transcript) {
        promptInput.value = (promptInput.value ? promptInput.value.trim() + " " : "") + transcript;
        autoResize();
        promptInput.focus();
      } else {
        toast("No speech detected — try again.", "default");
      }
    } catch (err) {
      toast(`Whisper error: ${(err?.message || "failed").slice(0, 80)}`, "error");
    } finally {
      promptInput.placeholder = prevPlaceholder;
      micButton.disabled = false;
    }
  };

  isListening = true;
  micButton.classList.add("is-listening");
  micVisualizer.hidden = false;
  drawMicViz();
  // 500ms timeslice so ondataavailable fires periodically during recording.
  mediaRecorder.start(500);
}

// Stop recording — this fires mediaRecorder.onstop, which runs transcription.
function stopMic() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch { /* ignore */ }
  } else {
    teardownMic();
  }
}

// Release mic + visualizer resources. Safe to call multiple times.
function teardownMic() {
  isListening = false;
  micButton.classList.remove("is-listening");
  micVisualizer.hidden = true;
  if (micVisualizerRAF) { cancelAnimationFrame(micVisualizerRAF); micVisualizerRAF = null; }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  micAnalyser = null;
  mediaRecorder = null;
}

function drawMicViz() {
  if (!micAnalyser) return;
  const ctx = micVisualizer.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = micVisualizer.getBoundingClientRect();
  micVisualizer.width = Math.round(rect.width * dpr);
  micVisualizer.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const data = new Uint8Array(micAnalyser.frequencyBinCount);

  // Render a fixed number of clean, center-mirrored bars rather than one per
  // FFT bin. Each visual bar averages a slice of the spectrum, and its height
  // is eased toward the target frame-to-frame for a smooth, liquid motion.
  const BAR_COUNT = 14;
  const levels = new Array(BAR_COUNT).fill(0);
  const usableBins = Math.floor(data.length * 0.7); // ignore the highest, mostly-empty bins

  const step = () => {
    if (!micAnalyser) return;
    micAnalyser.getByteFrequencyData(data);
    const W = rect.width, H = rect.height;
    const mid = H / 2;
    ctx.clearRect(0, 0, W, H);

    const gap = 2;
    const bw = (W - gap * (BAR_COUNT - 1)) / BAR_COUNT;
    const radius = Math.min(bw / 2, 2.5);
    const binsPerBar = Math.max(1, Math.floor(usableBins / BAR_COUNT));

    for (let i = 0; i < BAR_COUNT; i++) {
      let sum = 0;
      for (let b = 0; b < binsPerBar; b++) sum += data[i * binsPerBar + b] || 0;
      const target = (sum / binsPerBar) / 255;
      // Ease toward target: fast attack, slower release feels natural.
      const ease = target > levels[i] ? 0.5 : 0.18;
      levels[i] += (target - levels[i]) * ease;

      const v = levels[i];
      const h = Math.max(2.5, v * (H - 4));
      const x = i * (bw + gap);
      const y = mid - h / 2;

      // Monochrome bar: bright white core fading to soft grey, with a white
      // glow that intensifies with amplitude.
      const grad = ctx.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, `rgba(255, 255, 255, ${0.55 + v * 0.45})`);
      grad.addColorStop(1, `rgba(150, 150, 158, ${0.4 + v * 0.45})`);
      ctx.fillStyle = grad;
      ctx.shadowColor = "rgba(255, 255, 255, 0.55)";
      ctx.shadowBlur = 4 + v * 8;

      // Rounded-rect bar (mirrored around the vertical center).
      const r = Math.min(radius, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + bw, y, x + bw, y + h, r);
      ctx.arcTo(x + bw, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + bw, y, r);
      ctx.closePath();
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    micVisualizerRAF = requestAnimationFrame(step);
  };
  step();
}

// ─── Interactive background (solar canvas) ──────────────────────────────
let mouseX = 0.5;
let mouseY = 0.5;
let targetMX = 0.5;
let targetMY = 0.5;

// Live pixel position of the cursor (for canvas-space interactivity like the
// constellation effect). Updated in setupCursorGlow.
let mousePxX = -9999;
let mousePxY = -9999;

function setupSolarBackground() {
  const ctx = solarCanvas.getContext("2d");
  // Monochrome bodies — silver-white moons of varying brightness. No color.
  const planets = [
    { radius: 88, size: 2.4, speed: 0.00065, color: "rgba(255,255,255,0.82)" },
    { radius: 134, size: 3.4, speed: 0.00041, color: "rgba(210,210,216,0.62)" },
    { radius: 188, size: 2.8, speed: 0.00029, color: "rgba(255,255,255,0.5)" },
    { radius: 252, size: 5.1, speed: 0.00018, color: "rgba(180,180,188,0.52)" },
    { radius: 322, size: 1.9, speed: 0.00013, color: "rgba(235,235,240,0.5)" }
  ];
  const stars = Array.from({ length: 260 }, () => ({
    x: Math.random(),
    y: Math.random(),
    a: 0.08 + Math.random() * 0.5,
    s: 0.4 + Math.random() * 1.7,
    twinkleSpeed: 0.0005 + Math.random() * 0.0015,
    twinklePhase: Math.random() * Math.PI * 2,
    parallax: 0.4 + Math.random() * 1.8
  }));

  // Shooting stars (comets) spawn occasionally and streak across the sky for a
  // premium, lively feel. Pure white with a fading tail.
  const shootingStars = [];
  function maybeSpawnShootingStar(W, H) {
    if (shootingStars.length >= 2) return;
    if (Math.random() > 0.004) return; // rare
    const fromLeft = Math.random() < 0.5;
    shootingStars.push({
      x: fromLeft ? -40 : W + 40,
      y: Math.random() * H * 0.5,
      vx: (fromLeft ? 1 : -1) * (6 + Math.random() * 4),
      vy: 2.2 + Math.random() * 1.8,
      life: 1
    });
  }

  function resize() {
    const rect = solarCanvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    solarCanvas.width = Math.round(rect.width * scale);
    solarCanvas.height = Math.round(rect.height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function frame(time) {
    // Smooth-track mouse position
    mouseX += (targetMX - mouseX) * 0.06;
    mouseY += (targetMY - mouseY) * 0.06;

    const W = solarCanvas.clientWidth;
    const H = solarCanvas.clientHeight;
    ctx.clearRect(0, 0, W, H);

    // Parallax-shifted star field. Stars drift opposite the mouse for depth.
    // Stars near the cursor brighten and we connect nearby ones with faint
    // lines (a constellation that forms under the pointer) — interactive.
    const offX = (mouseX - 0.5) * 28;
    const offY = (mouseY - 0.5) * 28;
    const LINK_DIST = 130;
    const nearby = [];
    stars.forEach((star) => {
      const twinkle = 0.5 + 0.5 * Math.sin(time * star.twinkleSpeed + star.twinklePhase);
      const x = star.x * W - offX * star.parallax;
      const y = star.y * H - offY * star.parallax;
      const dx = x - mousePxX;
      const dy = y - mousePxY;
      const dist = Math.hypot(dx, dy);
      const prox = dist < LINK_DIST ? 1 - dist / LINK_DIST : 0;
      // Brighten + slightly enlarge stars close to the cursor.
      const alpha = Math.min(1, star.a * (0.4 + 0.6 * twinkle) + prox * 0.6);
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      const size = star.s + prox * 1.6;
      ctx.fillRect(x, y, size, size);
      if (prox > 0) nearby.push({ x, y, prox });
    });

    // Constellation links: line from the cursor to each nearby star, brighter
    // the closer it is. Cheap because `nearby` is small.
    if (nearby.length) {
      for (const n of nearby) {
        ctx.strokeStyle = `rgba(255,255,255,${n.prox * 0.22})`;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(mousePxX, mousePxY);
        ctx.lineTo(n.x, n.y);
        ctx.stroke();
      }
    }

    // Shooting stars
    maybeSpawnShootingStar(W, H);
    for (let i = shootingStars.length - 1; i >= 0; i--) {
      const s = shootingStars[i];
      s.x += s.vx;
      s.y += s.vy;
      s.life -= 0.012;
      if (s.life <= 0 || s.x < -60 || s.x > W + 60 || s.y > H + 60) {
        shootingStars.splice(i, 1);
        continue;
      }
      const tailX = s.x - s.vx * 6;
      const tailY = s.y - s.vy * 6;
      const tail = ctx.createLinearGradient(s.x, s.y, tailX, tailY);
      tail.addColorStop(0, `rgba(255,255,255,${0.9 * s.life})`);
      tail.addColorStop(1, "rgba(255,255,255,0)");
      ctx.strokeStyle = tail;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();
    }

    // Sun/black-hole anchor — a bright white core fading to black, shifting
    // subtly with the mouse for parallax. Stays strictly black-and-white.
    const cx = W * 0.62 + (mouseX - 0.5) * 60;
    const cy = H * 0.44 + (mouseY - 0.5) * 60;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 240);
    glow.addColorStop(0, "rgba(255,255,255,0.16)");
    glow.addColorStop(0.22, "rgba(255,255,255,0.07)");
    glow.addColorStop(0.6, "rgba(255,255,255,0.02)");
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, 240, 0, Math.PI * 2);
    ctx.fill();

    // Planetary orbits (ellipses) + moving bodies on them.
    ctx.lineWidth = 1;
    planets.forEach((planet, index) => {
      ctx.strokeStyle = `rgba(255,255,255,${0.045 + (index % 2) * 0.014})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, planet.radius * 1.55, planet.radius * 0.54, -0.18, 0, Math.PI * 2);
      ctx.stroke();
      const angle = time * planet.speed + index * 1.8;
      const x = cx + Math.cos(angle) * planet.radius * 1.55;
      const y = cy + Math.sin(angle) * planet.radius * 0.54;
      // Soft halo behind each planet
      const halo = ctx.createRadialGradient(x, y, 0, x, y, planet.size * 6);
      halo.addColorStop(0, planet.color);
      halo.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, planet.size * 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = planet.color;
      ctx.beginPath();
      ctx.arc(x, y, planet.size, 0, Math.PI * 2);
      ctx.fill();
    });

    requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener("resize", resize);
  requestAnimationFrame(frame);
}

function setupCursorGlow() {
  window.addEventListener("mousemove", (e) => {
    targetMX = e.clientX / window.innerWidth;
    targetMY = e.clientY / window.innerHeight;
    mousePxX = e.clientX;
    mousePxY = e.clientY;
    cursorGlow.style.transform = `translate3d(${e.clientX - 230}px, ${e.clientY - 230}px, 0)`;
  });
  // When the cursor leaves the window, park the constellation origin off-screen
  // so links don't freeze mid-air.
  window.addEventListener("mouseleave", () => {
    mousePxX = -9999;
    mousePxY = -9999;
  });
}

// ─── Window controls + view switching ──────────────────────────────────
async function toggleViewMode() {
  try { await window.orbit?.setOverlayState?.("collapsed"); } catch { /* ignore */ }
  try { await window.orbit?.setAppMode?.("overlay"); } catch { /* ignore */ }
}

// ─── Coordinate calibration (mirrors overlay version) ───────────────────
// Shared modal helper. Returns { backdrop, body, close } so callers can fill
// the body and close on demand.
function openModal({ title, width = 520 } = {}) {
  const old = document.getElementById("orbitGenericModal");
  if (old) old.remove();
  const backdrop = document.createElement("div");
  backdrop.id = "orbitGenericModal";
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal modal-generic";
  modal.style.width = `${width}px`;
  modal.style.maxWidth = "92vw";
  modal.innerHTML = `
    <div class="modal-header">
      <h3></h3>
      <button class="modal-close" aria-label="Close">×</button>
    </div>
    <div class="modal-body"></div>
  `;
  modal.querySelector("h3").textContent = title || "";
  backdrop.append(modal);
  document.body.append(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  modal.querySelector(".modal-close").addEventListener("click", close);
  return { backdrop, body: modal.querySelector(".modal-body"), close };
}

function showCustomConfirm({ title = "Confirm", message = "", isDanger = false, confirmText = "Confirm", cancelText = "Cancel" } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal-dialog";
    modal.innerHTML = `
      <div class="dialog-header"></div>
      <div class="dialog-body">
        <div class="dialog-body-text"></div>
      </div>
      <div class="dialog-footer">
        <button type="button" class="dialog-btn dialog-btn-cancel"></button>
        <button type="button" class="dialog-btn"></button>
      </div>
    `;
    modal.querySelector(".dialog-header").textContent = title;
    modal.querySelector(".dialog-body-text").textContent = message;
    
    const btnCancel = modal.querySelector(".dialog-btn-cancel");
    btnCancel.textContent = cancelText;
    
    const btnConfirm = modal.querySelector(".dialog-footer .dialog-btn:not(.dialog-btn-cancel)");
    btnConfirm.textContent = confirmText;
    btnConfirm.className = `dialog-btn ${isDanger ? "dialog-btn-danger" : "dialog-btn-confirm"}`;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    requestAnimationFrame(() => {
      backdrop.classList.add("show");
    });

    let cleanup = (value) => {
      backdrop.classList.remove("show");
      setTimeout(() => {
        backdrop.remove();
        const promptInput = document.getElementById("promptInput");
        if (promptInput) promptInput.focus();
        resolve(value);
      }, 180);
    };

    btnCancel.addEventListener("click", () => cleanup(false));
    btnConfirm.addEventListener("click", () => cleanup(true));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) cleanup(false);
    });

    const handleKeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        cleanup(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cleanup(false);
      }
    };
    window.addEventListener("keydown", handleKeydown);
    const originalCleanup = cleanup;
    cleanup = (val) => {
      window.removeEventListener("keydown", handleKeydown);
      originalCleanup(val);
    };

    btnConfirm.focus();
  });
}

function showCustomPrompt({ title = "Input Required", message = "", defaultValue = "", placeholder = "", confirmText = "OK", cancelText = "Cancel" } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "dialog-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal-dialog";
    modal.innerHTML = `
      <div class="dialog-header"></div>
      <div class="dialog-body">
        <div class="dialog-body-text" style="display: none;"></div>
        <input type="text" class="dialog-input" />
      </div>
      <div class="dialog-footer">
        <button type="button" class="dialog-btn dialog-btn-cancel"></button>
        <button type="button" class="dialog-btn dialog-btn-confirm"></button>
      </div>
    `;
    modal.querySelector(".dialog-header").textContent = title;
    if (message) {
      const msgEl = modal.querySelector(".dialog-body-text");
      msgEl.textContent = message;
      msgEl.style.display = "block";
    }
    
    const input = modal.querySelector(".dialog-input");
    input.value = defaultValue;
    input.placeholder = placeholder;
    
    const btnCancel = modal.querySelector(".dialog-btn-cancel");
    btnCancel.textContent = cancelText;
    
    const btnConfirm = modal.querySelector(".dialog-btn-confirm");
    btnConfirm.textContent = confirmText;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    requestAnimationFrame(() => {
      backdrop.classList.add("show");
      input.focus();
      input.select();
    });

    let cleanup = (value) => {
      backdrop.classList.remove("show");
      setTimeout(() => {
        backdrop.remove();
        const promptInput = document.getElementById("promptInput");
        if (promptInput) promptInput.focus();
        resolve(value);
      }, 180);
    };

    btnCancel.addEventListener("click", () => cleanup(null));
    btnConfirm.addEventListener("click", () => cleanup(input.value));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) cleanup(null);
    });

    const handleKeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        cleanup(input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cleanup(null);
      }
    };
    window.addEventListener("keydown", handleKeydown);
    const originalCleanup = cleanup;
    cleanup = (val) => {
      window.removeEventListener("keydown", handleKeydown);
      originalCleanup(val);
    };
  });
}

// History: every conversation across every project, newest first.
function openHistoryModal() {
  const { body, close } = openModal({ title: "Conversation History", width: 580 });
  const entries = [];
  for (const project of state.projects) {
    for (const chat of project.chats) {
      entries.push({ projectId: project.id, projectName: project.name, chat });
    }
  }
  entries.sort((a, b) => new Date(b.chat.createdAt) - new Date(a.chat.createdAt));
  if (!entries.length) {
    body.innerHTML = `<p class="muted-row" style="padding:0;">No conversations yet.</p>`;
    return;
  }
  const list = document.createElement("div");
  list.className = "history-list";
  entries.forEach((e) => {
    const msgCount = (e.chat.messages || []).filter((m) => !m.isToolResult).length;
    const row = document.createElement("div");
    row.className = "history-row";
    row.innerHTML = `
      <div class="history-row-main">
        <div class="history-row-title"></div>
        <div class="history-row-sub"></div>
      </div>
      <div class="history-row-meta">
        <span class="history-row-age"></span>
        <button type="button" class="row-delete" title="Delete">×</button>
      </div>
    `;
    row.querySelector(".history-row-title").textContent = e.chat.title;
    row.querySelector(".history-row-sub").textContent = `${e.projectName} · ${msgCount} msg`;
    row.querySelector(".history-row-age").textContent = formatAge(e.chat.createdAt);
    row.addEventListener("click", () => {
      state = { ...state, activeProjectId: e.projectId, activeChatId: e.chat.id };
      render();
      persistState();
      close();
    });
    row.querySelector(".row-delete").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      // Use the same confirm + deletion path that the sidebar uses, but
      // scoped via the entry's project (not necessarily the active one).
      const proj = state.projects.find((p) => p.id === e.projectId);
      if (!proj) return;
      const proceed = await showCustomConfirm({
        title: "Delete Conversation",
        message: `Delete "${e.chat.title}" from "${e.projectName}"?`,
        isDanger: true,
        confirmText: "Delete",
        cancelText: "Cancel"
      });
      if (!proceed) return;
      const remaining = proj.chats.filter((c) => c.id !== e.chat.id);
      const replacement = remaining.length > 0
        ? remaining
        : [{ id: crypto.randomUUID(), title: "New Conversation", createdAt: new Date().toISOString(), messages: [] }];
      state = {
        ...state,
        projects: state.projects.map((p) => (p.id === e.projectId ? { ...p, chats: replacement } : p)),
        activeChatId: state.activeChatId === e.chat.id ? replacement[replacement.length - 1].id : state.activeChatId
      };
      render();
      persistState();
      row.remove();
    });
    list.append(row);
  });
  body.append(list);
}

// Background Agents (the "Scheduled Tasks" button repurposed): shows live
// agent count from the main process and lets you deploy ad-hoc agents.
async function openTasksModal() {
  const { body } = openModal({ title: "Background Agents", width: 560 });
  body.innerHTML = `
    <p style="margin:0 0 10px;font-size:12px;opacity:.75;">Long-running agents work in the background on your behalf. Each one runs up to 12 tool steps autonomously, with full logs under <code>.orbit/agent-&lt;id&gt;.log</code> inside the active project's folder.</p>
    <div id="agentsStatus" class="agent-status">Loading…</div>
    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">
      <input id="agentTaskInput" placeholder="Describe a task for a new agent…" style="flex:1;min-width:240px;padding:6px 10px;background:var(--bg-soft);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;">
      <button type="button" id="agentDeployBtn" class="modal-btn">Deploy 1</button>
      <button type="button" id="agentDeploy3Btn" class="modal-btn">Deploy 3</button>
    </div>
    <p id="agentDeployStatus" style="margin:10px 0 0;font-size:11px;opacity:.7;min-height:14px;"></p>
  `;
  const refresh = async () => {
    try {
      const n = await window.orbit?.getActiveAgentsCount?.();
      const count = typeof n === "number" ? n : 0;
      body.querySelector("#agentsStatus").innerHTML = count > 0
        ? `<span class="agent-dot is-running"></span> ${count} agent${count === 1 ? "" : "s"} currently running.`
        : `<span class="agent-dot"></span> No agents are running right now.`;
    } catch {
      body.querySelector("#agentsStatus").textContent = "(could not read agent count)";
    }
  };
  await refresh();
  const interval = setInterval(refresh, 4000);
  // Stop polling when modal goes away.
  const observer = new MutationObserver(() => {
    if (!document.getElementById("orbitGenericModal")) {
      clearInterval(interval);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true });

  const deploy = async (n) => {
    const task = body.querySelector("#agentTaskInput").value.trim();
    const status = body.querySelector("#agentDeployStatus");
    if (!task) { status.textContent = "Type a task description first."; return; }
    const workspacePath = getActiveProject(state)?.workspacePath;
    if (!workspacePath) { status.textContent = "Active project has no folder. Set one in the chat header first."; return; }
    status.textContent = `Deploying ${n}…`;
    const results = await Promise.all(Array.from({ length: n }, () =>
      window.orbit.deployAgent({ workspacePath, task, model: selectedModel }).catch((e) => ({ ok: false, error: e?.message }))
    ));
    const ok = results.filter((r) => r && r.ok).length;
    status.textContent = `Deployed ${ok}/${n}. Logs in ${workspacePath}\\.orbit\\`;
    refresh();
  };
  body.querySelector("#agentDeployBtn").addEventListener("click", () => deploy(1));
  body.querySelector("#agentDeploy3Btn").addEventListener("click", () => deploy(3));
}

// Settings: real, persisted preferences.
function openSettingsModal() {
  const { body, close } = openModal({ title: "Settings", width: 520 });
  body.innerHTML = `
    <div class="settings-row">
      <label>Default model</label>
      <select id="setDefaultModel">
        <option>Auto</option><option>Voyager 1 Flash</option><option>Voyager 1</option>
        <option>Voyager 2</option><option>Voyager 2 Pro</option><option>Voyager 2.1 Preview</option>
        <option>Orchestra 1.1</option>
      </select>
    </div>
    <div class="settings-row">
      <label>Default mode</label>
      <select id="setDefaultMode">
        <option value="ask">Ask</option>
        <option value="agents">Agents</option>
        <option value="planning">Planning</option>
      </select>
    </div>
    <div class="settings-row">
      <label>Preset<br><span style="font-size:11px;opacity:.6;">Tunes how the model responds</span></label>
      <select id="setPreset">
        ${PRESETS.map((p) => `<option value="${p.id}">${p.icon} ${escapeHtml(p.label)}</option>`).join("")}
      </select>
    </div>
    <div class="settings-row">
      <label>Auto-attach screenshot to every message</label>
      <input type="checkbox" id="setAttachShot">
    </div>
    <div class="settings-row" style="border-top:1px solid var(--border);padding-top:10px;margin-top:6px;">
      <label>Storage</label>
      <button type="button" id="setClearAll" class="modal-btn" style="border-color:rgba(239,68,68,0.4);color:#fda4af;">Clear all projects &amp; chats</button>
    </div>
    <p style="margin:10px 0 0;font-size:11px;opacity:.6;">Changes save instantly.</p>
  `;
  body.querySelector("#setDefaultModel").value = selectedModel;
  body.querySelector("#setDefaultMode").value = currentMode;
  body.querySelector("#setPreset").value = selectedPreset;
  body.querySelector("#setAttachShot").checked = attachScreenshot;

  body.querySelector("#setPreset").addEventListener("change", (e) => {
    selectedPreset = normalizePreset(e.target.value);
    persistState();
    const p = PRESETS.find((x) => x.id === selectedPreset);
    toast(`Preset: ${p ? p.label : selectedPreset}`, "success", 1800);
  });

  body.querySelector("#setDefaultModel").addEventListener("change", (e) => {
    setSelectedModel(e.target.value);
    toast(`Default model: ${selectedModel}`, "success", 1800);
  });
  body.querySelector("#setDefaultMode").addEventListener("change", (e) => {
    setMode(e.target.value);
    toast(`Default mode: ${currentMode}`, "success", 1800);
  });
  body.querySelector("#setAttachShot").addEventListener("change", (e) => {
    attachScreenshot = e.target.checked;
    updateScreenshotToggleUI();
    persistState();
  });
  body.querySelector("#setClearAll").addEventListener("click", async () => {
    const proceed = await showCustomConfirm({
      title: "Clear All Data",
      message: "Delete ALL projects and conversations? This cannot be undone.",
      isDanger: true,
      confirmText: "Clear All",
      cancelText: "Cancel"
    });
    if (!proceed) return;
    localStorage.removeItem(STORAGE_KEY);
    state = loadState();
    selectedModel = DEFAULT_MODEL;
    currentMode = "ask";
    selectedPreset = DEFAULT_PRESET;
    attachScreenshot = false;
    setSelectedModel(selectedModel);
    setMode(currentMode);
    updateScreenshotToggleUI();
    render();
    persistState();
    close();
    toast("All data cleared", "success");
  });
}

// File / View / Window menus at the top.
function openTopMenu(name, anchorRect) {
  if (!menuDropdown) return;
  const items = {
    file: [
      { label: "New Conversation", run: () => newChatButton.click() },
      { label: "New Project…", run: () => createProject() },
      { label: "Open Folder for Project…", run: () => changeProjectFolder(state.activeProjectId) },
      { label: "Export Chat as Markdown", run: () => exportActiveChatMarkdown() }
    ],
    view: [
      { label: "Open Overlay Mode", run: () => toggleViewMode() },
      { label: "Conversation History", run: () => openHistoryModal() },
      { label: "Background Agents", run: () => openTasksModal() }
    ],
    window: [
      { label: "Minimize", run: () => window.orbit?.minimizeWindow?.() },
      { label: "Maximize / Restore", run: () => window.orbit?.toggleMaximizeWindow?.() },
      { label: "Close", run: () => window.orbit?.closeWindow?.() }
    ]
  }[name];
  if (!items) return;
  menuDropdown.innerHTML = items.map((it, i) =>
    `<div class="menu-dropdown-item" data-idx="${i}">${escapeHtml(it.label)}</div>`
  ).join("");
  menuDropdown.style.left = `${anchorRect.left}px`;
  menuDropdown.style.top = `${anchorRect.bottom + 4}px`;
  menuDropdown.hidden = false;
  menuDropdown.querySelectorAll(".menu-dropdown-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(el.dataset.idx, 10);
      menuDropdown.hidden = true;
      items[idx].run();
    });
  });
}

function exportActiveChatMarkdown() {
  const chat = getActiveChat(state);
  if (!chat) return;
  const lines = [`# ${chat.title}`, "", `_Exported ${new Date().toLocaleString()}_`, ""];
  for (const m of chat.messages) {
    if (m.isToolResult) continue;
    lines.push(`## ${m.role === "user" ? "You" : "Voyager"} — ${new Date(m.timestamp).toLocaleTimeString()}`);
    lines.push("");
    lines.push(m.content || "");
    lines.push("");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${chat.title.replace(/[^a-z0-9-_]+/gi, "_")}.md`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Exported chat as Markdown", "success");
}

function openCalibrationModal() {
  const old = document.getElementById("appCalModal");
  if (old) old.remove();
  const backdrop = document.createElement("div");
  backdrop.id = "appCalModal";
  backdrop.className = "modal-backdrop";
  const dpr = window.devicePixelRatio || 1;
  const scrW = window.screen.width, scrH = window.screen.height;
  const realW = Math.round(scrW * dpr), realH = Math.round(scrH * dpr);
  backdrop.innerHTML = `
    <div class="modal modal-calibration">
      <div class="modal-header"><h3>Coordinate Calibration</h3><button class="modal-close" aria-label="Close">×</button></div>
      <div class="modal-body">
        <p style="margin:0 0 8px;font-size:12px;opacity:.75;">Verify the AI's click/type targeting matches your real desktop.</p>
        <div class="calibration-grid">
          <div><strong>CSS resolution:</strong> ${scrW} × ${scrH}</div>
          <div><strong>Device pixel ratio:</strong> ${dpr}</div>
          <div><strong>Physical resolution:</strong> ${realW} × ${realH}</div>
        </div>
        <div class="calibration-row">
          <label>X <input id="appCalX" type="number" value="${Math.round(scrW/2)}"></label>
          <label>Y <input id="appCalY" type="number" value="${Math.round(scrH/2)}"></label>
          <button type="button" id="appCalClick" class="modal-btn">Probe click (3s)</button>
          <button type="button" id="appCalType" class="modal-btn">Probe type (3s)</button>
        </div>
        <p id="appCalStatus" class="calibration-status" style="font-size:11px;opacity:.7;min-height:14px;">Click a probe button, then focus the target window.</p>
      </div>
    </div>`;
  document.body.append(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector(".modal-close").addEventListener("click", close);
  const status = backdrop.querySelector("#appCalStatus");
  const probe = async (kind) => {
    const x = parseInt(backdrop.querySelector("#appCalX").value, 10);
    const y = parseInt(backdrop.querySelector("#appCalY").value, 10);
    for (let i = 3; i > 0; i--) {
      status.textContent = `Probing ${kind} at (${x}, ${y}) in ${i}…`;
      await new Promise((r) => setTimeout(r, 800));
    }
    try {
      if (kind === "click") {
        const res = await window.orbit?.clickPixel?.({ x, y });
        status.textContent = res?.ok ? `✓ Clicked at (${x}, ${y}).` : `Click failed: ${res?.error || "unknown"}`;
      } else {
        const res = await window.orbit?.typeIntoWindow?.({ text: `[Orbit ${x},${y}]` });
        status.textContent = res?.ok ? `✓ Typed marker into focused window.` : `Type failed: ${res?.error || "unknown"}`;
      }
    } catch (err) { status.textContent = `Probe error: ${err?.message}`; }
  };
  backdrop.querySelector("#appCalClick").addEventListener("click", () => probe("click"));
  backdrop.querySelector("#appCalType").addEventListener("click", () => probe("type"));
}

// ─── Misc helpers ───────────────────────────────────────────────────────
function renderActiveProjectFolderBadge(project) {
  const header = document.getElementById("chatHeader");
  if (!header) return;
  let badge = document.getElementById("activeWorkspaceBadge");
  if (!project) { if (badge) badge.remove(); return; }
  if (!badge) {
    badge = document.createElement("button");
    badge.id = "activeWorkspaceBadge";
    badge.type = "button";
    badge.className = "workspace-badge";
    badge.title = "Click to choose this project's folder";
    badge.addEventListener("click", () => changeProjectFolder(state.activeProjectId));
    // Insert right after the project chip
    const chip = document.getElementById("activeProjectButton");
    if (chip?.parentElement === header) header.insertBefore(badge, chip.nextSibling);
    else header.append(badge);
  }
  if (project.workspacePath) {
    badge.textContent = `▤ ${basename(project.workspacePath)}`;
    badge.classList.remove("is-empty");
    badge.title = `Workspace: ${project.workspacePath} (click to change)`;
  } else {
    badge.textContent = "▤ Choose folder";
    badge.classList.add("is-empty");
    badge.title = "No folder bound to this project — click to choose";
  }
}

function colorForId(id) {
  // Hash an id to a hue for the colored dot next to each project.
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 70%, 65%)`;
}

function autoResize() {
  promptInput.style.height = "auto";
  promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + "px";
}

function updateScreenshotToggleUI() {
  screenshotToggleButton.classList.toggle("is-active", attachScreenshot);
  screenshotToggleButton.title = attachScreenshot ? "Screenshot auto-attaching" : "Screenshot off";
}

function render() {
  renderProjects();
  renderConversations();
  renderFiles();
  renderMessages();
  // After the DOM settles, see if any tool cards want to auto-fire.
  setTimeout(maybeAutoFireTools, 0);
}

// Esc closes the topmost modal so users don't get stuck. If no modal is open
// but a response is streaming, Esc stops it.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const modal = document.querySelector(".modal-backdrop");
  if (modal) { modal.remove(); e.preventDefault(); return; }
  if (streaming) { stopStreaming(); e.preventDefault(); }
});

// ─── Event wiring ───────────────────────────────────────────────────────
newChatButton.addEventListener("click", () => {
  state = createNewChat(state, "New Conversation");
  render();
  persistState();
  promptInput.focus();
});

addProjectButton.addEventListener("click", createProject);
addFileButton.addEventListener("click", addFilesToProject);
historyButton.addEventListener("click", openHistoryModal);
tasksButton.addEventListener("click", openTasksModal);
settingsButton.addEventListener("click", openSettingsModal);

// Top-bar menu dropdowns
document.querySelectorAll(".menu-item").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = btn.dataset.menu;
    const rect = btn.getBoundingClientRect();
    openTopMenu(menu, rect);
  });
});
document.addEventListener("click", () => {
  if (menuDropdown && !menuDropdown.hidden) menuDropdown.hidden = true;
});

// Abort the in-flight AI stream. Used by the Stop button (the Send button
// while streaming) and the Esc key. The backend resolves the pending
// sendToAI with { ok:false, stopped:true }, which triggerAITurn turns into a
// "Stopped." bubble (keeping any partial text that already streamed in).
async function stopStreaming() {
  if (!streaming || !currentStreamId) return;
  // Halt the autonomous tool loop so a stop also breaks the agent chain.
  agentStepsThisTurn = MAX_AGENT_STEPS;
  try { await window.orbit?.abortAI?.(currentStreamId); } catch { /* ignore */ }
}

// Intercept the Send button while streaming so it acts as Stop. Runs before
// the form's submit handler because the click bubbles first.
sendButton.addEventListener("click", (event) => {
  if (streaming) {
    event.preventDefault();
    event.stopPropagation();
    stopStreaming();
  }
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (streaming) { stopStreaming(); return; }
  await sendMessage(promptInput.value);
});

promptInput.addEventListener("input", () => {
  autoResize();
  updateSlashMenu();
});

promptInput.addEventListener("keydown", (event) => {
  // Slash menu navigation
  if (!slashMenuEl.hidden && slashFiltered.length) {
    if (event.key === "ArrowDown") { event.preventDefault(); slashSelectedIdx = (slashSelectedIdx + 1) % slashFiltered.length; updateSlashMenu(); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); slashSelectedIdx = (slashSelectedIdx - 1 + slashFiltered.length) % slashFiltered.length; updateSlashMenu(); return; }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      promptInput.value = slashFiltered[slashSelectedIdx].name + " ";
      hideSlashMenu();
      return;
    }
    if (event.key === "Escape") { hideSlashMenu(); return; }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

modeButton.addEventListener("click", cycleMode);

modelSelectBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const hidden = modelSelectOptions.hidden;
  if (hidden) {
    modelSelectOptions.hidden = false;
    expandSelectedModelCategory();
  } else {
    modelSelectOptions.hidden = true;
  }
});

modelSelectOptions.addEventListener("click", (e) => {
  const header = e.target.closest(".custom-select-category-header");
  if (header) {
    e.stopPropagation();
    const cat = header.parentElement;
    const wasOpen = cat.classList.contains("is-open");
    modelSelectOptions.querySelectorAll(".custom-select-category").forEach((c) => {
      if (c !== cat) c.classList.remove("is-open");
    });
    cat.classList.toggle("is-open", !wasOpen);
    return;
  }
  const opt = e.target.closest(".custom-select-option");
  if (!opt) return;
  e.stopPropagation();
  setSelectedModel(opt.dataset.value);
  modelSelectOptions.hidden = true;
});

document.addEventListener("click", () => { modelSelectOptions.hidden = true; });

micButton.addEventListener("click", () => {
  if (isListening) stopMic();
  else startMic();
});

attachButton.addEventListener("click", attachViaPicker);
regionButton.addEventListener("click", captureRegionForNextMessage);
screenshotToggleButton.addEventListener("click", () => {
  attachScreenshot = !attachScreenshot;
  updateScreenshotToggleUI();
  persistState();
});

document.querySelector("#minimizeWindow")?.addEventListener("click", () => window.orbit?.minimizeWindow?.());
document.querySelector("#maximizeWindow")?.addEventListener("click", () => window.orbit?.toggleMaximizeWindow?.());
document.querySelector("#closeWindow")?.addEventListener("click", () => window.orbit?.closeWindow?.());
viewModeButton.addEventListener("click", toggleViewMode);

// Drag-and-drop file attach
window.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("is-dragging"); });
window.addEventListener("dragleave", (e) => { if (e.target === document || e.target === document.body) document.body.classList.remove("is-dragging"); });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("is-dragging");
  const files = Array.from(e.dataTransfer?.files || []);
  files.forEach((f) => addAttachment({ name: f.name, path: f.path || f.name }));
});

// ─── Boot ───────────────────────────────────────────────────────────────
setSelectedModel(selectedModel);
setMode(currentMode);
updateScreenshotToggleUI();
// Warm up the local Whisper model so the first dictation isn't a cold start.
// Shares the IndexedDB model cache with the overlay (same file:// origin).
if (!window.MediaRecorder) {
  micButton.disabled = true;
  micButton.title = "Recording not available in this runtime";
} else {
  warmupWhisper();
}
setupSolarBackground();
setupCursorGlow();
render();
autoResize();
