export function parseAIResponse(content) {
  const parts = [];
  if (!content) return parts;

  // Regex to extract tool blocks:
  // 1. <execute_command>code</execute_command>           (aliases: run_command, shell, bash)
  // 2. <write_file path="...">code</write_file>          (aliases: create_file, edit_file, update_file)
  // 3. <patch_file path="...">search/replace</patch_file>
  // 4. <read_file path="..." /> or paired                (alias: open_file)
  // 5. <type_text window="title">text</type_text>
  // 6. <list_workspace />                                (alias: scan_workspace, list_files)
  // 7. <click_pixel x="..." y="..." />
  // 8. <open_browser url="..." />
  // 9. <deploy_agent task="..." />
  const regex = /<(execute_command|run_command|shell|bash|write_file|create_file|edit_file|update_file|patch_file|read_file|open_file|type_text|open_browser|deploy_agent|search_workspace|grep_workspace|find_in_files|keystroke|ask_user_questions)(?:\s+(?:path|window|url|task|mode|shell)="([^"]+)")?\s*>([\s\S]*?)<\/\1>|<(?:read_file|open_file)\s+path="([^"]+)"\s*\/>|<(list_workspace|scan_workspace|list_files|list_windows|list_apps|list_applications)\s*\/>|<click_pixel\s+x="(\d+)"\s+y="(\d+)"\s*\/>|<open_browser\s+url="([^"]+)"\s*\/>|<deploy_agent\s+task="([^"]+)"\s*\/>|<scroll\s+x="(\d+)"\s+y="(\d+)"\s+ticks="(-?\d+)"\s*\/>|<focus_window\s+title="([^"]+)"\s*\/>|<wait(?:_ms)?\s+ms="(\d+)"\s*\/>|<(right_click|double_click)\s+x="(\d+)"\s+y="(\d+)"\s*\/>/gs;

  // Canonicalize aliases so downstream rendering/execution only deals with the
  // four canonical types.
  const canonicalize = (tag) => {
    if (tag === "run_command" || tag === "shell" || tag === "bash") return "execute_command";
    if (tag === "create_file" || tag === "edit_file" || tag === "update_file") return "write_file";
    if (tag === "open_file") return "read_file";
    if (tag === "scan_workspace" || tag === "list_files") return "list_workspace";
    if (tag === "list_apps" || tag === "list_applications") return "list_windows";
    if (tag === "grep_workspace" || tag === "find_in_files") return "search_workspace";
    if (tag === "ask_user_questions") return "ask_user_questions";
    return tag;
  };

  let match;
  let lastIndex = 0;

  while ((match = regex.exec(content)) !== null) {
    const textBefore = content.substring(lastIndex, match.index);
    if (textBefore.trim()) {
      parts.push({ type: "text", content: textBefore });
    }

    if (match[17] && match[18] && match[19]) {
      // <right_click /> or <double_click /> — sugar over click_pixel
      const kind = match[17];
      parts.push({
        type: "click_pixel",
        x: parseInt(match[18], 10),
        y: parseInt(match[19], 10),
        button: kind === "right_click" ? "right" : "left",
        count: kind === "double_click" ? 2 : 1
      });
    } else if (match[16]) {
      parts.push({ type: "wait_ms", ms: parseInt(match[16], 10) });
    } else if (match[15]) {
      parts.push({ type: "focus_window", window: match[15] });
    } else if (match[10] && match[11] && match[12]) {
      parts.push({
        type: "scroll",
        x: parseInt(match[10], 10),
        y: parseInt(match[11], 10),
        ticks: parseInt(match[12], 10)
      });
    } else if (match[6] && match[7]) {
      // click_pixel
      parts.push({
        type: "click_pixel",
        x: parseInt(match[6], 10),
        y: parseInt(match[7], 10)
      });
    } else if (match[8]) {
      // self-closing open_browser
      parts.push({
        type: "open_browser",
        url: match[8]
      });
    } else if (match[9]) {
      // self-closing deploy_agent
      parts.push({
        type: "deploy_agent",
        task: match[9]
      });
    } else if (match[5]) {
      // self-closing list_workspace / scan_workspace / list_files
      parts.push({ type: canonicalize(match[5]) });
    } else if (match[4]) {
      // self-closing read_file / open_file
      parts.push({
        type: "read_file",
        path: match[4]
      });
    } else {
      const type = canonicalize(match[1]);
      const attr = match[2];
      const code = match[3];

      // type_text uses a `window` attribute pointing at the target window
      // title — semantically not a file path, so keep it on its own field.
      if (type === "type_text") {
        parts.push({ type, window: attr, content: code });
      } else if (type === "keystroke") {
        parts.push({ type, window: attr, content: code });
      } else if (type === "execute_command") {
        // Optional shell="cmd|powershell|bash" attribute selects the interpreter.
        // Preserve the historical `path: undefined` field so downstream consumers
        // and snapshot tests don't break.
        const node = { type, path: undefined, content: code };
        if (attr) node.shell = attr;
        parts.push(node);
      } else if (type === "open_browser") {
        parts.push({ type, url: attr, content: code });
      } else if (type === "deploy_agent") {
        parts.push({ type, task: attr, content: code });
      } else if (type === "search_workspace") {
        // The body of <search_workspace>...</search_workspace> is the query.
        // Optional `mode="regex"` attribute switches from literal to regex.
        parts.push({ type, query: (code || "").trim(), mode: attr || "literal" });
      } else if (type === "ask_user_questions") {
        parts.push({ type, content: code });
      } else {
        parts.push({ type, path: attr, content: code });
      }
    }

    lastIndex = regex.lastIndex;
  }

  const textAfter = content.substring(lastIndex);
  if (textAfter.trim()) {
    parts.push({ type: "text", content: textAfter });
  }

  if (parts.length === 0 && content) {
    parts.push({ type: "text", content });
  }

  // Second pass: expand any text parts that contain the newer coding tools.
  // These tags are intentionally kept out of the monolithic regex above so
  // adding them can't shift its positional capture groups. Each text segment
  // is re-scanned and split into text + tool parts, preserving order.
  const expanded = [];
  for (const part of parts) {
    if (part.type === "text") {
      for (const sub of parseExtendedTools(part.content)) expanded.push(sub);
    } else {
      expanded.push(part);
    }
  }
  return expanded;
}

// Matches the extended coding toolset. Named capture groups let us identify
// which tag fired without juggling positional indices. Tags that take no
// attributes wrap their own name in a group so we can detect a hit.
const EXTENDED_TOOLS_RE = new RegExp(
  [
    // <read_file path="..." lines="10-40" /> — precise line-range read
    `<(?:read_file|open_file)\\s+path="(?<rf_path>[^"]+)"\\s+lines="(?<rf_start>\\d+)-(?<rf_end>\\d+)"\\s*/>`,
    // <list_dir path="..." /> (alias list_directory) — targeted listing
    `<(?:list_dir|list_directory)\\s+path="(?<ls_path>[^"]+)"\\s*/>`,
    // <delete_file path="..." /> (alias remove_file)
    `<(?:delete_file|remove_file)\\s+path="(?<del_path>[^"]+)"\\s*/>`,
    // <create_directory path="..." /> (aliases make_dir, mkdir)
    `<(?:create_directory|make_dir|mkdir)\\s+path="(?<mkdir_path>[^"]+)"\\s*/>`,
    // <move_file from="..." to="..." /> (alias rename_file)
    `<(?:move_file|rename_file)\\s+from="(?<mv_from>[^"]+)"\\s+to="(?<mv_to>[^"]+)"\\s*/>`,
    // <git_status />
    `<(?<git_status>git_status)\\s*/>`,
    // <git_diff /> or <git_diff path="..." />
    `<(?<git_diff>git_diff)(?:\\s+path="(?<gd_path>[^"]+)")?\\s*/>`,
    // <git_log /> or <git_log count="N" />
    `<(?<git_log>git_log)(?:\\s+count="(?<gl_count>\\d+)")?\\s*/>`,
    // <open_app name="Spotify" args="..." /> (aliases launch_app, open_application,
    // start_app) — launch a desktop application by name/path. `args` optional.
    `<(?:open_app|launch_app|open_application|start_app)\\s+name="(?<app_name>[^"]+)"(?:\\s+args="(?<app_args>[^"]*)")?\\s*/>`,
    // <web_search query="..." /> — search the public web and return compact
    // title/url/snippet results.
    `<web_search\\s+query="(?<web_query>[^"]+)"\\s*/>`,
    // <deep_research query="..." /> — search the public web, read the top
    // results, and return one consolidated report.
    `<deep_research\\s+query="(?<deep_query>[^"]+)"\\s*/>`,
    // <read_webpage url="https://..." /> — fetch and summarize readable page text.
    `<read_webpage\\s+url="(?<web_read_url>[^"]+)"\\s*/>`,
    // <open_url url="https://..." /> — explicit URL-opening alias.
    `<open_url\\s+url="(?<open_url>[^"]+)"\\s*/>`,
    // <read_files glob="src/**/*.js" /> — batch-read every file matching a glob.
    `<(?:read_files|read_many)\\s+glob="(?<rfs_glob>[^"]+)"\\s*/>`,
    // <read_files>path1\npath2\n...</read_files> — batch-read an explicit list
    // (newline- or comma-separated). One tool call, parallel read, one result.
    `<(?:read_files|read_many)\\s*>(?<rfs_body>[\\s\\S]*?)</(?:read_files|read_many)>`
  ].join("|"),
  "gs"
);

export function parseExtendedTools(text) {
  if (!text) return [];
  const out = [];
  let lastIndex = 0;
  let match;
  EXTENDED_TOOLS_RE.lastIndex = 0;
  while ((match = EXTENDED_TOOLS_RE.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before.trim()) out.push({ type: "text", content: before });
    const g = match.groups || {};
    if (g.rf_path) {
      out.push({ type: "read_file", path: g.rf_path, start: parseInt(g.rf_start, 10), end: parseInt(g.rf_end, 10) });
    } else if (g.ls_path) {
      out.push({ type: "list_dir", path: g.ls_path });
    } else if (g.del_path) {
      out.push({ type: "delete_file", path: g.del_path });
    } else if (g.mkdir_path) {
      out.push({ type: "create_directory", path: g.mkdir_path });
    } else if (g.mv_from) {
      out.push({ type: "move_file", from: g.mv_from, to: g.mv_to });
    } else if (g.git_status) {
      out.push({ type: "git_status" });
    } else if (g.git_diff) {
      out.push({ type: "git_diff", path: g.gd_path || undefined });
    } else if (g.git_log) {
      out.push({ type: "git_log", count: g.gl_count ? parseInt(g.gl_count, 10) : undefined });
    } else if (g.app_name) {
      out.push({ type: "open_app", name: g.app_name, args: g.app_args || "" });
    } else if (g.web_query) {
      out.push({ type: "web_search", query: g.web_query });
    } else if (g.deep_query) {
      out.push({ type: "deep_research", query: g.deep_query });
    } else if (g.web_read_url) {
      out.push({ type: "read_webpage", url: g.web_read_url });
    } else if (g.open_url) {
      out.push({ type: "open_url", url: g.open_url });
    } else if (g.rfs_glob) {
      out.push({ type: "read_files", glob: g.rfs_glob, paths: [] });
    } else if (g.rfs_body !== undefined) {
      const paths = g.rfs_body.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      out.push({ type: "read_files", glob: "", paths });
    }
    lastIndex = EXTENDED_TOOLS_RE.lastIndex;
  }
  const after = text.slice(lastIndex);
  if (lastIndex === 0) {
    // No extended tool matched — return the original text untouched so the
    // existing parser behavior (and tests) are preserved byte-for-byte.
    return [{ type: "text", content: text }];
  }
  if (after.trim()) out.push({ type: "text", content: after });
  return out;
}

export function renderMarkdown(text) {
  if (!text) return "";
  
  // Escape html characters to prevent script injection
  let escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Keep track of code block replacements
  const codeBlocks = [];
  escaped = escaped.replace(/```(?:[a-zA-Z0-9]+)?\n([\s\S]*?)```/g, (_, code) => {
    const placeholder = `__CODE_BLOCK_PLACEHOLDER_${codeBlocks.length}__`;
    codeBlocks.push(code);
    return placeholder;
  });

  // Pre-extract markdown tables. Pattern: header row, separator row, body rows.
  // Each row is "| cell | cell | ... |". Separator cells contain only -, :, and spaces.
  const tables = [];
  escaped = escaped.replace(
    /(^|\n)(\|[^\n]+\|)\n(\|[\s:|-]+\|)\n((?:\|[^\n]+\|(?:\n|$))+)/g,
    (_, lead, headerLine, separatorLine, bodyText) => {
      const splitRow = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const headers = splitRow(headerLine);

      // Parse alignment from separator. Each cell is one of: ---, :---, ---:, :---:
      const aligns = splitRow(separatorLine).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        return "left";
      });

      const rows = bodyText.trim().split("\n").map(splitRow);

      const align = (i) => aligns[i] && aligns[i] !== "left" ? ` style="text-align:${aligns[i]}"` : "";

      let html = `<table class="md-table"><thead><tr>`;
      headers.forEach((h, i) => { html += `<th${align(i)}>${h}</th>`; });
      html += `</tr></thead><tbody>`;
      for (const cells of rows) {
        html += `<tr>`;
        cells.forEach((c, i) => { html += `<td${align(i)}>${c}</td>`; });
        html += `</tr>`;
      }
      html += `</tbody></table>`;

      const placeholder = `__TABLE_PLACEHOLDER_${tables.length}__`;
      tables.push(html);
      return `${lead}${placeholder}`;
    }
  );

  const lines = escaped.split("\n");
  const result = [];
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      if (inList) {
        result.push("</ul>");
        inList = false;
      }
      result.push("");
      continue;
    }

    if (trimmed.startsWith("__CODE_BLOCK_PLACEHOLDER_") || trimmed.startsWith("__TABLE_PLACEHOLDER_")) {
      if (inList) {
        result.push("</ul>");
        inList = false;
      }
      result.push(trimmed);
      continue;
    }

    // Process inline formatting (bold, inline code)
    const processed = line
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    const trimmedProcessed = processed.trim();

    if (trimmedProcessed.startsWith("### ")) {
      if (inList) {
        result.push("</ul>");
        inList = false;
      }
      result.push(`<h3>${trimmedProcessed.substring(4)}</h3>`);
    } else if (trimmedProcessed.startsWith("## ")) {
      if (inList) {
        result.push("</ul>");
        inList = false;
      }
      result.push(`<h2>${trimmedProcessed.substring(3)}</h2>`);
    } else if (trimmedProcessed.startsWith("# ")) {
      if (inList) {
        result.push("</ul>");
        inList = false;
      }
      result.push(`<h1>${trimmedProcessed.substring(2)}</h1>`);
    } else if (trimmedProcessed.startsWith("* ") || trimmedProcessed.startsWith("- ")) {
      if (!inList) {
        result.push("<ul>");
        inList = true;
      }
      result.push(`<li>${trimmedProcessed.substring(2)}</li>`);
    } else {
      if (inList) {
        result.push("</ul>");
        inList = false;
      }
      result.push(processed);
    }
  }

  if (inList) {
    result.push("</ul>");
  }

  let html = result.join("\n");

  // Clean up formatting newlines and apply <br>
  html = html
    .replace(/<\/h([1-6])>\n/g, "</h$1>")
    .replace(/<\/li>\n/g, "</li>")
    .replace(/<\/ul>\n/g, "</ul>")
    .replace(/<ul>\n/g, "<ul>")
    .replace(/\n/g, "<br>");

  // Restore code blocks preserving newlines
  codeBlocks.forEach((code, index) => {
    const placeholder = `__CODE_BLOCK_PLACEHOLDER_${index}__`;
    const blockHtml = `<pre><code>${code}</code><button class="code-copy-btn" onclick="navigator.clipboard.writeText(this.previousSibling.textContent)">Copy</button></pre>`;
    html = html.replace(placeholder, blockHtml);
  });

  // Restore tables
  tables.forEach((tableHtml, index) => {
    const placeholder = `__TABLE_PLACEHOLDER_${index}__`;
    // Strip the <br> that may have been added after the placeholder.
    html = html.replace(new RegExp(`${placeholder}(?:<br>)?`, "g"), tableHtml);
  });

  return html;
}

export function computeLineDiff(oldText, newText) {
  const oldLines = oldText ? oldText.split(/\r?\n/) : [];
  const newLines = newText ? newText.split(/\r?\n/) : [];

  if (oldLines.length > 500 || newLines.length > 500) {
    return {
      additions: newLines.length,
      deletions: oldLines.length,
      diff: [
        ...oldLines.map(l => ({ type: "deleted", text: l })),
        ...newLines.map(l => ({ type: "added", text: l }))
      ]
    };
  }

  const dp = Array(oldLines.length + 1).fill(null).map(() => Array(newLines.length + 1).fill(0));
  for (let i = 1; i <= oldLines.length; i++) {
    for (let j = 1; j <= newLines.length; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  let i = oldLines.length;
  let j = newLines.length;
  const diff = [];
  let additions = 0;
  let deletions = 0;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diff.unshift({ type: "common", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: "added", text: newLines[j - 1] });
      additions++;
      j--;
    } else {
      diff.unshift({ type: "deleted", text: oldLines[i - 1] });
      deletions++;
      i--;
    }
  }

  return { additions, deletions, diff };
}

export function applySearchReplacePatches(originalContent, patchContent) {
  const blocks = [];
  const regex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
  let match;
  while ((match = regex.exec(patchContent)) !== null) {
    blocks.push({
      search: match[1],
      replace: match[2]
    });
  }

  if (blocks.length === 0) {
    throw new Error("No valid <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks found in patch.");
  }

  let result = originalContent;
  for (const block of blocks) {
    // Try exact match first
    let index = result.indexOf(block.search);
    if (index === -1) {
      // Try matching ignoring line ending differences (CRLF vs LF)
      const normalizedResult = result.replace(/\r\n/g, "\n");
      const normalizedSearch = block.search.replace(/\r\n/g, "\n");
      const normIndex = normalizedResult.indexOf(normalizedSearch);
      if (normIndex !== -1) {
        // Reconstruct by splitting and splicing
        const before = normalizedResult.slice(0, normIndex);
        const after = normalizedResult.slice(normIndex + normalizedSearch.length);
        result = before + block.replace.replace(/\r\n/g, "\n") + after;
        continue;
      }

      // If still not found, throw descriptive error
      throw new Error(`Could not find search block in the file:\n<<<<<<< SEARCH\n${block.search}\n=======`);
    }

    result = result.slice(0, index) + block.replace + result.slice(index + block.search.length);
  }
  return result;
}

export function parseQuestions(content) {
  const lines = content.split("\n");
  const questions = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Strip leading '- ' or '* '
    const match = trimmed.match(/^[-*]\s+(.*)$/);
    if (!match) continue;
    const qText = match[1].trim();
    
    // Check for choices in brackets like [A, B, C]
    const optMatch = qText.match(/(.*)\[(.*?)\]\s*$/);
    if (optMatch) {
      const text = optMatch[1].trim();
      const options = optMatch[2].split(",").map(o => o.trim());
      questions.push({ text, options, type: "select" });
    } else {
      questions.push({ text: qText, type: "text" });
    }
  }
  return questions;
}
