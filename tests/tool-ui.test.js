import { describe, expect, it } from "vitest";

import { buildInlineToolBadges, streamingToolDisplay } from "../src/shared/tool-ui.js";

describe("streamingToolDisplay", () => {
  it("hides partial tool XML and exposes an inline badge", () => {
    const display = streamingToolDisplay('Working on it.\n<patch_file path="src/orbit-app/app.js">\n<<<<<<< SEARCH\nold');

    expect(display.text).toBe("Working on it.");
    expect(display.badges).toEqual([
      { kind: "edit", label: "Editing app.js", count: 1, status: "running" }
    ]);
  });

  it("groups streamed command tags into one terminal badge", () => {
    const display = streamingToolDisplay("<execute_command>npm test</execute_command>\n<execute_command>npm run lint");

    expect(display.text).toBe("");
    expect(display.badges).toEqual([
      { kind: "terminal", label: "Running 2 commands", count: 2, status: "running" }
    ]);
  });
});

describe("buildInlineToolBadges", () => {
  it("groups consecutive completed commands into one badge", () => {
    const badges = buildInlineToolBadges([
      { type: "execute_command", content: "npm test" },
      { type: "execute_command", content: "npm run lint" }
    ], () => "success");

    expect(badges).toEqual([
      { kind: "terminal", label: "Ran 2 commands", count: 2, status: "success" }
    ]);
  });

  it("marks grouped commands as running if any command is still running", () => {
    const badges = buildInlineToolBadges([
      { type: "execute_command", content: "npm test" },
      { type: "execute_command", content: "npm run lint" }
    ], (_part, idx) => idx === 0 ? "success" : "running");

    expect(badges).toEqual([
      { kind: "terminal", label: "Running 2 commands", count: 2, status: "running" }
    ]);
  });

  it("creates concise badges for non-command tools", () => {
    const badges = buildInlineToolBadges([
      { type: "patch_file", path: "src/main/main.js" },
      { type: "deep_research", query: "Electron IPC security" }
    ], () => "running");

    expect(badges).toEqual([
      { kind: "edit", label: "Editing main.js", count: 1, status: "running" },
      { kind: "research", label: 'Researching "Electron IPC security"', count: 1, status: "running" }
    ]);
  });

  it("uses completed wording for successful research tools", () => {
    const badges = buildInlineToolBadges([
      { type: "web_search", query: "Max Verstappen trophies" },
      { type: "deep_research", query: "Electron IPC security" },
      { type: "read_webpage" }
    ], () => "success");

    expect(badges).toEqual([
      { kind: "research", label: 'Searched "Max Verstappen trophies"', count: 1, status: "success" },
      { kind: "research", label: 'Researched "Electron IPC security"', count: 1, status: "success" },
      { kind: "research", label: "Read webpage", count: 1, status: "success" }
    ]);
  });
});
