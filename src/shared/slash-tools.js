export const TOOL_SLASH_COMMANDS = [
  {
    name: "/web-search",
    desc: "Search the web for quick, current snippets",
    template: "/web-search ",
    type: "web_search",
    usage: "/web-search <query>"
  },
  {
    name: "/deep-search",
    desc: "Search and read the top results for a deeper report",
    template: "/deep-search ",
    type: "deep_research",
    usage: "/deep-search <query>"
  }
];

const TOOL_COMMAND_BY_NAME = new Map(TOOL_SLASH_COMMANDS.map((cmd) => [cmd.name, cmd]));

function escapeToolQuery(query) {
  return String(query || "").replace(/"/g, "'");
}

export function parseSlashToolCommand(input) {
  const text = String(input || "").trim();
  const [head = ""] = text.split(/\s+/, 1);
  const command = TOOL_COMMAND_BY_NAME.get(head.toLowerCase());
  if (!command) return null;

  const query = text.slice(head.length).trim();
  if (!query) {
    return {
      name: command.name,
      type: command.type,
      query: "",
      error: `Please provide a search query. Usage: ${command.usage}`,
      usage: command.usage
    };
  }

  const safeQuery = escapeToolQuery(query);
  return {
    name: command.name,
    type: command.type,
    query,
    assistantContent: `<${command.type} query="${safeQuery}" />`,
    usage: command.usage
  };
}
