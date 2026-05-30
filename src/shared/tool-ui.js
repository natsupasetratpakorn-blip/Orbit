const TOOL_TAGS = [
  "execute_command", "run_command", "shell", "bash",
  "write_file", "create_file", "edit_file", "update_file", "patch_file",
  "read_file", "open_file", "read_files", "read_many",
  "list_workspace", "scan_workspace", "list_files", "list_windows",
  "search_workspace", "grep_workspace", "find_in_files", "list_dir", "list_directory",
  "git_status", "git_diff", "git_log",
  "web_search", "deep_research", "read_webpage", "open_url",
  "type_text", "click_pixel", "scroll", "keystroke", "focus_window", "wait", "wait_ms",
  "open_browser", "open_app", "launch_app", "open_application", "start_app",
  "deploy_agent", "delete_file", "remove_file", "move_file", "rename_file",
  "create_directory", "make_dir", "mkdir"
];

const TOOL_PATTERN = TOOL_TAGS.join("|");
const TOOL_START_RE = new RegExp(`<(?<tag>${TOOL_PATTERN})\\b(?<attrs>[^>]*)>?`, "gi");
const COMPLETE_TOOL_RE = new RegExp(
  `<(?<paired>${TOOL_PATTERN})\\b[^>]*>[\\s\\S]*?</\\k<paired>>|<(?<self>${TOOL_PATTERN})\\b[^>]*\\s*/>`,
  "gi"
);

function canonicalToolType(type) {
  if (["run_command", "shell", "bash"].includes(type)) return "execute_command";
  if (["create_file", "edit_file", "update_file"].includes(type)) return "write_file";
  if (type === "open_file") return "read_file";
  if (["read_many"].includes(type)) return "read_files";
  if (["scan_workspace", "list_files"].includes(type)) return "list_workspace";
  if (["grep_workspace", "find_in_files"].includes(type)) return "search_workspace";
  if (type === "list_directory") return "list_dir";
  if (["launch_app", "open_application", "start_app"].includes(type)) return "open_app";
  if (type === "remove_file") return "delete_file";
  if (type === "rename_file") return "move_file";
  if (["make_dir", "mkdir"].includes(type)) return "create_directory";
  if (type === "wait") return "wait_ms";
  return type;
}

function basename(value) {
  const s = String(value || "").replace(/\\/g, "/");
  return s.split("/").filter(Boolean).pop() || s || "file";
}

function extractAttr(attrs, name) {
  const match = String(attrs || "").match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : "";
}

function normalizeStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "success" || s === "done" || s === "completed") return "success";
  if (s === "error" || s === "failed") return "error";
  if (s === "running" || s === "working" || s === "pending" || s === "idle") return "running";
  return "running";
}

function commandBadge(commandCount, status) {
  const count = Math.max(1, commandCount);
  const normalized = normalizeStatus(status);
  if (normalized === "success") {
    return { kind: "terminal", label: count === 1 ? "Ran command" : `Ran ${count} commands`, count, status: normalized };
  }
  if (normalized === "error") {
    return { kind: "terminal", label: count === 1 ? "Command failed" : `${count} commands finished with errors`, count, status: normalized };
  }
  return { kind: "terminal", label: count === 1 ? "Running command" : `Running ${count} commands`, count, status: normalized };
}

export function toolBadgeForPart(part, status = "running") {
  const type = canonicalToolType(part?.type || "");
  const normalized = normalizeStatus(status);
  const finished = normalized === "success";
  const fileName = basename(part?.path || part?.from || part?.to);

  if (type === "execute_command") return commandBadge(1, normalized);
  if (type === "write_file") return { kind: "edit", label: finished ? `Wrote ${fileName}` : `Writing ${fileName}`, count: 1, status: normalized };
  if (type === "patch_file") return { kind: "edit", label: finished ? `Edited ${fileName}` : `Editing ${fileName}`, count: 1, status: normalized };
  if (type === "read_file") return { kind: "read", label: finished ? `Read ${fileName}` : `Reading ${fileName}`, count: 1, status: normalized };
  if (type === "read_files") return { kind: "read", label: finished ? "Read files" : "Reading files", count: 1, status: normalized };
  if (type === "web_search") return { kind: "research", label: finished ? `Searched "${part?.query || "web"}"` : `Searching "${part?.query || "web"}"`, count: 1, status: normalized };
  if (type === "deep_research") return { kind: "research", label: finished ? `Researched "${part?.query || "web"}"` : `Researching "${part?.query || "web"}"`, count: 1, status: normalized };
  if (type === "read_webpage") return { kind: "research", label: finished ? "Read webpage" : "Reading webpage", count: 1, status: normalized };
  if (type === "search_workspace") return { kind: "read", label: finished ? "Searched workspace" : "Searching workspace", count: 1, status: normalized };
  if (type === "list_workspace") return { kind: "read", label: finished ? "Scanned workspace" : "Scanning workspace", count: 1, status: normalized };
  if (type === "list_dir") return { kind: "read", label: finished ? `Listed ${fileName}` : `Listing ${fileName}`, count: 1, status: normalized };
  if (type.startsWith("git_")) return { kind: "terminal", label: finished ? "Checked git" : "Checking git", count: 1, status: normalized };
  if (type === "type_text") return { kind: "action", label: finished ? "Typed text" : "Typing text", count: 1, status: normalized };
  if (type === "click_pixel") return { kind: "action", label: finished ? "Clicked" : "Clicking", count: 1, status: normalized };
  if (type === "deploy_agent") return { kind: "agent", label: finished ? "Deployed agent" : "Deploying agent", count: 1, status: normalized };
  if (type === "open_url" || type === "open_browser") return { kind: "action", label: finished ? "Opened URL" : "Opening URL", count: 1, status: normalized };
  if (type === "open_app") return { kind: "action", label: finished ? `Opened ${part?.name || "app"}` : `Opening ${part?.name || "app"}`, count: 1, status: normalized };
  return { kind: "action", label: finished ? `Used ${type || "tool"}` : `Using ${type || "tool"}`, count: 1, status: normalized };
}

export function buildInlineToolBadges(parts, statusForPart = () => "running") {
  const badges = [];
  let commandCount = 0;
  let commandStatus = "success";

  const flushCommands = () => {
    if (commandCount === 0) return;
    badges.push(commandBadge(commandCount, commandStatus));
    commandCount = 0;
    commandStatus = "success";
  };

  const list = Array.isArray(parts) ? parts : [];
  for (let idx = 0; idx < list.length; idx++) {
    const part = list[idx];
    const status = statusForPart(part, idx);
    if (canonicalToolType(part?.type || "") === "execute_command") {
      commandCount += 1;
      const normalized = normalizeStatus(status);
      if (normalized === "running") commandStatus = "running";
      else if (normalized === "error" && commandStatus !== "running") commandStatus = "error";
      continue;
    }

    flushCommands();
    badges.push(toolBadgeForPart(part, status));
  }
  flushCommands();
  return badges;
}

function partsFromToolStarts(text) {
  const parts = [];
  TOOL_START_RE.lastIndex = 0;
  let match;
  while ((match = TOOL_START_RE.exec(text)) !== null) {
    const tag = canonicalToolType(String(match.groups?.tag || "").toLowerCase());
    const attrs = match.groups?.attrs || "";
    parts.push({
      type: tag,
      path: extractAttr(attrs, "path"),
      from: extractAttr(attrs, "from"),
      to: extractAttr(attrs, "to"),
      url: extractAttr(attrs, "url"),
      query: extractAttr(attrs, "query"),
      name: extractAttr(attrs, "name")
    });
  }
  return parts;
}

export function stripToolXmlForDisplay(text) {
  const raw = String(text || "");
  let cleaned = raw.replace(COMPLETE_TOOL_RE, "");
  const partialStart = cleaned.search(new RegExp(`<(?:${TOOL_PATTERN})\\b`, "i"));
  if (partialStart !== -1) cleaned = cleaned.slice(0, partialStart);
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

export function streamingToolDisplay(text) {
  const raw = String(text || "");
  const parts = partsFromToolStarts(raw);
  return {
    text: stripToolXmlForDisplay(raw),
    badges: buildInlineToolBadges(parts, () => "running")
  };
}
