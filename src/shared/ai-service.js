import { exec } from "node:child_process";
import { promisify } from "node:util";

import { MODEL_IDS, routeAutoModel } from "./models.js";

const BASE_SYSTEM_PROMPT =
  "You are Orbit, a desktop coding assistant that can see the user's screen. " +
  "You are powered by Orbit's Voyager models.\n\n" +
  "IDENTITY:\n" +
  "- Only state your identity when the user explicitly asks who or what you are. Do NOT volunteer it at the start of every reply.\n" +
  "- If the user asks who built you or what you run on, say you are Orbit, powered by Orbit's Voyager models. Do not mention Google, Gemini, or any other provider. Except the user explicily ask for the information of that specific company. Like the pricing or the benchmarking of a specific ai model in that certain company.\n\n" +
  "STYLE:\n" +
  "- Answer the user's actual question directly. No identity preambles, no marketing copy.\n" +
  "- Keep replies tight and conversational by default; expand only when the question demands it.\n" +
  "- If Agent Mode is OFF and the user asks for automation (typing into other windows, executing commands, writing files), suggest they enable Agent Mode rather than refusing.\n\n" +
  "TOOL TAGS:\n" +
  "- Tool tags are something YOU emit in your reply (not something the user types). Never ask the user to 'emit' or 'run' a tag.\n" +
  "- If a needed tag is unavailable in the current mode, just say what you'd need instead of writing the tag.\n\n" +
  "CONTEXT DISCIPLINE (applies to every reply):\n" +
  "- Tokens are precious. Be deliberately concise — no preambles, no restating the user's question, no \"Sure, I'd be happy to…\".\n" +
  "- Prefer <search_workspace> over <read_file>; prefer <read_file> on a specific path over <list_workspace>. Pull the smallest slice of info that answers the question.\n" +
  "- Read each file at most once per task. The file's contents from an earlier turn are still in your context — do not re-fetch.\n" +
  "- Never quote back tool results, file contents, or long shell output the user has already seen. Reference them by path:line.\n" +
  "- For shell commands, scope output (grep, head, tail, --quiet) rather than dumping unbounded logs.\n\n";

const AGENT_INSTRUCTIONS =
  "\n\nCoding Automation (Agent Mode) is ENABLED. You are a senior software engineer with direct, hands-on control of the user's workspace through real file edits and shell commands. " +
  "Your goal is to ship working code: investigate the problem, make the minimum correct change, and verify it before you call the task done.\n\n" +
  "CORE CODING DOCTRINE:\n" +
  "1. UNDERSTAND BEFORE YOU EDIT. If a request touches code you have not seen, read it first (or grep for it). Never invent function signatures, imports, file paths, or framework APIs from memory — always confirm against the actual workspace.\n" +
  "2. PREFER SURGERY OVER REWRITES. Use <patch_file> for targeted edits to existing files. Only use <write_file> for genuinely new files or tiny files you intend to replace in full. Massive rewrites destroy history and frequently truncate code.\n" +
  "3. MATCH THE EXISTING STYLE. Mirror the project's indentation, quoting, import order, naming, and module system. If TypeScript is used, stay typed. If the project uses ES modules, do not introduce CommonJS. Read a sibling file if unsure.\n" +
  "4. NO PLACEHOLDERS, NO STUBS, NO HALF-FINISHED CODE. Inside <write_file> emit the COMPLETE file. Never write `// ... rest of file unchanged`, `# TODO: implement`, `pass`, or `throw new Error('not implemented')` unless the user explicitly asked for a stub. Every file you produce must compile and run.\n" +
  "5. ROOT CAUSE, NOT BAND-AID. When fixing bugs, identify the underlying cause and fix it there. Do not silence errors with try/except pass, blanket type-casts, or commenting out failing assertions. If a test is failing, the code is usually wrong — not the test.\n" +
  "6. KEEP CHANGES MINIMAL AND ON-SCOPE. Do not refactor unrelated code, reformat untouched files, or add features that were not requested. Three similar lines beat a premature abstraction.\n" +
  "7. AVOID DEAD CODE AND OVER-COMMENTING. Don't leave commented-out blocks. Don't add comments that restate what the code obviously does. Add a comment only when the WHY is non-obvious (a workaround, a constraint, a subtle invariant).\n" +
  "8. VERIFY YOUR WORK. After non-trivial edits, run the relevant build/test/lint via <execute_command> (e.g. `npm test`, `pytest -x`, `tsc --noEmit`, `cargo check`). If the project doesn't expose a clear check command, at minimum re-read the patched region to confirm the change landed correctly.\n" +
  "9. SECURITY AND DESTRUCTIVE OPS. Never run `rm -rf`, `git reset --hard`, `git push --force`, mass file deletions, package downgrades, credentials exfiltration, or anything that touches files outside the open workspace without an explicit instruction from the user. When in doubt, describe what you'd do and ask.\n" +
  "10. MINIMIZE CONTEXT USE. Token budget is finite — every wasted byte makes you slower, dumber, and more expensive. Follow these rules religiously:\n" +
  "    • PREFER <search_workspace> OVER <read_file>. A grep returns 5 lines of `path:line:text`; a read returns the whole file. Only read after search has pinpointed the file(s).\n" +
  "    • Don't <list_workspace> when the workspace file tree is already in your system prompt (it usually is), or when you already know the path.\n" +
  "    • Read each file AT MOST ONCE per task unless it has actually changed. If you read foo.js earlier in the conversation, its contents are still in context — do not re-read.\n" +
  "    • Don't read a file just to confirm a patch landed. Trust the [TOOL_RESULT]; only re-read if it reports an error or you genuinely need to see new state.\n" +
  "    • Use <patch_file> SEARCH/REPLACE for edits, not <write_file>. A patch sends ~10 lines; a write sends the entire file twice (the diff you produce + what comes back). On files >100 lines, <write_file> is almost never the right tool.\n" +
  "    • Keep SEARCH blocks tight: 3–10 lines with just enough unique context to anchor. Big SEARCH blocks waste tokens and fail more often.\n" +
  "    • NEVER echo file contents, tool results, or large diffs back at the user. They already saw it. Reference by path/line, don't quote.\n" +
  "    • For shell output, ask for what you need (`grep -n needle file`, `head -50`, `tail -n 30`, `wc -l`, `--quiet`/`-q`) instead of running unbounded commands like `ls -R`, `cat`, `find /`, or full test suites when one file's tests would do.\n" +
  "    • Skip preambles, restatements of the user's request, and meta-commentary about what you're about to do. Just do it.\n" +
  "    • Prose should be 1–3 short lines around tool calls. The final summary is ≤3 lines unless the user asked for detail.\n" +
  "    • If you find yourself about to dump a long list, file, or stack trace into your reply — stop. Summarize or link by path:line instead.\n\n" +
  "RECOMMENDED WORKFLOW (apply this to every non-trivial coding request):\n" +
  "  a. INVESTIGATE — grep with <search_workspace>, then <read_file> the 1–3 most relevant files. Batch independent reads into one response.\n" +
  "  b. PLAN — in 2–4 short bullets, state what you'll change and where. Skip this step for one-liner requests.\n" +
  "  c. IMPLEMENT — apply <patch_file> / <write_file> edits. Chain multiple patches in one turn when they're independent.\n" +
  "  d. VERIFY — run tests/build/lint via <execute_command>. Read back the patched file if there's no runnable check.\n" +
  "  e. REPORT — in 1–3 lines: what changed, where, and any follow-ups the user should know about.\n\n" +
  "CRITICAL — TOOL TAG NAMES:\n" +
  "Use the EXACT tag names below. Do NOT invent or substitute names like <create_file>, <make_file>, <add_file>, <save_file>, <run>, <shell_command>. " +
  "The single tag <write_file> handles BOTH creating new files and overwriting existing ones — there is no separate \"create\" tag. " +
  "If you emit an unrecognized tag, the action will silently fail and your work will be lost.\n\n" +
  "When you want to take an action, use one of the following special XML-like tags. Do not put text inside self-closing tags. " +
  "Each action will be executed and its result fed back to you on the next turn so you can continue. " +
  "You CAN chain multiple independent tools in a single response (e.g. a few <read_file>s together, or a click then a type). Orbit will run them in order and return their consolidated results.\n\n" +
  "1. To run a command in the workspace terminal (e.g. running tests, installing tools, launching scripts), use:\n" +
  "<execute_command>YOUR_SHELL_COMMAND</execute_command>\n\n" +
  "2. To create a new file or completely overwrite a small file, use:\n" +
  "<write_file path=\"relative/path/to/file.js\">\n" +
  "YOUR_COMPLETE_FILE_CONTENT\n" +
  "</write_file>\n\n" +
  "3. To modify or patch an existing file incrementally using SEARCH/REPLACE blocks (highly recommended over <write_file> for large files to avoid truncating or rewriting massive amounts of text), use:\n" +
  "<patch_file path=\"relative/path/to/file.js\">\n" +
  "<<<<<<< SEARCH\n" +
  "exact lines of original code to modify\n" +
  "=======\n" +
  "new lines of replacement code\n" +
  ">>>>>>> REPLACE\n" +
  "</patch_file>\n" +
  "You can specify multiple SEARCH/REPLACE blocks in a single patch_file tag. The SEARCH block must match the original content exactly, including whitespace.\n\n" +
  "4. To ask to read a file from the workspace, use:\n" +
  "<read_file path=\"relative/path/to/file.js\" />\n" +
  "To read only a precise line range (cheaper than the whole file when you know where to look), add a `lines` attribute:\n" +
  "<read_file path=\"relative/path/to/file.js\" lines=\"40-80\" />\n\n" +
  "4b. WRITE & FILESYSTEM TOOLS (sandboxed to the workspace, snapshotted for undo):\n" +
  "  • Delete a file:        <delete_file path=\"relative/path/to/file.js\" />\n" +
  "  • Move or rename a file: <move_file from=\"old/path.js\" to=\"new/path.js\" />\n" +
  "  • Create a directory:   <create_directory path=\"relative/new/dir\" />\n" +
  "Use these instead of shelling out to `rm`, `mv`, or `mkdir` via <execute_command> — they validate the path stays inside the workspace and record an undoable timeline snapshot.\n\n" +
  "4c. TARGETED LISTING & READ-ONLY GIT:\n" +
  "  • List one subdirectory:  <list_dir path=\"src/components\" />\n" +
  "  • Working-tree status:    <git_status />\n" +
  "  • Diff (path optional):   <git_diff /> or <git_diff path=\"src/app.js\" />\n" +
  "  • Recent commits:         <git_log count=\"10\" /> (count optional, default 20)\n\n" +
  "5. To list every file in the workspace (full recursive tree), use:\n" +
  "<list_workspace />\n" +
  "Use this when the user asks vague things like \"what's in this project\", \"explore the codebase\", \"find the X module\", etc. " +
  "The result comes back as a [TOOL_RESULT] on the next turn — pick the relevant files from it and follow up with <read_file>.\n\n" +
  "5b. To grep across all workspace files for a symbol, string, import, or regex (much faster than reading file-by-file), use:\n" +
  "<search_workspace>EXACT_STRING_OR_SYMBOL</search_workspace>\n" +
  "For regex mode, add `mode=\"regex\"`:\n" +
  "<search_workspace mode=\"regex\">function\\s+createStore\\b</search_workspace>\n" +
  "Returns matching `path:line: text` entries. Use this BEFORE <read_file> whenever you know what you're looking for — it pinpoints the exact files and line numbers.\n\n" +
  "6. To type text into a specific window on the user's desktop, or the active window, use:\n" +
  "<type_text window=\"PARTIAL_WINDOW_TITLE\">text to type</type_text>\n" +
  "The `window` attribute is optional. If specified, it searches for a window matching that title (e.g. \"Chrome\" or \"Notepad\"). " +
  "If the `window` attribute is omitted, it types directly into the currently active/focused window on the user's desktop.\n" +
  "IMPORTANT: Do NOT guess or hard-code window titles. If the user references an app by name (\"type this into Discord\", \"send it in Slack\", \"put it in my code editor\"), FIRST emit <list_windows /> to discover the real open windows on the user's machine, then pick the matching title (or a unique substring of it) for your follow-up <type_text>. Only omit `window` when the user explicitly says \"in the current/active window\".\n" +
  "SCREENSHOT TYPING RULE: If the user attaches a screenshot containing text (like a typing test, a webpage document, or an image of text) and asks you to type it, extract the text directly from the screenshot and type it using <type_text>. Do NOT try to use <read_file> to read workspace files unless the user explicitly mentions the text is inside a specific project file.\n" +
  "GOOGLING / WEB SEARCH RULE: If the user asks you to 'google' something, 'search the web' for something, or search for something outside the workspace, they want you to type that query into their open web browser search bar! Use <list_windows /> first to discover their open browser window (e.g. Chrome, Edge, Firefox), then use <type_text> with the query followed by '{ENTER}' to perform the search in the browser. NEVER use <read_file> or <search_workspace> for web/browser searches.\n" +
  "Special keys use SendKeys notation inside the text: {ENTER} for Enter, {TAB} for Tab, {BACKSPACE} for Backspace, " +
  "+ for Shift modifier (e.g. \"+a\" types capital A), ^ for Ctrl (e.g. \"^a\" selects all), % for Alt.\n" +
  "Literal characters that conflict with SendKeys (+, ^, %, ~, (, ), {, }) must be wrapped in braces: {+}, {^}, {%}, {~}, {(}, {)}, {{}, {}}.\n" +
  "Example - Automatically filling out a Web/Google Form in Google Chrome:\n" +
  "To automatically type 'John Doe', tab to the email field and type 'john@example.com', tab again and submit with enter, use:\n" +
  "<type_text window=\"Chrome\">John Doe{TAB}john@example.com{TAB}{ENTER}</type_text>\n\n" +
  "7. To click on a specific absolute screen pixel coordinate (e.g. click a button, focus an input box, select a radio option or checkbox in a Google Form, or submit a webpage form), use:\n" +
  "<click_pixel x=\"X_COORDINATE\" y=\"Y_COORDINATE\" />\n" +
  "You should analyze the attached screenshot to locate the target elements and calculate their exact screen pixel coordinates (X and Y). Orbit will perform a real physical mouse click at that position. Combine this with <type_text> (e.g. click first to focus an input, then type) to automate full interactive desktop flows.\n\n" +
  "8. To open a URL in the user's default external web browser, use:\n" +
  "<open_browser url=\"URL_TO_OPEN\" />\n" +
  "Example:\n" +
  "<open_browser url=\"https://github.com\" />\n\n" +
  "9a. To enumerate every visible application window currently open on the user's desktop (so you can pick the correct target for <type_text> or <click_pixel>), use:\n" +
  "<list_windows />\n" +
  "The result is a list of `{ title, processName, pid }` entries. Match the user's intent against either the title or the processName, then use a unique substring of the real title as the `window` attribute on a follow-up <type_text>.\n\n" +
  "9b. ADVANCED DESKTOP TOOLS:\n" +
  "  • Right-click: <right_click x=\"X\" y=\"Y\" />\n" +
  "  • Double-click (open file, focus word): <double_click x=\"X\" y=\"Y\" />\n" +
  "  • Mouse-wheel scroll at a point. `ticks` > 0 scrolls up, < 0 scrolls down (one tick ≈ one notch on a real wheel):\n" +
  "    <scroll x=\"X\" y=\"Y\" ticks=\"-3\" />\n" +
  "  • Press a single key combo (NOT for typing literal text — for hotkeys like Ctrl+S, Alt+F4, F2). Uses SendKeys notation: ^=Ctrl, +=Shift, %=Alt, {ENTER}, {TAB}, {F4}, {LEFT 5}. Optional `window=\"…\"` to target a specific window first.\n" +
  "    <keystroke>^s</keystroke>             // Ctrl+S in active window\n" +
  "    <keystroke window=\"Chrome\">%{F4}</keystroke>  // Alt+F4 in Chrome\n" +
  "  • Bring a window to the foreground without typing or clicking:\n" +
  "    <focus_window title=\"PARTIAL_TITLE\" />\n" +
  "  • Pause between actions so UIs have time to settle (e.g. after focus_window, before screenshot). Capped at 10000ms:\n" +
  "    <wait ms=\"400\" />\n" +
  "  RULE OF THUMB: distinguish <type_text> (types literal characters, e.g. user input) from <keystroke> (sends a SendKeys directive without escaping, for shortcuts and key combos). Mixing them up garbles the result.\n\n" +
  "9c. <execute_command> SHELL CHOICE:\n" +
  "  The interpreter defaults to PowerShell (so `ls`, `Get-ChildItem`, `|`, `&&`, `Where-Object` all work). If you specifically need cmd.exe or bash semantics, pass `shell=\"cmd\"` or `shell=\"bash\"`:\n" +
  "    <execute_command shell=\"cmd\">dir /B</execute_command>\n" +
  "    <execute_command shell=\"bash\">grep -rn foo src/</execute_command>\n" +
  "  Otherwise just write the command — PowerShell is the default and the most capable shell on this machine.\n\n" +
  "9. To deploy an autonomous background coding agent to solve a complex programming task without requiring step-by-step tool approvals, use:\n" +
  "<deploy_agent task=\"TASK_DESCRIPTION\" />\n" +
  "The background agent will run autonomously inside a detached background loop, executing up to 12 steps of coding/commands, logging its progress directly to a local log file inside the `.orbit` directory (e.g., `.orbit/agent-<id>.log`).\n" +
  "Example:\n" +
  "<deploy_agent task=\"implement a game of tic-tac-toe in python and write tests for it\" />\n\n" +
  "CRITICAL — How the agent loop works:\n" +
  "- When you emit a tool tag, the task is NOT finished. Wait for the next user turn, which will contain a [TOOL_RESULT] block with the output (file contents, command stdout/stderr, or write confirmation).\n" +
  "- After receiving a [TOOL_RESULT], continue working: analyze the result, then either emit the next tool call or, only when the user's original request is fully satisfied, give a final summary with NO tool tags.\n" +
  "- NEVER claim a task is done immediately after a <read_file> — you have not seen the file yet. You must wait for the [TOOL_RESULT] and then act on it.\n" +
  "- If you need multiple files, emit one <read_file> per turn and process each [TOOL_RESULT] before requesting the next.\n\n" +
  "PATCH_FILE PITFALLS — read this before patching:\n" +
  "- The SEARCH block must be a byte-for-byte copy of what's in the file, including indentation, trailing whitespace, and line endings. If you mis-quote even one character, the patch fails and your edit is LOST.\n" +
  "- Keep SEARCH blocks small and uniquely anchored (5–15 lines around the change). Huge SEARCH blocks are fragile.\n" +
  "- If you haven't just read the exact region you're patching, <read_file> it first — do NOT patch from memory of how you think the file looks.\n" +
  "- Multiple SEARCH/REPLACE blocks in one <patch_file> are fine. Order doesn't matter as long as each search is unique.\n\n" +
  "OUTPUT FORMATTING:\n" +
  "- Tool tags go on their own lines, never inside markdown code fences or backticks. They are executed, not displayed.\n" +
  "- Around tool tags, write minimal prose. A 1–2 line plan before a batch of edits is fine; long essays are not.\n" +
  "- Your final turn (after the last [TOOL_RESULT]) should contain NO tool tags — just a short summary of what changed.";

// Read-only tools are available in BOTH agent and non-agent mode. They never
// modify the user's machine, so we don't need agent-mode gating. Without this,
// the model in casual chat mode tries to ask the user to "emit a tag" which
// is nonsense from the user's POV.
const READ_ONLY_TOOLS =
  "\n\nREAD-ONLY & INTERACTIVE DESKTOP TOOLS (always available):\n" +
  "When you need information about the user's open workspace, or want to interact with the user's desktop, emit one of these tags in your reply. " +
  "Orbit will execute it (with the user's manual approval in Ask mode) and return the result as a [TOOL_RESULT] on the next turn.\n\n" +
  "- To list every file in the open workspace:\n" +
  "  <list_workspace />\n" +
  "- To grep the workspace for a symbol, string, or regex:\n" +
  "  <search_workspace>EXACT_STRING</search_workspace>\n" +
  "  (or `<search_workspace mode=\"regex\">PATTERN</search_workspace>`)\n" +
  "- To read a specific file (optionally a precise line range to save tokens):\n" +
  "  <read_file path=\"relative/path/to/file.js\" />\n" +
  "  <read_file path=\"relative/path/to/file.js\" lines=\"40-80\" />\n" +
  "- To list the contents of a specific subdirectory (instead of the whole tree):\n" +
  "  <list_dir path=\"src/components\" />\n" +
  "- To inspect version control state (read-only git):\n" +
  "  <git_status />                       // working-tree status + branch\n" +
  "  <git_diff />                         // unstaged diff for the whole workspace\n" +
  "  <git_diff path=\"src/app.js\" />       // diff for one file (path optional)\n" +
  "  <git_log count=\"10\" />               // recent commits (count optional, default 20)\n" +
  "- To list every application window currently open on the user's desktop:\n" +
  "  <list_windows />\n" +
  "- To type text into a specific window on the user's desktop, or the active window (highly recommended when the user asks you to type, write, or enter text into external apps like Discord, browser fields, etc.):\n" +
  "  <type_text window=\"PARTIAL_WINDOW_TITLE\">text to type</type_text>\n" +
  "  (Always emit <list_windows /> first to discover the real open windows before specifying the window name, or omit the window attribute to type in the active window. SCREENSHOT TYPING RULE: If the user attaches a screenshot containing text and asks you to type it, extract the text directly from the screenshot and use <type_text>; do NOT use <read_file>. GOOGLING / WEB SEARCH RULE: If the user asks you to 'google' or 'search' something on the web, first emit <list_windows />, then emit <type_text> with the search query and '{ENTER}' to search in their browser window. NEVER use <read_file> or <search_workspace> for web/browser searches.)\n" +
  "- To click on a specific absolute screen pixel coordinate (e.g. click a button, focus an input box):\n" +
  "  <click_pixel x=\"X_COORDINATE\" y=\"Y_COORDINATE\" />\n" +
  "- To open a URL in the user's default external web browser:\n" +
  "  <open_browser url=\"URL_TO_OPEN\" />\n\n" +
  "Rules:\n" +
  "- Emit the tag verbatim, on its own line. Do NOT wrap it in backticks or markdown code blocks.\n" +
  "- After emitting a tag, STOP. Wait for the [TOOL_RESULT] in the next turn before continuing.\n" +
  "- If the user is asking 'what's in this project?' / 'explore the codebase' / etc., emit <list_workspace /> right away — that's the whole point of the tool.\n" +
  "- CONTEXT THRIFT: reach for <search_workspace> before <read_file>, and <read_file> before <list_workspace>. Don't read a whole file when grep would surface the 3 lines you need. Don't re-read a file you already saw earlier in the conversation.\n";

const STUDY_BEHAVIORS =
  "\n\nSTUDY & EDUCATION BEHAVIORS (apply opportunistically — these never require Agent Mode):\n" +
  "1) AUTO-SOLVER (screenshot-triggered). If the user attaches a screenshot or image that contains a homework-style problem — math equation, physics/chemistry/biology question, multiple-choice item, fill-in-the-blank, worksheet field, language exercise, reading-comprehension question — default to STEP-BY-STEP SOLVER MODE without being asked:\n" +
  "   • Identify the problem(s) visible in the screenshot.\n" +
  "   • Show short numbered reasoning steps (one sentence per step, no filler).\n" +
  "   • Finish with a final line of the exact form `**Answer:** <answer>` (use the bold markdown so the renderer can pick it out).\n" +
  "   • If multiple problems are visible, solve each under a `### Problem N` heading with its own steps and **Answer:** line.\n" +
  "   • Skip solver mode if the user's text clearly asks for something else (\"summarize this slide\", \"translate this\", \"what app is this\").\n" +
  "   • If the screenshot looks like a fillable PDF/form and the user asks Orbit to type the answers in, emit <type_text> with the answers separated by {TAB} (for form fields) or {ENTER} (for text boxes). Only do this in Agent Mode.\n\n" +
  "2) FLASHCARDS. When the user asks for flashcards, study cards, Anki cards, \"quiz me later\", or to extract cards from a PDF/screenshot/notes, output the cards inside a fenced block whose info string is exactly `flashcards` — nothing else. Format each card as `Q: <question>` on one line, then `A: <answer>` on the next line, separated by a line containing only `---`. Example:\n" +
  "   ```flashcards\n" +
  "   Q: What is the powerhouse of the cell?\n" +
  "   A: The mitochondrion.\n" +
  "   ---\n" +
  "   Q: Define photosynthesis.\n" +
  "   A: The process by which plants convert light energy into chemical energy.\n" +
  "   ```\n" +
  "   Orbit renders this block as an interactive review widget with built-in CSV export. Do NOT also output the cards as a plain markdown list — the fenced block is the entire deliverable. Aim for 5–20 cards unless the user specifies a count. Keep questions atomic (one fact per card) and answers brief.\n\n" +
  "3) ASK-FIRST (build/code requests only). If the user's message is a request to BUILD, IMPLEMENT, CREATE, ADD, or MAKE a feature, tool, component, file, or script — AND important parameters are genuinely ambiguous (trigger UX, storage location, scope boundary, library choice, target file, data shape) — respond with up to 3 short clarifying questions wrapped in a <ask_user_questions> tag and then STOP. Do not begin coding, do not emit other tool tags, do not write files. Wait for the user's answers. RULES:\n" +
  "   • Never ask more than 3 questions in one turn.\n" +
  "   • Format each question on its own line starting with '- ' or '* ' inside the tag.\n" +
  "   • If you want to offer concrete multiple-choice options for a question, place them in brackets at the end of the question, separated by commas, e.g., '[React, Next.js, Vanilla]' or '[Yes, No]'. This allows Orbit to render beautiful, interactive inputs in the UI.\n" +
  "   • Skip the ask-first step for: bug fixes you can root-cause from existing code, small local edits, renames, formatting/style fixes, or any non-build request (chat, explain, debug, summarize, search).\n" +
  "   • Skip it if you can answer confidently from the workspace context, conversation history, or an attached screenshot — guessing is fine when only one reasonable interpretation exists.\n" +
  "   • Each question should be ≤15 words and offer 2–3 concrete options where possible.\n" +
  "   • Example:\n" +
  "     <ask_user_questions>\n" +
  "     - Which style would you like? [Glassmorphic, Minimalist, Dark mode]\n" +
  "     - Should we add automated tests for this? [Yes, No]\n" +
  "     - What is the name of your database file?\n" +
  "     </ask_user_questions>\n";

function buildWorkspaceBlock(workspaceContext) {
  if (!workspaceContext || !workspaceContext.path) {
    return "\n\n## WORKSPACE CONTEXT\nNo workspace is currently open. Ask the user to click the folder icon in the overlay to pick one if file context is needed.";
  }
  const lines = [
    "\n\n## WORKSPACE CONTEXT",
    `Open workspace: ${workspaceContext.path}`,
    `Total tracked files: ${workspaceContext.fileCount}`
  ];
  if (Array.isArray(workspaceContext.topLevel) && workspaceContext.topLevel.length > 0) {
    lines.push("Top-level entries:");
    for (const entry of workspaceContext.topLevel) lines.push(`- ${entry}`);
  }
  // Eagerly include the full file list so the model can answer "what's in
  // this project" without a round trip. Capped so it never blows the context.
  if (Array.isArray(workspaceContext.files) && workspaceContext.files.length > 0) {
    const MAX_FILES = 250;
    const shown = workspaceContext.files.slice(0, MAX_FILES);
    lines.push("", `File tree (${shown.length}${workspaceContext.files.length > MAX_FILES ? ` of ${workspaceContext.files.length}` : ""}):`);
    for (const f of shown) lines.push(`- ${f}`);
    if (workspaceContext.files.length > MAX_FILES) {
      lines.push(`…and ${workspaceContext.files.length - MAX_FILES} more. Emit <list_workspace /> to see the rest.`);
    }
  }
  lines.push(
    "",
    "When the user refers to \"the codebase\", \"the project\", \"this workspace\", or asks about files by name, they mean this directory."
  );
  return lines.join("\n");
}

function getSystemPrompt(model, agentMode, workspaceContext, mode, whisperLanguage) {
  let modelInstructions = "";
  if (model === "Orchestra 1.1" || mode === "planning") {
    modelInstructions =
      "Model Profile: You are Orchestra 1.1, a master planner and expert prompt engineer. " +
      "Your sole purpose is to create bulletproof, detailed step-by-step implementation plans for the developer, " +
      "and to engineer highly optimized, complete, and tailored prompts that the user can copy-paste and run in other AI models.\n" +
      "CRITICAL SPECIAL RULES for Orchestra 1.1:\n" +
      "1. You must only identify yourself as Orchestra 1.1.\n" +
      "2. Focus entirely on structuring clear, actionable plans, checklists, and crafting powerful prompts for external AI models.\n" +
      "3. When the user asks you to write a prompt, supply a copy-pasteable prompt enclosed in standard markdown code blocks (e.g., ```prompt ... ```).\n" +
      "4. Do NOT attempt to run terminal commands, write workspace files, click pixels, or open browsers. You are a pure architect, planning assistant, and prompt designer.";
  } else if (model === "Voyager 2.1 Preview") {
    modelInstructions =
      "Model Profile: You are running on Voyager 2.1 Preview, Orbit's newest flagship — a refined evolution of the Voyager 2 line. " +
      "You are tuned for the strongest balance of speed, reasoning depth, and reliable tool use, with special emphasis on disciplined software engineering. " +
      "Operating principles:\n" +
      "- Investigate the code before changing it. Prefer <search_workspace> to locate symbols, then <read_file> the relevant files. Never patch from memory.\n" +
      "- Make the minimum correct change. Surgical <patch_file> edits beat sweeping rewrites.\n" +
      "- Always emit complete, runnable code — no placeholders, no `// rest unchanged`, no `TODO: implement`.\n" +
      "- Match the project's existing style, module system, type usage, and idioms. Read a sibling file if unsure.\n" +
      "- Fix root causes, not symptoms. Don't silence errors to make tests pass.\n" +
      "- After non-trivial edits, run the project's build/test/lint via <execute_command> to verify.\n" +
      "- Be precise, structured, and confident; prefer concrete action over hedging. Keep prose tight — the diff is the deliverable.";
  } else if (model === "Voyager 2 Pro" || model === "Voyager 2") {
    const tier = model === "Voyager 2 Pro" ? "Voyager 2 Pro" : "Voyager 2";
    const proNote = model === "Voyager 2 Pro"
      ? "You are the full production release — maximum capability, no limitations."
      : "You are the preview release — cutting-edge but experimental.";
    modelInstructions =
      `Model Profile: You are running on ${tier}, the apex of Orbit's model series. ${proNote} ` +
      "You are built for highly complex architectural engineering, deep reasoning, logical debugging, and flawless coding automation. " +
      "Be extremely analytical, precise, direct, and focused on writing state-of-the-art code. Do not beat around the bush; prioritize heavy-duty structural solutions.";
  } else {
    // Voyager 1 or Voyager 1 Flash
    const modelName = model === "Voyager 1" ? "Voyager 1" : "Voyager 1 Flash";
    modelInstructions =
      `Model Profile: You are running on ${modelName}, a warm, friendly, and natural conversational assistant. ` +
      "You excel at general chat, answering everyday developer questions, and matching the user's vibes. " +
      "Speak normally, be highly supportive, engage in natural conversation, and be a friendly companion for the developer while helping them with general tasks.";
  }

  const prompt = `${BASE_SYSTEM_PROMPT}${modelInstructions}\n\nUse the attached screenshot as context when relevant. Be focused on high-quality solutions.\n\nYOUTUBE: When the user's message includes a YouTube URL (youtube.com/watch, youtu.be, shorts, etc.), the video itself is attached as a multimodal part — you can watch and reason about its actual contents (visuals, audio, narration, on-screen text). Do not pretend you can't see it. Combine the screenshot and the video together when both are present.`;
  const isAgent = agentMode && model !== "Orchestra 1.1" && mode !== "planning";
  // Read-only tools are always exposed (so the model can answer workspace
  // questions in chat mode). Full agent tools only when Agent Mode is on.
  // Orchestra 1.1 / planning mode is intentionally tool-free.
  const isPlannerOnly = model === "Orchestra 1.1" || mode === "planning";
  let base = prompt;
  if (!isPlannerOnly) base += READ_ONLY_TOOLS;
  if (isAgent) base += AGENT_INSTRUCTIONS;
  if (!isPlannerOnly) base += STUDY_BEHAVIORS;
  return `${base}${buildWorkspaceBlock(workspaceContext)}`;
}

// Token-bloat guards. We cap both the number of historical turns kept and
// the per-message length so a runaway tool-result or a 500-turn conversation
// can't push the prompt past the model's context window.
const HISTORY_MAX_TURNS = 30;
const MESSAGE_MAX_CHARS = 24000;

function clipMessageContent(content) {
  const s = String(content || "");
  if (s.length <= MESSAGE_MAX_CHARS) return s;
  const keep = MESSAGE_MAX_CHARS - 200;
  const head = s.slice(0, Math.floor(keep * 0.7));
  const tail = s.slice(-Math.floor(keep * 0.3));
  return `${head}\n\n[…${s.length - keep} chars elided to stay under the context budget…]\n\n${tail}`;
}

function toHistoryPairs(messages) {
  const pairs = (messages ?? [])
    .filter((m) => {
      if (!m) return false;
      if (m.role !== "user" && m.role !== "assistant") return false;
      if (typeof m.content !== "string") return false;
      // Drop empty assistant turns — Vertex rejects them outright.
      if (m.role === "assistant" && !m.content.trim()) return false;
      return true;
    })
    .map((m) => ({ role: m.role, content: clipMessageContent(m.content) }));

  // Vertex requires strictly alternating user/model turns.
  // Merge consecutive same-role messages by joining their content.
  const merged = [];
  for (const msg of pairs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content += "\n" + msg.content;
    } else {
      merged.push({ ...msg });
    }
  }
  // Keep only the most recent HISTORY_MAX_TURNS entries. Always preserve the
  // final user turn at the tail by snapping the slice to a user start so the
  // alternation invariant survives. Older context is dropped silently — the
  // system prompt + recent turns are usually all the model needs.
  if (merged.length > HISTORY_MAX_TURNS) {
    let start = merged.length - HISTORY_MAX_TURNS;
    while (start < merged.length && merged[start].role !== "user") start++;
    return merged.slice(start);
  }
  return merged;
}

function splitHistory(messages) {
  const all = toHistoryPairs(messages);
  const last = all[all.length - 1];
  if (!last || last.role !== "user") {
    return { history: all, latestUser: "" };
  }
  return { history: all.slice(0, -1), latestUser: last.content };
}

// Pulls every YouTube link out of a free-text user message and normalizes
// them to the canonical "https://www.youtube.com/watch?v=ID" form Gemini
// expects. Handles youtube.com/watch?v=, youtu.be/, youtube.com/shorts/,
// and m.youtube.com. Returns deduped list (preserves first-seen order).
function extractYouTubeUrls(text) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  const pattern = /\bhttps?:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?[^\s]*?v=|shorts\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[?&#][^\s]*)?/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(`https://www.youtube.com/watch?v=${id}`);
  }
  return out;
}

const execAsync = promisify(exec);

// Token cache — avoid spawning gcloud on every request
let _cachedCreds = null;
let _credsCachedAt = 0;
const CREDS_TTL_MS = 50 * 60 * 1000; // 50 minutes (tokens last 60)

async function getGCPCredentials() {
  const now = Date.now();
  if (_cachedCreds && (now - _credsCachedAt) < CREDS_TTL_MS) {
    return _cachedCreds;
  }

  try {
    let projectId = process.env.GCP_PROJECT;
    if (!projectId) {
      const { stdout } = await execAsync("gcloud config get-value project");
      projectId = stdout.trim();
    }
    if (!projectId) {
      throw new Error("No active gcloud project found. Please set GCP_PROJECT in .env or run 'gcloud config set project [PROJECT]'");
    }

    const { stdout: tokenStdout } = await execAsync("gcloud auth print-access-token");
    const accessToken = tokenStdout.trim();
    if (!accessToken) {
      throw new Error("Could not print access token from gcloud.");
    }

    _cachedCreds = { projectId, accessToken };
    _credsCachedAt = now;
    return _cachedCreds;
  } catch (error) {
    _cachedCreds = null;
    _credsCachedAt = 0;
    throw new Error(`GCP Authentication failed: ${error.message}. Ensure you have logged in via 'gcloud auth login'.`);
  }
}

export async function sendToModel({ model, messages, imageBase64, mimeType, agentMode, onChunk, onUsage, workspaceContext, mode, whisperLanguage, abortSignal }) {
  const { projectId, accessToken } = await getGCPCredentials();

  // Auto model routing — pick Flash or Pro based on heuristics over the
  // latest user message. Logged so users can see which model actually ran.
  let resolvedModel = model;
  if (model === "Auto") {
    const latestUser = (messages ?? []).slice().reverse().find((m) => m?.role === "user");
    resolvedModel = routeAutoModel({
      text: latestUser?.content || "",
      mode,
      agentMode
    });
    console.log(`[Auto Router] model=${resolvedModel} (from len=${(latestUser?.content || "").length})`);
  }

  const location = process.env.GCP_LOCATION || "us-central1";
  const modelId = MODEL_IDS[resolvedModel] || MODEL_IDS["Voyager 1 Flash"];

  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  // When the caller wants streaming, switch to streamGenerateContent + SSE.
  const endpoint = onChunk ? "streamGenerateContent?alt=sse" : "generateContent";
  const url = `https://${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelId}:${endpoint}`;

  const { history, latestUser } = splitHistory(messages);

  const contents = [];
  for (const m of history) {
    contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    });
  }

  const latestParts = [{ text: latestUser || "" }];
  if (imageBase64) {
    latestParts.push({
      inlineData: {
        mimeType: mimeType || "image/png",
        data: imageBase64
      }
    });
  }
  // YouTube video context: Gemini on Vertex accepts a YouTube URL directly as
  // a fileData part and will watch + reason about the video. We scan the
  // latest user turn for canonical YouTube links and attach each one. Dedup
  // by canonical watch URL so "youtu.be/X" and "youtube.com/watch?v=X" don't
  // both get sent. Capped at 2 videos per turn to keep request size sane.
  const youtubeUrls = extractYouTubeUrls(latestUser || "").slice(0, 2);
  for (const ytUrl of youtubeUrls) {
    latestParts.push({
      fileData: {
        fileUri: ytUrl,
        mimeType: "video/*"
      }
    });
  }
  contents.push({
    role: "user",
    parts: latestParts
  });

  const isCodingModel = ["Voyager 2.1 Preview", "Voyager 2 Pro", "Voyager 2"].includes(resolvedModel);
  const isPlanningModel = resolvedModel === "Orchestra 1.1" || mode === "planning";

  const requestBody = {
    contents,
    systemInstruction: {
      parts: [{ text: getSystemPrompt(resolvedModel, agentMode, workspaceContext, mode, whisperLanguage) }]
    },
    // Dynamically tuned generationConfig for maximum code precision and plan stability
    generationConfig: {
      temperature: isCodingModel ? 0.15 : isPlanningModel ? 0.3 : 0.7,
      maxOutputTokens: isCodingModel || isPlanningModel ? 8192 : 4096
    }
  };

  // 60-second hang guard. If the caller passed an abortSignal (user clicked
  // stop), forward that into the same controller so a single fetch cancellation
  // handles both cases.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), 60_000);
  if (abortSignal) {
    if (abortSignal.aborted) controller.abort("user-stop");
    abortSignal.addEventListener("abort", () => controller.abort("user-stop"), { once: true });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      // Invalidate cached creds on auth errors
      if (response.status === 401 || response.status === 403) {
        _cachedCreds = null;
        _credsCachedAt = 0;
      }
      const errorText = await response.text();
      throw new Error(`Vertex AI REST API error (${response.status}): ${errorText}`);
    }

    // Streaming path: parse SSE events as they arrive, push each text chunk
    // through onChunk, and accumulate the full transcript to return at the end.
    if (onChunk) {
      const contentType = response.headers.get("content-type") || "";
      console.log(`[Vertex Stream] response Content-Type: ${contentType}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let full = "";

      // Diagnostics so an empty stream tells us WHY instead of just throwing.
      let eventCount = 0;
      let textPartCount = 0;
      let thoughtPartCount = 0;
      let lastEvent = null;
      let firstParseError = null;
      let totalBytesReceived = 0;

      // Process a single parsed event payload (after JSON.parse).
      const processEvent = (event) => {
        lastEvent = event;
        eventCount += 1;
        // Vertex emits usageMetadata on the final chunk; forward it so the
        // renderer can update its running token total.
        if (event.usageMetadata && onUsage) {
          try { onUsage({ model: resolvedModel, usage: event.usageMetadata }); } catch { }
        }
        const parts = event.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (typeof part.text !== "string") continue;
          if (part.thought) {
            thoughtPartCount += 1;
            continue;
          }
          textPartCount += 1;
          full += part.text;
          onChunk(part.text);
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) totalBytesReceived += value.length;
        buffer += decoder.decode(value, { stream: true });

        // Path A: SSE format (Content-Type: text/event-stream). Events separated
        // by a blank line; each event has one or more `data:` lines.
        // Vertex emits CRLF line endings, so we look for \r\n\r\n first and
        // fall back to \n\n (in case of LF servers).
        while (true) {
          let sepIdx = buffer.indexOf("\r\n\r\n");
          let sepLen = 4;
          if (sepIdx === -1) {
            sepIdx = buffer.indexOf("\n\n");
            sepLen = 2;
          }
          if (sepIdx === -1) break;

          const rawEvent = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + sepLen);

          // Split on either CRLF or LF to be safe.
          const dataLines = rawEvent
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart());
          if (dataLines.length === 0) continue;

          const payload = dataLines.join("\n");
          if (payload === "[DONE]") continue;

          try {
            processEvent(JSON.parse(payload));
          } catch (e) {
            if (!firstParseError) firstParseError = e?.message || String(e);
          }
        }

        // Path B: JSON-array stream (Content-Type: application/json). Vertex
        // returns a single JSON array `[{...},{...}]` that may arrive in
        // chunks. Try to extract complete top-level objects from the buffer.
        if (eventCount === 0 && contentType.includes("application/json")) {
          let extracted = 0;
          let i = 0;
          while (i < buffer.length) {
            // Skip until next `{`.
            while (i < buffer.length && buffer[i] !== "{") i += 1;
            if (i >= buffer.length) break;
            // Walk forward tracking brace depth + string state.
            let depth = 0;
            let inStr = false;
            let escape = false;
            let j = i;
            for (; j < buffer.length; j += 1) {
              const c = buffer[j];
              if (escape) { escape = false; continue; }
              if (c === "\\") { escape = true; continue; }
              if (c === "\"") { inStr = !inStr; continue; }
              if (inStr) continue;
              if (c === "{") depth += 1;
              else if (c === "}") { depth -= 1; if (depth === 0) { j += 1; break; } }
            }
            if (depth !== 0) break; // incomplete object — wait for more bytes
            const obj = buffer.slice(i, j);
            try {
              processEvent(JSON.parse(obj));
              extracted += 1;
            } catch (e) {
              if (!firstParseError) firstParseError = e?.message || String(e);
            }
            i = j;
          }
          if (extracted > 0) {
            buffer = buffer.slice(i);
          }
        }
      }

      buffer += decoder.decode();
      clearTimeout(timeout);

      if (!full) {
        const finishReason = lastEvent?.candidates?.[0]?.finishReason;
        const safetyRatings = lastEvent?.candidates?.[0]?.safetyRatings;
        const promptFeedback = lastEvent?.promptFeedback;
        console.log("[Vertex Stream] empty result.", {
          contentType,
          totalBytesReceived,
          eventCount,
          textPartCount,
          thoughtPartCount,
          finishReason,
          safetyRatings,
          promptFeedback,
          firstParseError,
          headBuffer: buffer.slice(0, 400),
          tailBuffer: buffer.slice(-200)
        });

        // Fallback: retry the same request without streaming so the user still
        // gets a reply while we figure out why the SSE path didn't yield text.
        console.log("[Vertex Stream] retrying without streaming as fallback…");
        const fallback = await sendToModel({
          model, messages, imageBase64, mimeType, agentMode, workspaceContext
          // intentionally omit onChunk — non-streaming path
        });
        if (fallback) {
          // Push the whole thing through onChunk so the renderer can still
          // animate it (in one shot, but at least the bubble fills).
          onChunk(fallback);
          return fallback;
        }

        const hint = finishReason === "MAX_TOKENS"
          ? "Hit the output-token limit."
          : finishReason === "SAFETY"
            ? "Safety filter blocked the response."
            : thoughtPartCount > 0 && textPartCount === 0
              ? "Model spent its budget on internal thoughts."
              : `No events parsed. Content-Type was "${contentType}", received ${totalBytesReceived} bytes.`;
        throw new Error(`Vertex AI streaming returned no text. ${hint}`);
      }
      return full;
    }

    const data = await response.json();

    if (data.usageMetadata && onUsage) {
      try { onUsage({ model: resolvedModel, usage: data.usageMetadata }); } catch { }
    }

    // Parse response — handle multi-part thinking responses
    const parts = data.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      throw new Error("Vertex AI returned an empty response candidate.");
    }

    // Concatenate only non-thought text parts
    const textParts = parts
      .filter(p => p.text !== undefined && !p.thought)
      .map(p => p.text);

    const reply = textParts.join("") || parts[parts.length - 1]?.text;
    if (!reply) {
      throw new Error("Vertex AI returned no text content in response.");
    }

    return reply;
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === "AbortError") {
      // Distinguish user-requested stops from the 60s hang guard so the UI
      // can show "Stopped" instead of "Timed out".
      const reason = controller.signal.reason;
      if (reason === "user-stop") throw new Error("STOPPED");
      throw new Error("Gemini request timed out after 60 seconds.");
    }
    throw new Error(`Gemini request failed: ${error.message}`);
  }
}

export async function transcribeAudioGCP({ audioBase64, mimeType }) {
  // Use Speech-to-Text v2 with the Chirp 2 model — Google's frontier ASR.
  // Chat LLMs (Gemini, GPT) hallucinate on audio they can't make out; dedicated
  // STT models don't. v2's autoDecodingConfig also sidesteps the sample-rate
  // mismatches that killed v1 on browser-recorded webm/opus.
  const { projectId, accessToken } = await getGCPCredentials();

  // Chirp 2 is not available in `global`. If the user has GCP_LOCATION=global
  // (which works for Vertex), fall back to us-central1 for Speech v2.
  const configuredLocation = process.env.GCP_LOCATION || "us-central1";
  const location = configuredLocation === "global" ? "us-central1" : configuredLocation;
  const host = `${location}-speech.googleapis.com`;
  const url = `https://${host}/v2/projects/${projectId}/locations/${location}/recognizers/_:recognize`;

  const requestBody = {
    config: {
      // autoDecodingConfig: {} tells Chirp to auto-detect codec, container,
      // sample rate, and channel count from the audio bytes. This is what
      // makes browser webm/opus "just work" without us hardcoding 48 kHz etc.
      autoDecodingConfig: {},
      model: "chirp_2",
      languageCodes: ["en-US"],
      features: {
        enableAutomaticPunctuation: true
      }
    },
    content: audioBase64
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "x-goog-user-project": projectId
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    let detail = errorText;
    try {
      const parsed = JSON.parse(errorText);
      if (parsed?.error?.message) detail = parsed.error.message;
    } catch { /* keep raw body */ }
    if (response.status === 403 || response.status === 404) {
      detail += ` — Make sure the Speech-to-Text API is enabled and your project has access to chirp_2 in ${location}. Run: gcloud services enable speech.googleapis.com`;
    }
    throw new Error(`Chirp 2 transcription error (${response.status}) for project "${projectId}": ${detail}`);
  }

  const data = await response.json();
  // v2 response shape: { results: [ { alternatives: [ { transcript, confidence } ], ... } ] }
  const transcript = (data.results || [])
    .map((r) => r.alternatives?.[0]?.transcript || "")
    .join(" ")
    .trim();

  if (!transcript) {
    console.log("[Chirp 2 Transcribe] empty result. raw response:", JSON.stringify(data));
  }

  return transcript || "";
}
