import {
  addMessageToActiveChat,
  createDefaultOrbitState,
  createNewChat,
  getActiveChat,
  getActiveProject,
  selectProject
} from "../shared/orbit-state.js";

const STORAGE_KEY = "orbit.antigravity.workspace";
const DEFAULT_MODEL = "Voyager 1 Flash";

const projectsList = document.querySelector("#projectsList");
const conversationsList = document.querySelector("#conversationsList");
const newChatButton = document.querySelector("#newChatButton");
const addProjectButton = document.querySelector("#addProjectButton");
const activeProjectName = document.querySelector("#activeProjectName");
const messagesEl = document.querySelector("#messages");
const emptyState = document.querySelector("#emptyState");
const composer = document.querySelector("#composer");
const promptInput = document.querySelector("#promptInput");
const modelSelect = document.querySelector("#modelSelect");
const sendButton = document.querySelector("#sendButton");
const micButton = document.querySelector("#micButton");
const solarCanvas = document.querySelector("#solarCanvas");
const viewModeButton = document.querySelector("#viewModeButton");
const composerModeButton = document.querySelector("#composerModeButton");

let state = loadState();
let selectedModel = DEFAULT_MODEL;
let recognition = null;
let isListening = false;
let viewMode = localStorage.getItem("orbit.viewMode") === "overlay" ? "overlay" : "mission-control";

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (parsed?.projects?.length) return parsed;
  } catch {
    // Fall through to default state.
  }
  return createDefaultOrbitState();
}

function persistState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  const activeChat = getActiveChat(state);
  window.orbit?.saveHistory?.({
    selectedModel,
    messages: activeChat?.messages ?? [],
    workspacePath: "",
    agentMode: false,
    panelWidthMode: "standard"
  });
}

async function setViewMode(mode) {
  if (mode === "overlay") {
    localStorage.setItem("orbit.viewMode", "overlay");
    await window.orbit?.setAppMode?.("overlay");
    return;
  }

  viewMode = "mission-control";
  localStorage.setItem("orbit.viewMode", viewMode);
  document.body.dataset.viewMode = viewMode;
  viewModeButton.textContent = "Open Overlay";
  composerModeButton.textContent = "Open Overlay";
  composerModeButton.title = "Switch to the floating overlay";
  viewModeButton.title = composerModeButton.title;
  await window.orbit?.setOverlayState?.("mission-control");
  setTimeout(() => {
    window.dispatchEvent(new Event("resize"));
  }, 80);
}

function toggleViewMode() {
  setViewMode("overlay");
}

function formatAge(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function renderProjects() {
  const activeProject = getActiveProject(state);
  activeProjectName.textContent = activeProject?.name ?? "Orbit";
  projectsList.innerHTML = "";

  state.projects.forEach((project) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `project-row${project.id === state.activeProjectId ? " is-active" : ""}`;
    item.innerHTML = `
      <span class="folder-outline"></span>
      <span class="project-meta">
        <span class="project-name"></span>
        <span class="project-subline"></span>
      </span>
      <span class="activity-dot"></span>
    `;
    item.querySelector(".project-name").textContent = project.name;
    item.querySelector(".project-subline").textContent = project.chats.at(-1)?.title ?? "No conversations yet";
    item.addEventListener("click", () => {
      state = selectProject(state, project.id);
      render();
      persistState();
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
    conversationsList.append(item);
  });
}

function renderMessages() {
  const activeChat = getActiveChat(state);
  const messages = activeChat?.messages ?? [];
  messagesEl.innerHTML = "";
  emptyState.hidden = messages.length > 0;
  messagesEl.hidden = messages.length === 0;

  messages.forEach((message) => {
    const item = document.createElement("article");
    item.className = `message ${message.role === "user" ? "message-user" : "message-assistant"}`;
    const role = message.role === "user" ? "You" : "Voyager";
    item.innerHTML = `
      <div class="message-meta"></div>
      <div class="message-body"></div>
    `;
    item.querySelector(".message-meta").textContent = `${role} · ${new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    item.querySelector(".message-body").textContent = message.content;
    messagesEl.append(item);
  });

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function render() {
  renderProjects();
  renderConversations();
  renderMessages();
}

function titleFromPrompt(prompt) {
  const clean = prompt.replace(/\s+/g, " ").trim();
  if (!clean) return "New Conversation";
  return clean.length > 32 ? `${clean.slice(0, 32)}...` : clean;
}

async function sendMessage(content) {
  const text = content.trim();
  if (!text) return;

  const userMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: text,
    timestamp: new Date().toISOString()
  };
  state = addMessageToActiveChat(state, userMessage);
  promptInput.value = "";
  render();
  persistState();

  sendButton.disabled = true;

  let responseText = "";
  try {
    const activeChat = getActiveChat(state);
    const screenshotPath = await window.orbit?.captureScreen?.();
    const response = await window.orbit?.sendToAI?.({
      model: selectedModel,
      messages: activeChat.messages,
      screenshotPath,
      agentMode: false,
      mode: "ask",
      streamId: crypto.randomUUID()
    });
    responseText = response?.text || response?.content || "";
  } catch {
    responseText = "";
  }

  if (!responseText) {
    responseText = "Voyager AI is ready. AI integration is available when provider credentials are configured; this message was saved with the current Orbit workspace context.";
  }

  state = addMessageToActiveChat(state, {
    id: crypto.randomUUID(),
    role: "assistant",
    content: responseText,
    timestamp: new Date().toISOString()
  });
  render();
  persistState();
  sendButton.disabled = false;
}

function createProject() {
  const count = state.projects.length + 1;
  const now = new Date().toISOString();
  const project = {
    id: crypto.randomUUID(),
    name: `Orbit Project ${count}`,
    updatedAt: now,
    chats: [
      {
        id: crypto.randomUUID(),
        title: "New Conversation",
        createdAt: now,
        messages: []
      }
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
}

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    micButton.disabled = true;
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    let transcript = "";
    for (let index = 0; index < event.results.length; index += 1) {
      transcript += event.results[index][0].transcript;
    }
    promptInput.value = transcript.trim();
  };

  recognition.onend = () => {
    isListening = false;
    micButton.classList.remove("is-listening");
  };
}

function setupSolarBackground() {
  const ctx = solarCanvas.getContext("2d");
  const planets = [
    { radius: 74, size: 2.2, speed: 0.0007, color: "rgba(255,255,255,0.7)" },
    { radius: 118, size: 3.3, speed: 0.00043, color: "rgba(133,196,255,0.58)" },
    { radius: 170, size: 2.6, speed: 0.00028, color: "rgba(255,214,135,0.62)" },
    { radius: 230, size: 4.8, speed: 0.00018, color: "rgba(255,255,255,0.48)" }
  ];
  const stars = Array.from({ length: 130 }, () => ({
    x: Math.random(),
    y: Math.random(),
    a: 0.12 + Math.random() * 0.42,
    s: 0.4 + Math.random() * 1.3
  }));

  function resize() {
    const rect = solarCanvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    solarCanvas.width = Math.round(rect.width * scale);
    solarCanvas.height = Math.round(rect.height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  function frame(time) {
    const width = solarCanvas.clientWidth;
    const height = solarCanvas.clientHeight;
    ctx.clearRect(0, 0, width, height);

    stars.forEach((star) => {
      ctx.fillStyle = `rgba(255,255,255,${star.a})`;
      ctx.fillRect(star.x * width, star.y * height, star.s, star.s);
    });

    const cx = width * 0.64;
    const cy = height * 0.46;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 150);
    glow.addColorStop(0, "rgba(255,255,255,0.16)");
    glow.addColorStop(0.2, "rgba(120,170,255,0.08)");
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, 150, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(255,255,255,0.055)";
    ctx.lineWidth = 1;
    planets.forEach((planet, index) => {
      ctx.beginPath();
      ctx.ellipse(cx, cy, planet.radius * 1.55, planet.radius * 0.54, -0.18, 0, Math.PI * 2);
      ctx.stroke();

      const angle = time * planet.speed + index * 1.8;
      const x = cx + Math.cos(angle) * planet.radius * 1.55;
      const y = cy + Math.sin(angle) * planet.radius * 0.54;
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

newChatButton.addEventListener("click", () => {
  state = createNewChat(state, "New Conversation");
  render();
  persistState();
  promptInput.focus();
});

addProjectButton.addEventListener("click", createProject);

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const activeChat = getActiveChat(state);
  if (activeChat?.messages.length === 0) {
    const title = titleFromPrompt(promptInput.value);
    state = {
      ...state,
      projects: state.projects.map((project) => {
        if (project.id !== state.activeProjectId) return project;
        return {
          ...project,
          chats: project.chats.map((chat) => chat.id === state.activeChatId ? { ...chat, title } : chat)
        };
      })
    };
  }
  await sendMessage(promptInput.value);
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

modelSelect.addEventListener("change", () => {
  selectedModel = modelSelect.value;
  persistState();
});

micButton.addEventListener("click", () => {
  if (!recognition) return;
  if (isListening) {
    recognition.stop();
    return;
  }
  isListening = true;
  micButton.classList.add("is-listening");
  recognition.start();
});

document.querySelector("#minimizeWindow").addEventListener("click", () => window.orbit?.minimizeWindow?.());
document.querySelector("#maximizeWindow").addEventListener("click", () => window.orbit?.toggleMaximizeWindow?.());
document.querySelector("#closeWindow").addEventListener("click", () => window.orbit?.closeWindow?.());
viewModeButton.addEventListener("click", toggleViewMode);
composerModeButton.addEventListener("click", toggleViewMode);

setViewMode("mission-control");
setupSpeechRecognition();
setupSolarBackground();
render();
