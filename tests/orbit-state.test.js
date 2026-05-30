import { describe, expect, it } from "vitest";

import {
  addMessageToActiveChat,
  createOrbitDataExport,
  createDefaultOrbitState,
  createNewChat,
  readOrbitDataImport,
  updateActiveChatMemory,
  selectProject
} from "../src/shared/orbit-state.js";

describe("orbit mission control state", () => {
  it("starts with a default project and active Voyager AI chat", () => {
    const state = createDefaultOrbitState();

    expect(state.projects).toHaveLength(1);
    expect(state.projects[0].name).toBe("Solar System Survey");
    expect(state.activeProjectId).toBe(state.projects[0].id);
    expect(state.activeChatId).toBe(state.projects[0].chats[0].id);
    expect(state.projects[0].chats[0].title).toBe("Voyager AI");
    expect(state.projects[0].chats[0].conversationSummary).toBe("");
    expect(state.projects[0].chats[0].summarizedCount).toBe(0);
  });

  it("creates a new chat in the active project and selects it", () => {
    const state = createNewChat(createDefaultOrbitState(), "Europa habitability");
    const project = state.projects[0];

    expect(project.chats).toHaveLength(2);
    expect(state.activeChatId).toBe(project.chats[1].id);
    expect(project.chats[1].title).toBe("Europa habitability");
    expect(project.chats[1].conversationSummary).toBe("");
    expect(project.chats[1].summarizedCount).toBe(0);
  });

  it("updates rolling memory on the active chat only", () => {
    const state = createNewChat(createDefaultOrbitState(), "Saturn rings");
    const next = updateActiveChatMemory(state, {
      conversationSummary: "Discussed Saturn rings.",
      summarizedCount: 8
    });

    const activeChat = next.projects[0].chats.find((chat) => chat.id === next.activeChatId);
    const inactiveChat = next.projects[0].chats.find((chat) => chat.id !== next.activeChatId);

    expect(activeChat.conversationSummary).toBe("Discussed Saturn rings.");
    expect(activeChat.summarizedCount).toBe(8);
    expect(inactiveChat.conversationSummary).toBe("");
    expect(inactiveChat.summarizedCount).toBe(0);
  });

  it("adds messages only to the active chat", () => {
    const state = createNewChat(createDefaultOrbitState(), "Saturn rings");
    const next = addMessageToActiveChat(state, {
      id: "msg-1",
      role: "user",
      content: "Explain the Cassini Division",
      timestamp: "2026-05-28T00:00:00.000Z"
    });

    const activeChat = next.projects[0].chats.find((chat) => chat.id === next.activeChatId);
    const inactiveChat = next.projects[0].chats.find((chat) => chat.id !== next.activeChatId);

    expect(activeChat.messages).toHaveLength(1);
    expect(inactiveChat.messages).toHaveLength(0);
  });

  it("selects a project and its most recent chat", () => {
    const state = {
      ...createDefaultOrbitState(),
      projects: [
        ...createDefaultOrbitState().projects,
        {
          id: "project-outer-planets",
          name: "Outer Planets",
          updatedAt: "2026-05-28T00:00:00.000Z",
          chats: [
            { id: "chat-neptune", title: "Neptune flyby", messages: [], createdAt: "2026-05-28T00:00:00.000Z" }
          ]
        }
      ]
    };

    const next = selectProject(state, "project-outer-planets");

    expect(next.activeProjectId).toBe("project-outer-planets");
    expect(next.activeChatId).toBe("chat-neptune");
  });

  it("wraps and unwraps exportable Orbit data", () => {
    const state = createDefaultOrbitState();
    const payload = createOrbitDataExport(state, "2026-05-30T00:00:00.000Z");

    expect(payload.version).toBe(1);
    expect(payload.exportedAt).toBe("2026-05-30T00:00:00.000Z");
    expect(readOrbitDataImport(payload)).toEqual(state);
    expect(readOrbitDataImport(state)).toEqual(state);
    expect(() => readOrbitDataImport({ nope: true })).toThrow("Invalid Orbit data export");
  });
});
