import fs from "node:fs";
import path from "node:path";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import dotenv from "dotenv";
import { parseAIResponse, applySearchReplacePatches } from "../shared/parser.js";
import { createTimelineSnapshot, normalizeWorkspaceRoot, resolveInsideWorkspace } from "../shared/workspace-security.js";
import { MODEL_IDS, routeAutoModel } from "../shared/models.js";

const execAsync = promisify(exec);
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_TOOL_OUTPUT_CHARS = 12000;

// Parse arguments
const workspacePath = process.argv[2];
const task = process.argv[3];
const agentId = process.argv[4];
const logPath = process.argv[5];
const passedModel = process.argv[6];

if (!workspacePath || !task || !agentId || !logPath) {
  console.error("Usage: node agent-runner.js <workspacePath> <task> <agentId> <logPath>");
  process.exit(1);
}

const workspaceRoot = normalizeWorkspaceRoot(workspacePath);

// Setup dotenv
dotenv.config({ path: path.join(workspaceRoot, ".env") });

// Ensure log directory exists
fs.mkdirSync(path.dirname(logPath), { recursive: true });

function log(text) {
  fs.appendFileSync(logPath, text + "\n", "utf8");
  console.log(text);
}

function truncateToolOutput(text, limit = MAX_TOOL_OUTPUT_CHARS) {
  const value = String(text ?? "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[Orbit truncated ${value.length - limit} additional characters from this tool result.]`;
}

// Initial log headers
log("=".repeat(80));
log("ORBIT BACKGROUND AGENT RUNNER");
log(`Agent ID: ${agentId}`);
log(`Workspace: ${workspaceRoot}`);
log(`Task: ${task}`);
log(`Date: ${new Date().toISOString()}`);
log("=".repeat(80));
log("");

// Helper to list workspace
function listWorkspaceFiles(dir, baseDir = dir) {
  let results = [];
  try {
    const list = fs.readdirSync(dir);
    for (const file of list) {
      if (file === "node_modules" || file === ".git" || file === "dist-app" || file === "build" || file === ".orbit") {
        continue;
      }
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat && stat.isDirectory()) {
        results = results.concat(listWorkspaceFiles(fullPath, baseDir));
      } else {
        results.push(path.relative(baseDir, fullPath));
      }
    }
  } catch (err) {
    // Ignore error
  }
  return results;
}

// Helper to get GCP token
let _cachedToken = null;
let _tokenFetchedAt = 0;
async function getGCPToken() {
  if (_cachedToken && (Date.now() - _tokenFetchedAt) < 50 * 60 * 1000) {
    return _cachedToken;
  }
  let projectId = process.env.GCP_PROJECT;
  if (!projectId) {
    const { stdout } = await execAsync("gcloud config get-value project");
    projectId = stdout.trim();
  }
  const { stdout: tokenStdout } = await execAsync("gcloud auth print-access-token");
  const accessToken = tokenStdout.trim();
  _cachedToken = { projectId, accessToken };
  _tokenFetchedAt = Date.now();
  return _cachedToken;
}

// Interactive command spawning with stdin polling support
function runInteractiveCommand(command, controlFile) {
  return new Promise((resolve) => {
    log(`Running command: ${command}`);

    const child = spawn("cmd.exe", ["/c", command], {
      cwd: workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdoutData = "";
    let stderrData = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      stderrData += `\n[Orbit] Command timed out after ${COMMAND_TIMEOUT_MS / 1000} seconds and was terminated.`;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        if (!child.killed) {
          try { child.kill("SIGKILL"); } catch {}
        }
      }, 1500);
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdoutData += text;
      fs.appendFileSync(logPath, text, "utf8");
      process.stdout.write(text);
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderrData += text;
      fs.appendFileSync(logPath, text, "utf8");
      process.stderr.write(text);
    });

    // Poll for standard input to feed into the active process
    const stdinPollInterval = setInterval(() => {
      if (fs.existsSync(controlFile)) {
        try {
          const ctrl = JSON.parse(fs.readFileSync(controlFile, "utf8"));
          if (ctrl.stdin) {
            log(`[Interception] Stdin received: "${ctrl.stdin}"`);
            child.stdin.write(ctrl.stdin + "\n");

            // Clean standard input immediately to avoid duplicate inputs
            ctrl.stdin = "";
            fs.writeFileSync(controlFile, JSON.stringify(ctrl, null, 2), "utf8");
          }
        } catch (e) {
          // ignore temporary parsing issues
        }
      }
    }, 200);

    child.on("close", (code) => {
      clearInterval(stdinPollInterval);
      clearTimeout(timeout);
      resolve({
        stdout: stdoutData,
        stderr: stderrData,
        exitCode: timedOut ? 124 : code
      });
    });

    child.on("error", (err) => {
      clearInterval(stdinPollInterval);
      clearTimeout(timeout);
      resolve({
        stdout: stdoutData,
        stderr: stderrData + "\n" + err.message,
        exitCode: 1
      });
    });
  });
}

// Loop execution
async function run() {
  const messages = [
    { role: "user", content: task }
  ];

  const passedModelName = passedModel || "Voyager 2 Pro";
  let resolvedModel = passedModelName;
  if (resolvedModel === "Auto") {
    resolvedModel = routeAutoModel({ text: task, agentMode: true });
  }
  const modelId = MODEL_IDS[resolvedModel] || "gemini-3.5-flash";
  const location = process.env.GCP_LOCATION || "us-central1";
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/{PROJECT_ID}/locations/${location}/publishers/google/models/${modelId}:generateContent`;

  const systemPrompt = `You are an elite autonomous coding agent deployed by Orbit. You have one job: COMPLETE THE TASK BELOW THROUGH CODE CHANGES. No excuses, no stalling.

TASK: "${task}"

====== MANDATORY BEHAVIOR ======
- START CODING IMMEDIATELY ON STEP 1. Do NOT spend your first step just reading files or planning. If you need context, read files AND make a first change in the same step.
- MAKE REAL CODE CHANGES. Every response must include at least one <patch_file> or <write_file> tag until the task is fully done. If you are only reading/listing without writing, you are failing.
- DO NOT ASK FOR PERMISSION or say things like "I'll need to..." / "Let me first..." / "I will now...". Just DO it — emit the tag.
- DO NOT write summaries or explanations between steps. Keep text extremely brief. Let your code speak.
- If you read a file, make the needed change to it in the SAME response.
- Self-verify: after making changes, run a build or test command with <execute_command> to confirm correctness.
- When the full task is solved and verified, write one short summary paragraph. That ends the loop.

====== TOOLS ======
1. Run a terminal command:
<execute_command>YOUR_COMMAND</execute_command>

2. Surgically modify an existing file (PREFERRED for existing files — prevents truncation):
<patch_file path="relative/path/to/file.js">
<<<<<<< SEARCH
exact lines of original code
=======
new replacement lines
>>>>>>> REPLACE
</patch_file>
Multiple SEARCH/REPLACE blocks allowed in one tag. SEARCH must match exactly including whitespace.

3. Create a new file OR completely replace a small file:
<write_file path="relative/path/to/file.js">
COMPLETE FILE CONTENT — never use placeholders like "// rest of file"
</write_file>

4. Read a file (only if you genuinely need it before patching):
<read_file path="relative/path/to/file.js" />

5. List all files in the workspace:
<list_workspace />

====== RULES ======
- Prefer <patch_file> over <write_file> for existing files. Rewriting large files whole risks truncation and data loss.
- ALWAYS write 100% complete content in <write_file>. Zero placeholders allowed.
- Maximum 12 steps. Spend every step making progress.
- If there are no tool tags in your response, the agent loop ends immediately.`;


  let step = 1;
  const maxSteps = 12;
  const controlFile = path.join(workspaceRoot, ".orbit", `${agentId}.control.json`);

  while (step <= maxSteps) {
    log(`[Step ${step} / ${maxSteps}]`);

    // Interception Check Point: Check for Pause, Resume, or Directive Injections
    let isPaused = false;
    let injectedPrompt = "";

    while (true) {
      if (fs.existsSync(controlFile)) {
        try {
          const ctrl = JSON.parse(fs.readFileSync(controlFile, "utf8"));
          if (ctrl.paused) {
            if (!isPaused) {
              log("[Interception] Agent paused by user. Standing by...");
              isPaused = true;
            }
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          if (isPaused && !ctrl.paused) {
            log("[Interception] Agent resumed by user!");
            isPaused = false;
          }
          if (ctrl.injectedInstruction) {
            log(`[Interception] User injected a new instruction mid-run: "${ctrl.injectedInstruction}"`);
            injectedPrompt = ctrl.injectedInstruction;

            // Clear injected instruction immediately
            ctrl.injectedInstruction = "";
            fs.writeFileSync(controlFile, JSON.stringify(ctrl, null, 2), "utf8");
          }
        } catch (e) {
          // ignore temporary lock chimes
        }
      }
      break;
    }

    if (injectedPrompt) {
      messages.push({
        role: "user",
        content: `[USER INJECTED INSTRUCTION MID-RUN - PLEASE ADAPT YOUR PLAN IMMEDIATELY]:\n${injectedPrompt}`
      });
    }

    log(`Contacting model ${modelId}...`);

    try {
      const { projectId, accessToken } = await getGCPToken();
      const endpointUrl = url.replace("{PROJECT_ID}", projectId);

      const contents = messages.map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
      }));

      const response = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents,
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          }
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Vertex AI REST API error (${response.status}): ${errText}`);
      }

      const responseData = await response.json();
      const parts = responseData.candidates?.[0]?.content?.parts;
      if (!parts || parts.length === 0) {
        throw new Error("Empty response candidates from model.");
      }
      const reply = parts.filter(p => p.text !== undefined && !p.thought).map(p => p.text).join("");

      log(`AI Response:`);
      log(reply);
      log("-".repeat(40));

      messages.push({ role: "assistant", content: reply });

      const toolParts = parseAIResponse(reply).filter(p => p.type !== "text");

      if (toolParts.length === 0) {
        log(`No tools requested. Exiting agent loop successfully.`);
        log("");
        log("=".repeat(80));
        log("AGENT FINISHED SUCCESSFULLY");
        log("=".repeat(80));
        break;
      }

      log(`Executing tools sequentially...`);
      let combinedResults = [];

      for (const tool of toolParts) {
        log(`Executing tool: ${tool.type}`);
        if (tool.type === "execute_command") {
          try {
            const res = await runInteractiveCommand(tool.content, controlFile);
            const output = [res.stdout, res.stderr].filter(Boolean).join("\n").trim() || "(No output)";
            log(`Output length: ${output.length} characters (Exit code: ${res.exitCode})`);
            combinedResults.push(`[TOOL_RESULT: execute_command]\nexit code: ${res.exitCode}\n${truncateToolOutput(output)}`);
          } catch (execErr) {
            log(`Error executing command: ${execErr.message}`);
            combinedResults.push(`[TOOL_RESULT: execute_command (FAILED)]\n${execErr.message}`);
          }
        } else if (tool.type === "write_file") {
          try {
            const { fullPath, relativePath } = resolveInsideWorkspace(workspaceRoot, tool.path);
            log(`Writing file: ${tool.path}`);
            // Capture pre-write state for the undo timeline. We keep the
            // previous content (or null if the file didn't exist) so a
            // revert can restore exactly what was there.
            let prevContent = null;
            let existed = false;
            try {
              if (fs.existsSync(fullPath)) {
                prevContent = fs.readFileSync(fullPath, "utf8");
                existed = true;
              }
            } catch { /* unreadable — store null */ }
            // Ensure directory exists
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, tool.content, "utf8");
            log(`Success writing ${tool.path}`);
            // Append a timeline entry under .orbit/timeline.json.
            try {
              const tlPath = path.join(workspaceRoot, ".orbit", "timeline.json");
              let timeline = [];
              if (fs.existsSync(tlPath)) {
                try { timeline = JSON.parse(fs.readFileSync(tlPath, "utf8")); } catch { timeline = []; }
              }
              const snapshot = createTimelineSnapshot(relativePath, prevContent);
              timeline.push({
                ts: new Date().toISOString(),
                agentId,
                op: "write_file",
                path: relativePath,
                existedBefore: existed,
                ...snapshot,
                newLen: (tool.content || "").length
              });
              // Cap timeline at 200 entries so it doesn't grow forever.
              if (timeline.length > 200) timeline = timeline.slice(-200);
              fs.writeFileSync(tlPath, JSON.stringify(timeline, null, 2), "utf8");
            } catch (tlErr) {
              log(`(timeline write failed: ${tlErr.message})`);
            }
            combinedResults.push(`[TOOL_RESULT: write_file]\nSuccessfully wrote ${tool.path}`);
          } catch (writeErr) {
            log(`Error writing file: ${writeErr.message}`);
            combinedResults.push(`[TOOL_RESULT: write_file (FAILED)]\nError: ${writeErr.message}`);
          }
        } else if (tool.type === "patch_file") {
          try {
            const { fullPath, relativePath } = resolveInsideWorkspace(workspaceRoot, tool.path);
            log(`Patching file: ${tool.path}`);
            if (!fs.existsSync(fullPath)) {
              throw new Error("File does not exist. Use <write_file> to create new files.");
            }
            const prevContent = fs.readFileSync(fullPath, "utf8");
            const updatedContent = applySearchReplacePatches(prevContent, tool.content || "");
            
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, updatedContent, "utf8");
            log(`Success patching ${tool.path}`);
            
            try {
              const tlPath = path.join(workspaceRoot, ".orbit", "timeline.json");
              let timeline = [];
              if (fs.existsSync(tlPath)) {
                try { timeline = JSON.parse(fs.readFileSync(tlPath, "utf8")); } catch { timeline = []; }
              }
              const snapshot = createTimelineSnapshot(relativePath, prevContent);
              timeline.push({
                ts: new Date().toISOString(),
                agentId,
                op: "write_file",
                path: relativePath,
                existedBefore: true,
                ...snapshot,
                newLen: updatedContent.length
              });
              if (timeline.length > 200) timeline = timeline.slice(-200);
              fs.writeFileSync(tlPath, JSON.stringify(timeline, null, 2), "utf8");
            } catch (tlErr) {
              log(`(timeline write failed: ${tlErr.message})`);
            }
            combinedResults.push(`[TOOL_RESULT: patch_file]\nSuccessfully patched ${tool.path}`);
          } catch (patchErr) {
            log(`Error patching file: ${patchErr.message}`);
            combinedResults.push(`[TOOL_RESULT: patch_file (FAILED)]\nError: ${patchErr.message}`);
          }
        } else if (tool.type === "read_file") {
          try {
            const { fullPath } = resolveInsideWorkspace(workspaceRoot, tool.path);
            log(`Reading file: ${tool.path}`);
            if (fs.existsSync(fullPath)) {
              const content = fs.readFileSync(fullPath, "utf8");
              log(`Read ${content.length} characters`);
              combinedResults.push(`[TOOL_RESULT: read_file path="${tool.path}"]\n${truncateToolOutput(content)}`);
            } else {
              log(`File does not exist: ${tool.path}`);
              combinedResults.push(`[TOOL_RESULT: read_file path="${tool.path}" (FAILED)]\nFile does not exist.`);
            }
          } catch (readErr) {
            log(`Error reading file: ${readErr.message}`);
            combinedResults.push(`[TOOL_RESULT: read_file path="${tool.path}" (FAILED)]\nError: ${readErr.message}`);
          }
        } else if (tool.type === "list_workspace") {
          try {
            log(`Listing workspace...`);
            const files = listWorkspaceFiles(workspaceRoot);
            const fileList = truncateToolOutput(files.map(f => `- ${f}`).join("\n"));
            log(`Found ${files.length} files`);
            combinedResults.push(`[TOOL_RESULT: list_workspace]\n${fileList}`);
          } catch (listErr) {
            log(`Error listing workspace: ${listErr.message}`);
            combinedResults.push(`[TOOL_RESULT: list_workspace (FAILED)]\nError: ${listErr.message}`);
          }
        } else {
          log(`Warning: Unrecognized tool type: ${tool.type}`);
          combinedResults.push(`[TOOL_RESULT: ${tool.type} (FAILED)]\nUnsupported tool.`);
        }
      }

      const nextTurnContent = combinedResults.join("\n\n");
      messages.push({ role: "user", content: nextTurnContent });
      log("=".repeat(80));

    } catch (err) {
      log(`CRITICAL ERROR IN AGENT LOOP: ${err.message}`);
      log(`STACK: ${err.stack}`);
      break;
    }

    step++;
  }

  if (step > maxSteps) {
    log(`Reached maximum steps (${maxSteps}). Stopping background agent loop.`);
  }

  // Cleanup control file on exit
  try {
    if (fs.existsSync(controlFile)) {
      fs.unlinkSync(controlFile);
    }
  } catch (cleanupErr) {
    // ignore cleanup fails
  }
}

run();
