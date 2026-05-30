import { describe, expect, it } from "vitest";

import { parseSlashToolCommand, TOOL_SLASH_COMMANDS } from "../src/shared/slash-tools.js";

describe("parseSlashToolCommand", () => {
  it("converts /deep-search into a deep_research tool request", () => {
    expect(parseSlashToolCommand("/deep-search Max Verstappen trophies")).toEqual({
      name: "/deep-search",
      type: "deep_research",
      query: "Max Verstappen trophies",
      assistantContent: '<deep_research query="Max Verstappen trophies" />',
      usage: "/deep-search <query>"
    });
  });

  it("converts /web-search into a web_search tool request", () => {
    expect(parseSlashToolCommand("/web-search Electron IPC security")).toEqual({
      name: "/web-search",
      type: "web_search",
      query: "Electron IPC security",
      assistantContent: '<web_search query="Electron IPC security" />',
      usage: "/web-search <query>"
    });
  });

  it("returns a usage error when a tool slash command has no query", () => {
    expect(parseSlashToolCommand("/deep-search")).toEqual({
      name: "/deep-search",
      type: "deep_research",
      query: "",
      error: "Please provide a search query. Usage: /deep-search <query>",
      usage: "/deep-search <query>"
    });
  });

  it("lists deep search for slash menus", () => {
    expect(TOOL_SLASH_COMMANDS.map((cmd) => cmd.name)).toContain("/deep-search");
  });
});
