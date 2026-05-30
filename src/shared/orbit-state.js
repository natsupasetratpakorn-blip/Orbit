const DEFAULT_TIME = "2026-05-28T00:00:00.000Z";

function id(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function createChat({ id: chatId, title, createdAt, messages = [] }) {
  return {
    id: chatId,
    title,
    createdAt,
    messages,
    conversationSummary: "",
    summarizedCount: 0
  };
}

export function createDefaultOrbitState(now = DEFAULT_TIME) {
  const chatId = "chat-voyager-ai";
  const projectId = "project-orbit";

  return {
    activeProjectId: projectId,
    activeChatId: chatId,
    projects: [
      {
        id: projectId,
        name: "Solar System Survey",
        updatedAt: now,
        chats: [
          createChat({ id: chatId, title: "Voyager AI", createdAt: now })
        ]
      }
    ]
  };
}

export function createNewChat(state, title = "New Conversation", now = new Date().toISOString()) {
  const chat = createChat({
    id: id("chat"),
    title,
    createdAt: now
  });

  const projects = state.projects.map((project) => {
    if (project.id !== state.activeProjectId) return project;
    return {
      ...project,
      updatedAt: now,
      chats: [...project.chats, chat]
    };
  });

  return {
    ...state,
    activeChatId: chat.id,
    projects
  };
}

export function addMessageToActiveChat(state, message, now = new Date().toISOString()) {
  return {
    ...state,
    projects: state.projects.map((project) => {
      if (project.id !== state.activeProjectId) return project;

      return {
        ...project,
        updatedAt: now,
        chats: project.chats.map((chat) => {
          if (chat.id !== state.activeChatId) return chat;
          return {
            ...chat,
            messages: [...chat.messages, message]
          };
        })
      };
    })
  };
}

export function updateActiveChatMemory(state, { conversationSummary = "", summarizedCount = 0 } = {}) {
  const safeSummary = typeof conversationSummary === "string" ? conversationSummary : "";
  const safeCount = Number.isInteger(summarizedCount) && summarizedCount >= 0 ? summarizedCount : 0;

  return {
    ...state,
    projects: state.projects.map((project) => {
      if (project.id !== state.activeProjectId) return project;

      return {
        ...project,
        chats: project.chats.map((chat) => {
          if (chat.id !== state.activeChatId) return chat;
          return {
            ...chat,
            conversationSummary: safeSummary,
            summarizedCount: safeCount
          };
        })
      };
    })
  };
}

export function selectProject(state, projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return state;

  return {
    ...state,
    activeProjectId: project.id,
    activeChatId: project.chats.at(-1)?.id ?? null
  };
}

export function getActiveProject(state) {
  return state.projects.find((project) => project.id === state.activeProjectId) ?? null;
}

export function getActiveChat(state) {
  const project = getActiveProject(state);
  return project?.chats.find((chat) => chat.id === state.activeChatId) ?? null;
}
