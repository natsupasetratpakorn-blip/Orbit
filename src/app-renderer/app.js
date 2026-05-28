import {
  addMessageToActiveChat,
  createDefaultOrbitState,
  createNewChat,
  getActiveChat,
  getActiveProject,
  selectProject
} from "../shared/orbit-state.js";
import { parseAIResponse, renderMarkdown } from "../shared/parser.js";

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
const settingsButton = $("#settingsButton");

// ─── State ───────────────────────────────────────────────────────────────
let state = loadState();
let selectedModel = state.selectedModel || DEFAULT_MODEL;
let currentMode = MODES.includes(state.currentMode) ? state.currentMode : "ask";
let attachScreenshot = !!state.attachScreenshot;
let attachedFiles = []; // { name, path }
let pendingRegionShot = null; // path of a one-shot region capture
let recognition = null;
let isListening = false;
let audioCtx = null;
let micStream = null;
let micAnalyser = null;
let micVisualizerRAF = null;
let streaming = false;
let streamingMessageId = null;

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (parsed?.projects?.length) {
      parsed.projects = parsed.projects.map((p) => ({
        ...p,
        files: Array.isArray(p.files) ? p.files : [],
        workspacePath: typeof p.workspacePath === "string" ? p.workspacePath : ""
      }));
      return parsed;
    }
  } catch { /* fall through */ }
  const def = createDefaultOrbitState();
  def.projects = def.projects.map((p) => ({ ...p, files: [], workspacePath: "" }));
  return def;
}

function persistState() {
  state.selectedModel = selectedModel;
  state.currentMode = currentMode;
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
    const item = document.createElement("button");
    item.type = "button";
    item.className = `project-row${project.id === state.activeProjectId ? " is-active" : ""}`;
    const dotColor = colorForId(project.id);
    item.innerHTML = `
      <span class="folder-outline" style="--dot:${dotColor}"></span>
      <span class="project-meta">
        <span class="project-name"></span>
        <span class="project-subline"></span>
      </span>
      <span class="activity-dot"></span>
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
    const item = document.createElement("button");
    item.type = "button";
    item.className = `conversation-row${chat.id === state.activeChatId ? " is-active" : ""}`;
    item.innerHTML = `
      <span class="conversation-title"></span>
      <span class="conversation-age"></span>
    `;
    item.querySelector(".conversation-title").textContent = chat.title;
    item.querySelector(".conversation-age").textContent = formatAge(chat.createdAt);
    item.addEventListener("click", () => {
      state = { ...state, activeChatId: chat.id };
      render();
      persistState();
    });
    item.addEventListener("dblclick", () => renameChat(chat.id));
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

function renderAssistantBody(message, container) {
  const parts = parseAIResponse(message.content || "");
  if (!parts.length) {
    const p = document.createElement("div");
    p.className = "assistant-text";
    p.innerHTML = renderMarkdown(message.content || "");
    container.append(p);
    return;
  }
  for (const part of parts) {
    if (part.type === "text") {
      const p = document.createElement("div");
      p.className = "assistant-text";
      p.innerHTML = renderMarkdown(part.content);
      container.append(p);
    } else {
      container.append(renderActionCardReadonly(part));
    }
  }
}

function renderActionCardReadonly(part) {
  const card = document.createElement("div");
  card.className = `action-card action-${part.type}`;
  const head = document.createElement("div");
  head.className = "action-card-head";
  const label = {
    execute_command: "Run command",
    write_file: "Write file",
    patch_file: "Patch file",
    read_file: "Read file",
    list_workspace: "List workspace",
    list_windows: "List windows",
    search_workspace: "Search workspace",
    type_text: "Type text",
    click_pixel: "Click pixel",
    open_browser: "Open browser",
    deploy_agent: "Deploy agent"
  }[part.type] || part.type;
  head.innerHTML = `<span class="action-icon"></span><span class="action-label">${label}</span>`;
  if (part.path) head.innerHTML += `<span class="action-path">${escapeHtml(part.path)}</span>`;
  if (part.window) head.innerHTML += `<span class="action-path">→ ${escapeHtml(part.window)}</span>`;
  if (part.url) head.innerHTML += `<span class="action-path">${escapeHtml(part.url)}</span>`;
  card.append(head);
  if (part.content) {
    const body = document.createElement("pre");
    body.className = "action-body";
    body.textContent = part.content.length > 1000 ? part.content.slice(0, 1000) + "\n…" : part.content;
    card.append(body);
  }
  return card;
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

  // Slash-command intercept (skip AI roundtrip when we handle it locally)
  if (text.startsWith("/")) {
    const handled = await tryRunSlashCommand(text);
    if (handled) {
      promptInput.value = "";
      autoResize();
      return;
    }
  }

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

  streaming = true;
  sendButton.disabled = true;
  sendButton.classList.add("is-streaming");

  // Build a streaming assistant placeholder so the chunk handler can append.
  const streamId = crypto.randomUUID();
  streamingMessageId = crypto.randomUUID();
  const assistantPlaceholder = {
    id: streamingMessageId,
    role: "assistant",
    content: "",
    timestamp: new Date().toISOString(),
    streaming: true
  };
  state = addMessageToActiveChat(state, assistantPlaceholder);
  render();
  // Mark the just-appended assistant card as streaming
  decorateStreamingMessage();

  // Wire up chunk listener (cleanup after end).
  let chunkOff = null;
  if (window.orbit?.onAIChunk) {
    chunkOff = window.orbit.onAIChunk((data) => {
      if (!data || data.streamId !== streamId) return;
      if (typeof data.delta === "string" && data.delta) {
        appendStreamingDelta(data.delta);
      }
    });
  }

  let screenshotPath = null;
  if (pendingRegionShot) {
    screenshotPath = pendingRegionShot;
    pendingRegionShot = null;
  } else if (attachScreenshot) {
    try {
      screenshotPath = await window.orbit?.captureScreen?.();
    } catch { /* ignore */ }
  }

  const activeChat = getActiveChat(state);
  // Send the messages excluding the streaming placeholder so the model gets
  // a clean turn list ending in user.
  const cleanMessages = activeChat.messages.filter((m) => !m.streaming);

  let finalText = "";
  try {
    const activeProject = getActiveProject(state);
    const response = await window.orbit?.sendToAI?.({
      streamId,
      model: selectedModel,
      messages: cleanMessages,
      screenshotPath,
      attachments: attachmentsSnapshot.map((a) => a.path),
      workspacePath: activeProject?.workspacePath || "",
      agentMode: currentMode === "agents",
      mode: currentMode
    });
    finalText = response?.text || response?.content || "";
  } catch (err) {
    finalText = `_Request failed: ${err?.message || err}_`;
  } finally {
    if (chunkOff) try { chunkOff(); } catch { /* ignore */ }
  }

  // Replace the streaming placeholder with the final content. If streaming
  // had been delivering deltas, prefer the final text from the response since
  // it reflects the final, normalized content.
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
              return { ...m, content: finalText || m.content || "_(empty response)_", streaming: false };
            })
          };
        })
      };
    })
  };
  streamingMessageId = null;
  streaming = false;
  sendButton.disabled = false;
  sendButton.classList.remove("is-streaming");
  render();
  persistState();
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
  const name = window.prompt("Project name", defaultName);
  if (name == null) return; // cancelled
  let workspacePath = "";
  try {
    workspacePath = (await window.orbit?.selectWorkspaceDir?.()) || "";
  } catch { /* user cancelled or no picker */ }
  if (!workspacePath) {
    const proceed = window.confirm("No folder selected. Create the project anyway? (You can attach a folder later from the project chip.)");
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

function renameProject(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;
  const next = window.prompt("Rename project", project.name);
  if (next == null) return;
  state = {
    ...state,
    projects: state.projects.map((p) => (p.id === projectId ? { ...p, name: next.trim() || p.name } : p))
  };
  render();
  persistState();
}

function renameChat(chatId) {
  const project = getActiveProject(state);
  const chat = project?.chats.find((c) => c.id === chatId);
  if (!chat) return;
  const next = window.prompt("Rename conversation", chat.title);
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
    const path = await window.orbit?.selectWorkspaceDir?.();
    if (!path) return;
    addAttachment({ name: basename(path), path });
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

// ─── Mic with visualizer ────────────────────────────────────────────────
function setupSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    micButton.disabled = true;
    micButton.title = "Speech recognition not available in this runtime";
    return;
  }
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    let transcript = "";
    for (let i = 0; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    promptInput.value = transcript.trim();
    autoResize();
  };
  recognition.onend = () => stopMic();
  recognition.onerror = (e) => { toast(`Mic error: ${e.error || "unknown"}`, "error"); stopMic(); };
}

async function startMic() {
  if (!recognition || isListening) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
  isListening = true;
  micButton.classList.add("is-listening");
  micVisualizer.hidden = false;
  drawMicViz();
  try { recognition.start(); } catch { /* ignore double-start */ }
}

function stopMic() {
  isListening = false;
  micButton.classList.remove("is-listening");
  micVisualizer.hidden = true;
  if (micVisualizerRAF) { cancelAnimationFrame(micVisualizerRAF); micVisualizerRAF = null; }
  try { recognition?.stop(); } catch { /* ignore */ }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  micAnalyser = null;
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

  const step = () => {
    if (!micAnalyser) return;
    micAnalyser.getByteFrequencyData(data);
    const W = rect.width, H = rect.height;
    ctx.clearRect(0, 0, W, H);
    const bars = data.length;
    const gap = 2;
    const bw = (W - gap * (bars - 1)) / bars;
    for (let i = 0; i < bars; i++) {
      const v = data[i] / 255;
      const h = Math.max(2, v * H * 0.95);
      ctx.fillStyle = `rgba(255,255,255,${0.35 + v * 0.5})`;
      const x = i * (bw + gap);
      const y = (H - h) / 2;
      ctx.fillRect(x, y, bw, h);
    }
    micVisualizerRAF = requestAnimationFrame(step);
  };
  step();
}

// ─── Interactive background (solar canvas) ──────────────────────────────
let mouseX = 0.5;
let mouseY = 0.5;
let targetMX = 0.5;
let targetMY = 0.5;

function setupSolarBackground() {
  const ctx = solarCanvas.getContext("2d");
  const planets = [
    { radius: 88, size: 2.4, speed: 0.00065, color: "rgba(255,255,255,0.78)" },
    { radius: 134, size: 3.4, speed: 0.00041, color: "rgba(140,200,255,0.62)" },
    { radius: 188, size: 2.8, speed: 0.00029, color: "rgba(255,222,140,0.66)" },
    { radius: 252, size: 5.1, speed: 0.00018, color: "rgba(255,255,255,0.52)" },
    { radius: 322, size: 1.9, speed: 0.00013, color: "rgba(180,160,255,0.5)" }
  ];
  const stars = Array.from({ length: 220 }, () => ({
    x: Math.random(),
    y: Math.random(),
    a: 0.08 + Math.random() * 0.45,
    s: 0.4 + Math.random() * 1.6,
    twinkleSpeed: 0.0005 + Math.random() * 0.0015,
    twinklePhase: Math.random() * Math.PI * 2,
    parallax: 0.4 + Math.random() * 1.6
  }));

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

    // Parallax-shifted star field. Stars drift opposite the mouse for
    // depth feel. Twinkle modulates alpha sinusoidally.
    const offX = (mouseX - 0.5) * 24;
    const offY = (mouseY - 0.5) * 24;
    stars.forEach((star) => {
      const twinkle = 0.5 + 0.5 * Math.sin(time * star.twinkleSpeed + star.twinklePhase);
      ctx.fillStyle = `rgba(255,255,255,${star.a * (0.4 + 0.6 * twinkle)})`;
      const x = star.x * W - offX * star.parallax;
      const y = star.y * H - offY * star.parallax;
      ctx.fillRect(x, y, star.s, star.s);
    });

    // Sun anchor — shifts subtly with mouse for parallax. The big radial
    // glow gives the background a warm focal point that responds to the
    // user's cursor without being distracting.
    const cx = W * 0.62 + (mouseX - 0.5) * 60;
    const cy = H * 0.44 + (mouseY - 0.5) * 60;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 220);
    glow.addColorStop(0, "rgba(255,255,255,0.18)");
    glow.addColorStop(0.18, "rgba(140,180,255,0.10)");
    glow.addColorStop(0.6, "rgba(40,30,60,0.04)");
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, 220, 0, Math.PI * 2);
    ctx.fill();

    // Planetary orbits (ellipses) + moving bodies on them.
    ctx.lineWidth = 1;
    planets.forEach((planet, index) => {
      ctx.strokeStyle = `rgba(255,255,255,${0.04 + (index % 2) * 0.012})`;
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
    cursorGlow.style.transform = `translate3d(${e.clientX - 200}px, ${e.clientY - 200}px, 0)`;
  });
}

// ─── Window controls + view switching ──────────────────────────────────
async function toggleViewMode() {
  try { await window.orbit?.setOverlayState?.("collapsed"); } catch { /* ignore */ }
  try { await window.orbit?.setAppMode?.("overlay"); } catch { /* ignore */ }
}

// ─── Coordinate calibration (mirrors overlay version) ───────────────────
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
}

// ─── Event wiring ───────────────────────────────────────────────────────
newChatButton.addEventListener("click", () => {
  state = createNewChat(state, "New Conversation");
  render();
  persistState();
  promptInput.focus();
});

addProjectButton.addEventListener("click", createProject);
addFileButton.addEventListener("click", addFilesToProject);
settingsButton.addEventListener("click", () => toast("Settings panel coming soon", "default", 2500));

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
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
setupSpeechRecognition();
setupSolarBackground();
setupCursorGlow();
render();
autoResize();
