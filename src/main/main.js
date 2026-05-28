import "dotenv/config";

import { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen, dialog, session, shell, Tray, Menu, globalShortcut, clipboard } from "electron";
import { mkdir, readFile, writeFile, readdir, stat as statAsync, unlink } from "node:fs/promises";
import { existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { createHistoryStore } from "../shared/history-store.js";
import { getOverlayBounds } from "../shared/overlay-window.js";
import { sendToModel, transcribeAudioGCP } from "../shared/ai-service.js";
import { createTimelineSnapshot, isAllowedExternalUrl, normalizeWorkspaceRoot, resolveInsideWorkspace } from "../shared/workspace-security.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let overlayWindow;
let historyStore;
// Cache of per-workspace history stores so we don't recreate them per IPC call.
const workspaceHistoryStores = new Map();
let tray = null;
let activeWorkspacePath = "";
let currentRendererMode = "overlay";

// Resolve the right history store for the currently active workspace.
// Without a workspace, falls back to the global chat-history.json (legacy).
function getHistoryStoreForWorkspace() {
  if (!activeWorkspacePath) return historyStore;
  if (workspaceHistoryStores.has(activeWorkspacePath)) {
    return workspaceHistoryStores.get(activeWorkspacePath);
  }
  // Hash the path so the on-disk filename is portable + filesystem-safe,
  // and append a short slug so users can tell which workspace a file is for.
  const hash = createHash("sha1").update(activeWorkspacePath).digest("hex").slice(0, 8);
  const slug = activeWorkspacePath.split(/[/\\]/).filter(Boolean).pop()?.replace(/[^a-z0-9-_]+/gi, "-") || "workspace";
  const file = join(app.getPath("userData"), "workspaces", `${slug}-${hash}.json`);
  const store = createHistoryStore(file);
  workspaceHistoryStores.set(activeWorkspacePath, store);
  return store;
}
// Persisted user-dragged position. Loaded from windowStateStore on launch and
// rewritten (debounced) whenever the user finishes a drag. null means "never
// dragged" → fall back to the calculated centered position.
let savedWindowState = null;
let windowStateSaveTimer = null;
let windowStateStorePath = null;

async function loadSavedWindowState() {
  if (!windowStateStorePath) return null;
  try {
    const raw = await readFile(windowStateStorePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
      return parsed;
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("[Orbit Main] failed to load window state:", err.message);
    }
  }
  return null;
}

function scheduleWindowStateSave() {
  if (!overlayWindow || !windowStateStorePath) return;
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(async () => {
    try {
      const b = overlayWindow.getBounds();
      const cursor = screen.getCursorScreenPoint();
      const display = screen.getDisplayMatching(b);
      savedWindowState = {
        x: b.x,
        y: b.y,
        displayId: display?.id ?? null,
        cursorDisplayId: screen.getDisplayNearestPoint(cursor)?.id ?? null
      };
      await mkdir(dirname(windowStateStorePath), { recursive: true });
      await writeFile(windowStateStorePath, JSON.stringify(savedWindowState, null, 2), "utf8");
    } catch (err) {
      console.warn("[Orbit Main] failed to save window state:", err.message);
    }
  }, 250);
}
// streamId -> AbortController for in-flight AI requests, so a "stop" click
// in the renderer can cancel the upstream fetch.
const activeStreams = new Map();
const activeBackgroundAgents = new Map();

// Run a PowerShell script via -EncodedCommand. We tried piping the script
// over stdin (`-Command -`) but multi-line scripts with here-strings and
// Add-Type DllImport blocks failed silently — PowerShell would exit 0 without
// running anything visible. EncodedCommand base64s the whole script as one
// argv argument so there's no stdin / quoting / CRLF / here-string drama.
function runPowerShell(script) {
  return new Promise((resolve) => {
    // PowerShell expects UTF-16LE base64 for -EncodedCommand.
    const utf16 = Buffer.from(script, "utf16le");
    const b64 = utf16.toString("base64");

    exec(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${b64}`,
      { windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            error: error.message,
            stdout: (stdout || "").trim(),
            stderr: (stderr || "").trim(),
            exitCode: error.code
          });
        } else {
          resolve({
            ok: true,
            stdout: (stdout || "").trim(),
            stderr: (stderr || "").trim(),
            exitCode: 0
          });
        }
      }
    );
  });
}

async function listFilesSafe(dir, baseDir, fileList = [], depth = 0) {
  if (depth > 5 || fileList.length > 500) {
    return fileList;
  }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      if (
        name.startsWith(".") ||
        name === "node_modules" ||
        name === "dist" ||
        name === "build" ||
        name === "out" ||
        name === "target" ||
        name === "bin" ||
        name === "obj"
      ) {
        continue;
      }
      const fullPath = join(dir, name);
      const relPath = relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        await listFilesSafe(fullPath, baseDir, fileList, depth + 1);
      } else {
        const ext = extname(name).toLowerCase();
        const codeExtensions = [
          ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".json", ".md", ".txt",
          ".py", ".java", ".cpp", ".h", ".cs", ".go", ".rs", ".php", ".rb",
          ".sh", ".bat", ".ps1", ".xml", ".yaml", ".yml", ".ini", ".conf", ".sql"
        ];
        if (codeExtensions.includes(ext) || !ext) {
          fileList.push({
            name,
            path: relPath.replace(/\\/g, "/")
          });
        }
      }
    }
  } catch (error) {
    // Ignore inaccessible files/folders
  }
  return fileList;
}

function getPrimaryDisplayWidth() {
  return screen.getPrimaryDisplay().workAreaSize.width;
}

// Active animation handle so a new state change can cancel mid-flight.
let boundsAnimTimer = null;

// Cubic ease-out: fast start, gentle landing — matches the CSS spring curves.
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function setOverlayState(state) {
  if (!overlayWindow) return;
  const normalizedState = ["collapsed", "hover", "expanded", "dropdown-open", "mission-control"].includes(state)
    ? state
    : "mission-control";
  const isFloatingOverlay = normalizedState !== "mission-control";

  overlayWindow.setMinimumSize(isFloatingOverlay ? 600 : 1040, isFloatingOverlay ? 40 : 720);
  overlayWindow.setAlwaysOnTop(isFloatingOverlay, isFloatingOverlay ? "screen-saver" : "normal");
  overlayWindow.setResizable(!isFloatingOverlay);
  overlayWindow.setSkipTaskbar(isFloatingOverlay);

  // Resize relative to the display the user has dragged the overlay onto,
  // not always the primary one. This keeps state transitions sane on
  // multi-monitor setups.
  const currentBounds = overlayWindow.getBounds();
  const currentDisplay = screen.getDisplayMatching(currentBounds);
  const calculated = getOverlayBounds({
    displayWidth: currentDisplay.workAreaSize.width,
    displayHeight: currentDisplay.workAreaSize.height,
    state: normalizedState
  });

  // Cancel any in-flight animation so state changes don't stack.
  if (boundsAnimTimer) {
    clearInterval(boundsAnimTimer);
    boundsAnimTimer = null;
  }

  const start = overlayWindow.getBounds();
  const targetX = currentDisplay.workArea.x + calculated.x;
  const targetY = currentDisplay.workArea.y + calculated.y;
  const targetBounds = {
    x: targetX,
    y: targetY,
    width: calculated.width,
    height: calculated.height
  };

  // Instant for tiny changes (hover height tweak, dropdown peek) — only
  // animate the big collapsed ↔ expanded transition.
  const ANIM_DURATION_MS = 180;
  const ANIM_INTERVAL_MS = 8; // ~120fps — smooth but cheap
  const totalSteps = Math.round(ANIM_DURATION_MS / ANIM_INTERVAL_MS);
  let step = 0;

  const heightDelta = targetBounds.height - start.height;
  const xDelta      = targetBounds.x     - start.x;
  const widDelta    = targetBounds.width  - start.width;
  const shouldAnimate = Math.abs(heightDelta) > 20 || Math.abs(widDelta) > 20;

  if (!shouldAnimate) {
    overlayWindow.setBounds(targetBounds);
  } else {
    boundsAnimTimer = setInterval(() => {
      if (!overlayWindow) { clearInterval(boundsAnimTimer); return; }
      step++;
      const t = easeOutCubic(Math.min(step / totalSteps, 1));
      overlayWindow.setBounds({
        x:      Math.round(start.x      + xDelta      * t),
        y:      start.y,
        width:  Math.round(start.width  + widDelta    * t),
        height: Math.round(start.height + heightDelta * t)
      });
      if (step >= totalSteps) {
        clearInterval(boundsAnimTimer);
        boundsAnimTimer = null;
        // Snap to exact target to avoid off-by-one rounding drift.
        overlayWindow.setBounds(targetBounds);
      }
    }, ANIM_INTERVAL_MS);
  }

  if (normalizedState === "mission-control") {
    overlayWindow.show();
    overlayWindow.focus();
  } else if (normalizedState === "expanded" || normalizedState === "hover" || normalizedState === "dropdown-open") {
    if (!overlayWindow.isFocused()) {
      overlayWindow.focus();
    }
  }
}

async function capturePrimaryScreen() {
  const display = screen.getPrimaryDisplay();
  // Capture at PHYSICAL pixel resolution. display.size is in DIPs/logical
  // pixels; the click handler below sets the cursor via System.Windows.Forms
  // which operates in physical pixels on DPI-aware processes. If we captured
  // at logical size, model-derived (x,y) would land at the wrong spot on any
  // display with scaleFactor > 1 (e.g. 150% scaling clicked the top-left
  // instead of center).
  const sf = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(display.size.width * sf),
      height: Math.round(display.size.height * sf)
    }
  });

  const source = sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    return null;
  }

  const image = nativeImage.createFromDataURL(source.thumbnail.toDataURL());
  const screenshotsDir = join(app.getPath("userData"), "screenshots");
  const filePath = join(screenshotsDir, `screen-${Date.now()}.png`);
  await mkdir(screenshotsDir, { recursive: true });
  await writeFile(filePath, image.toPNG());

  return filePath;
}

function mimeFromPath(filePath) {
  const ext = extname(filePath || "").toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

async function loadScreenshotBase64(filePath) {
  if (!filePath) return { imageBase64: null, mimeType: null };
  try {
    const buffer = await readFile(filePath);
    return {
      imageBase64: buffer.toString("base64"),
      mimeType: mimeFromPath(filePath)
    };
  } catch {
    return { imageBase64: null, mimeType: null };
  }
}

// ─── Interactive region picker ─────────────────────────────────────────
// Captures the primary display, opens a fullscreen transparent picker over
// it, lets the user drag a rectangle, then writes the cropped PNG to the
// userData/screenshots folder and returns its path (same shape as a full
// screenshot so it flows through the existing screenshotPath pipeline).
async function captureRegionInteractive() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

  // First grab a full screenshot we can crop from later.
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: display.size.width,
      height: display.size.height
    }
  });
  const matched = sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!matched || matched.thumbnail.isEmpty()) return null;
  const fullImage = nativeImage.createFromDataURL(matched.thumbnail.toDataURL());

  // Hide the overlay so it doesn't appear inside the region screenshot.
  const wasVisible = overlayWindow?.isVisible();
  if (overlayWindow && wasVisible) overlayWindow.hide();

  // Tiny settle so the OS actually paints the hidden state before the picker.
  await new Promise((r) => setTimeout(r, 80));

  const pickerWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    fullscreenable: false,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload-picker.cjs")
    }
  });
  pickerWindow.setAlwaysOnTop(true, "screen-saver");
  pickerWindow.loadFile(join(__dirname, "../renderer/region-picker.html"));

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      try { pickerWindow.close(); } catch {}
      if (overlayWindow && wasVisible) overlayWindow.showInactive();
      resolve(value);
    };

    ipcMain.once("region-picker:cancel", () => finish(null));
    ipcMain.once("region-picker:commit", async (_e, rect) => {
      try {
        // Map CSS pixels back into image pixels using the display scale factor.
        const sf = display.scaleFactor || 1;
        const crop = {
          x: Math.max(0, Math.round(rect.x * sf)),
          y: Math.max(0, Math.round(rect.y * sf)),
          width: Math.max(1, Math.round(rect.width * sf)),
          height: Math.max(1, Math.round(rect.height * sf))
        };
        const cropped = fullImage.crop(crop);
        const dir = join(app.getPath("userData"), "screenshots");
        await mkdir(dir, { recursive: true });
        const path = join(dir, `region-${Date.now()}.png`);
        await writeFile(path, cropped.toPNG());
        finish(path);
      } catch (err) {
        console.warn("[Orbit Region] crop failed:", err.message);
        finish(null);
      }
    });

    pickerWindow.once("ready-to-show", () => {
      pickerWindow.show();
      pickerWindow.focus();
    });
    pickerWindow.on("closed", () => finish(null));
  });
}

// ─── Global keyboard shortcuts ─────────────────────────────────────────
// Ctrl+Shift+O — toggle the overlay's visibility from anywhere.
// Ctrl+Shift+L — copy current OS selection into the overlay's prompt as a
//   quoted block. Done by saving the current clipboard, sending Ctrl+C to
//   the foreground app, reading the clipboard, restoring the original, and
//   then pushing the text to the renderer.
function registerGlobalShortcuts() {
  try {
    globalShortcut.register("CommandOrControl+Shift+O", () => {
      if (!overlayWindow) return;
      if (overlayWindow.isVisible()) {
        overlayWindow.hide();
      } else {
        overlayWindow.showInactive();
      }
    });

    globalShortcut.register("CommandOrControl+Shift+L", async () => {
      if (!overlayWindow) return;
      // Stash whatever the user already has on the clipboard so we don't
      // clobber it. Then send Ctrl+C to the foreground window via SendKeys.
      const saved = clipboard.readText();
      const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^c')
Start-Sleep -Milliseconds 120
`.trim();
      await runPowerShell(script);
      // Brief settle so the clipboard has the new selection.
      await new Promise((r) => setTimeout(r, 80));
      const grabbed = clipboard.readText();
      if (saved !== grabbed) {
        // Restore original clipboard contents.
        clipboard.writeText(saved);
      }
      const text = (grabbed || "").trim();
      if (!text) return;
      overlayWindow.showInactive();
      overlayWindow.webContents.send("overlay:selection-context", { text });
    });
  } catch (err) {
    console.warn("[Orbit Main] globalShortcut registration failed:", err.message);
  }
}

function createSystemTray() {
  const iconPath = join(__dirname, "../../build/icon.png");
  let trayIcon;
  try {
    const rawImage = nativeImage.createFromPath(iconPath);
    if (rawImage.isEmpty()) {
      console.warn("[Orbit Main] Raw tray icon image is empty. Path tried: " + iconPath);
    }
    trayIcon = rawImage.resize({ width: 16, height: 16 });
  } catch (err) {
    console.error("[Orbit Main] Error loading or resizing tray icon:", err);
  }

  tray = new Tray(trayIcon || iconPath);
  tray.setToolTip("Orbit");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open Full App",
      click: () => {
        switchRendererMode("app");
      }
    },
    {
      label: "Switch to Overlay",
      click: () => {
        switchRendererMode("overlay");
      }
    },
    { type: "separator" },
    {
      label: "Show Orbit",
      click: () => {
        if (overlayWindow) {
          overlayWindow.showInactive();
        }
      }
    },
    {
      label: "Hide Orbit",
      click: () => {
        if (overlayWindow) {
          overlayWindow.hide();
        }
      }
    },
    { type: "separator" },
    {
      label: "Quit Orbit",
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    if (!overlayWindow) return;
    if (overlayWindow.isVisible()) {
      overlayWindow.hide();
    } else {
      overlayWindow.showInactive();
    }
  });
}

async function switchRendererMode(mode) {
  if (!overlayWindow) return;
  currentRendererMode = mode === "app" ? "app" : "overlay";
  const file = currentRendererMode === "app"
    ? join(__dirname, "../app-renderer/index.html")
    : join(__dirname, "../renderer/index.html");

  await overlayWindow.loadFile(file);
  setOverlayState(currentRendererMode === "app" ? "mission-control" : "collapsed");
  if (currentRendererMode === "overlay") {
    overlayWindow.showInactive();
  } else {
    overlayWindow.show();
    overlayWindow.focus();
  }
}

function createOverlayWindow() {
  // ─── Multi-monitor & drag-position memory ─────────────────────────────
  // Determine which display to spawn on:
  //   1. If we have a saved position, use that display (and that x/y).
  //   2. Otherwise spawn on the display containing the cursor.
  let targetDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (savedWindowState?.displayId != null) {
    const match = screen.getAllDisplays().find((d) => d.id === savedWindowState.displayId);
    if (match) targetDisplay = match;
  }

  const calc = getOverlayBounds({
    displayWidth: targetDisplay.workAreaSize.width,
    displayHeight: targetDisplay.workAreaSize.height,
    state: "collapsed"
  });
  // Shift the calculated (centered-on-primary) bounds into the chosen display.
  const bounds = {
    x: (savedWindowState?.x ?? (targetDisplay.workArea.x + calc.x)),
    y: (savedWindowState?.y ?? (targetDisplay.workArea.y + calc.y)),
    width: calc.width,
    height: calc.height
  };
  console.log("[Orbit Main] Initial overlay bounds:", bounds, "display:", targetDisplay.id);

  overlayWindow = new BrowserWindow({
    ...bounds,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    focusable: true,
    frame: false,
    hasShadow: false,
    maximizable: true,
    minimizable: false,
    movable: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    transparent: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload.cjs")
    }
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setMinimumSize(600, 40);
  overlayWindow.loadFile(join(__dirname, "../renderer/index.html"));
  
  overlayWindow.once("ready-to-show", () => {
    console.log("[Orbit Main] Overlay ready-to-show — revealing.");
    overlayWindow.showInactive();
  });

  overlayWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log('[Overlay Renderer]', message);
  });

  // Persist drag position. 'move' fires throughout the drag; we debounce
  // via scheduleWindowStateSave so we don't hammer the disk.
  overlayWindow.on("move", () => {
    scheduleWindowStateSave();
  });
}

function registerIpc() {
  ipcMain.handle("history:load", (_event, workspacePath) => {
    if (typeof workspacePath === "string" && workspacePath) {
      activeWorkspacePath = normalizeWorkspaceRoot(workspacePath);
    }
    console.log("[Orbit Main] IPC: loading history (workspace=", activeWorkspacePath || "(global)", ")");
    return getHistoryStoreForWorkspace().load();
  });
  ipcMain.handle("history:save", (_event, history) => {
    console.log("[Orbit Main] IPC: saving history (workspace=", activeWorkspacePath || "(global)", ")");
    return getHistoryStoreForWorkspace().save(history);
  });

  // Snapshot the current chat to a timestamped JSON file under
  // userData/chat-snapshots/. Used by the "Fork from here" action so the
  // pre-fork conversation isn't lost.
  ipcMain.handle("history:snapshot", async (_event, history) => {
    try {
      const dir = join(app.getPath("userData"), "chat-snapshots");
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const path = join(dir, `snapshot-${stamp}.json`);
      await writeFile(path, JSON.stringify(history || {}, null, 2), "utf8");
      return { ok: true, path };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("overlay:set-state", (_event, state) => {
    console.log("[Orbit Main] IPC: setting state to:", state);
    setOverlayState(["collapsed", "hover", "expanded", "dropdown-open", "mission-control"].includes(state) ? state : "mission-control");
  });
  ipcMain.handle("app:set-mode", (_event, mode) => switchRendererMode(mode));
  ipcMain.handle("window:minimize", () => {
    overlayWindow?.minimize();
  });
  ipcMain.handle("window:toggle-maximize", () => {
    if (!overlayWindow) return;
    if (overlayWindow.isMaximized()) overlayWindow.unmaximize();
    else overlayWindow.maximize();
  });
  ipcMain.handle("window:close", () => {
    overlayWindow?.close();
  });
  ipcMain.handle("screen:capture", () => capturePrimaryScreen());
  ipcMain.handle("screen:capture-region", () => captureRegionInteractive());

  // Persist an inline-pasted image to userData/screenshots so it can flow
  // through the same screenshotPath pipeline as a real screen capture.
  // Accepts a data URL like "data:image/png;base64,iVBORw0KGgo..."
  ipcMain.handle("screen:save-pasted-image", async (_event, { dataUrl }) => {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
      return { ok: false, error: "Invalid data URL" };
    }
    try {
      const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (!match) return { ok: false, error: "Malformed image data URL" };
      const mime = match[1];
      const b64 = match[2];
      const ext = mime.includes("jpeg") ? "jpg"
        : mime.includes("webp") ? "webp"
        : mime.includes("gif") ? "gif"
        : "png";
      const screenshotsDir = join(app.getPath("userData"), "screenshots");
      await mkdir(screenshotsDir, { recursive: true });
      const filePath = join(screenshotsDir, `paste-${Date.now()}.${ext}`);
      await writeFile(filePath, Buffer.from(b64, "base64"));
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle("overlay:set-width", (_event, width) => {
    if (!overlayWindow) return;
    const currentBounds = overlayWindow.getBounds();
    const display = screen.getDisplayMatching(currentBounds);

    // Keep the overlay's left edge anchored to its current position within
    // the active display, but clamp it so the resized window still fits.
    const workArea = display.workArea;
    const minX = workArea.x;
    const maxX = workArea.x + workArea.width - width;
    const newX = Math.min(Math.max(currentBounds.x, minX), Math.max(minX, maxX));

    const height = currentBounds.height > 0 ? currentBounds.height : 40;
    const y = currentBounds.y > 0 ? currentBounds.y : workArea.y + 12;

    const targetBounds = { x: newX, y, width, height };
    console.log("[Orbit Main] IPC: setting bounds to:", targetBounds);
    overlayWindow.setBounds(targetBounds);
  });

  // Snap the overlay onto whichever monitor the cursor is currently on.
  // Useful when the user wants a quick "bring it to me" without dragging.
  ipcMain.handle("overlay:snap-to-cursor", () => {
    if (!overlayWindow) return { ok: false };
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const b = overlayWindow.getBounds();
    const calc = getOverlayBounds({ displayWidth: display.workAreaSize.width, displayHeight: display.workAreaSize.height, state: "mission-control" });
    overlayWindow.setBounds({
      x: display.workArea.x + calc.x,
      y: display.workArea.y + calc.y,
      width: b.width,
      height: b.height
    });
    scheduleWindowStateSave();
    return { ok: true, displayId: display.id };
  });
  ipcMain.handle("ai:send", async (event, payload) => {
    const { model, messages, screenshotPath, agentMode, streamId, workspaceContext, mode, whisperLanguage } = payload ?? {};
    const { imageBase64, mimeType } = await loadScreenshotBase64(screenshotPath);

    const onChunk = streamId
      ? (text) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("ai:chunk", { streamId, text });
          }
        }
      : undefined;

    const onUsage = (payload) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("ai:usage", { streamId, ...payload });
      }
    };

    // Register an AbortController for this stream so the renderer can cancel
    // it via ai:abort. Cleared on completion (success or failure).
    const controller = new AbortController();
    if (streamId) activeStreams.set(streamId, controller);

    try {
      const reply = await sendToModel({
        model, messages, imageBase64, mimeType,
        agentMode, onChunk, onUsage, workspaceContext, mode, whisperLanguage,
        abortSignal: controller.signal
      });
      return { ok: true, content: reply };
    } catch (error) {
      const msg = error?.message || String(error);
      if (msg === "STOPPED") {
        return { ok: false, error: "Stopped", stopped: true };
      }
      return { ok: false, error: msg };
    } finally {
      if (streamId) activeStreams.delete(streamId);
    }
  });

  ipcMain.handle("ai:abort", (_event, { streamId } = {}) => {
    const ctrl = streamId && activeStreams.get(streamId);
    if (ctrl) {
      ctrl.abort("user-stop");
      activeStreams.delete(streamId);
      return { ok: true };
    }
    return { ok: false, error: "no-active-stream" };
  });

  ipcMain.handle("ai:transcribe", async (_event, payload) => {
    const { audioBase64, mimeType } = payload ?? {};

    // Debug: save the latest recording to disk so we can verify what the
    // microphone actually captured. Path is printed to console.
    try {
      if (audioBase64) {
        const debugDir = join(app.getPath("userData"), "voice-debug");
        await mkdir(debugDir, { recursive: true });
        const ext = (mimeType || "audio/webm").includes("ogg") ? "ogg" : "webm";
        const filePath = join(debugDir, `clip-${Date.now()}.${ext}`);
        await writeFile(filePath, Buffer.from(audioBase64, "base64"));
        console.log(`[Voice Debug] saved recording: ${filePath} (${Buffer.from(audioBase64, "base64").length} bytes, mime=${mimeType})`);
      }
    } catch (e) {
      console.log("[Voice Debug] failed to save clip:", e?.message);
    }

    try {
      const transcription = await transcribeAudioGCP({ audioBase64, mimeType });
      return { ok: true, transcription: transcription.trim() };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle("workspace:select-dir", async () => {
    const result = await dialog.showOpenDialog(overlayWindow, {
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle("workspace:get-active-agents-count", () => {
    return activeBackgroundAgents.size;
  });

  ipcMain.handle("workspace:get-info", async (_event, workspacePath) => {
    if (workspacePath) {
      activeWorkspacePath = normalizeWorkspaceRoot(workspacePath);
    }
    if (!activeWorkspacePath) {
      activeWorkspacePath = normalizeWorkspaceRoot(process.cwd());
    }
    try {
      const files = await listFilesSafe(activeWorkspacePath, activeWorkspacePath);
      const parts = activeWorkspacePath.split(/[/\\]/);
      const name = parts[parts.length - 1] || activeWorkspacePath;
      return {
        path: activeWorkspacePath,
        name,
        files
      };
    } catch (error) {
      return { path: activeWorkspacePath, name: "Unknown", files: [], error: error.message };
    }
  });

  ipcMain.handle("workspace:read-file", async (_event, { workspacePath, relativePath }) => {
    let target;
    try {
      target = resolveInsideWorkspace(workspacePath || activeWorkspacePath, relativePath);
    } catch (error) {
      return { ok: false, error: error.message };
    }
    try {
      const content = await readFile(target.fullPath, "utf8");
      return { ok: true, content };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  // Grep-style search across the open workspace. Used by the model to locate
  // symbols/strings/imports without burning round-trips on read_file. Reuses
  // listFilesSafe so the same exclusion list (node_modules, dist, dotdirs,
  // non-text extensions) applies automatically.
  ipcMain.handle("workspace:search", async (_event, { workspacePath, query, isRegex, caseSensitive, maxMatches }) => {
    const root = normalizeWorkspaceRoot(workspacePath || activeWorkspacePath);
    if (!root) {
      return { ok: false, error: "No workspace is open. Ask the user to open a workspace first." };
    }
    if (typeof query !== "string" || !query.trim()) {
      return { ok: false, error: "Empty search query." };
    }
    const limit = Math.min(Math.max(parseInt(maxMatches, 10) || 80, 1), 300);

    let matcher;
    try {
      matcher = isRegex
        ? new RegExp(query, caseSensitive ? "" : "i")
        : null;
    } catch (err) {
      return { ok: false, error: `Invalid regex: ${err.message}` };
    }
    const needle = caseSensitive ? query : query.toLowerCase();

    try {
      const files = await listFilesSafe(root, root);
      const results = [];
      let scanned = 0;
      let truncated = false;
      for (const f of files) {
        if (results.length >= limit) { truncated = true; break; }
        let content;
        try {
          const target = resolveInsideWorkspace(root, f.path);
          content = await readFile(target.fullPath, "utf8");
        } catch {
          continue;
        }
        scanned++;
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const hay = caseSensitive ? line : line.toLowerCase();
          const hit = matcher ? matcher.test(line) : hay.includes(needle);
          if (hit) {
            results.push({
              path: f.path,
              line: i + 1,
              text: line.length > 240 ? line.slice(0, 240) + "…" : line
            });
            if (results.length >= limit) { truncated = true; break; }
          }
        }
      }
      return { ok: true, results, scanned, truncated, query };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("workspace:write-file", async (_event, { workspacePath, relativePath, content }) => {
    // Refuse to write if no workspace was ever opened. Otherwise we'd silently
    // create files inside Orbit's own install directory, which is confusing
    // ("the AI said it created the file but it's not in my project!").
    const root = normalizeWorkspaceRoot(workspacePath || activeWorkspacePath);
    if (!root) {
      return { ok: false, error: "No workspace is open. Click the folder icon in the overlay and select a project directory first." };
    }
    let target;
    try {
      target = resolveInsideWorkspace(root, relativePath);
    } catch (error) {
      return { ok: false, error: error.message };
    }
    // Capture previous content for the undo timeline.
    let prevContent = null;
    let existedBefore = false;
    try {
      prevContent = await readFile(target.fullPath, "utf8");
      existedBefore = true;
    } catch { /* file didn't exist — that's fine */ }

    try {
      await mkdir(dirname(target.fullPath), { recursive: true });
      await writeFile(target.fullPath, content ?? "", "utf8");
      console.log(`[Workspace] wrote ${target.fullPath} (${(content ?? "").length} bytes)`);
      // Record on the timeline so the user can revert via /revert or the UI.
      try {
        const tlPath = join(target.root, ".orbit", "timeline.json");
        await mkdir(dirname(tlPath), { recursive: true });
        let timeline = [];
        try { timeline = JSON.parse(await readFile(tlPath, "utf8")); } catch { timeline = []; }
        const snapshot = createTimelineSnapshot(target.relativePath, prevContent);
        timeline.push({
          ts: new Date().toISOString(),
          agentId: "foreground",
          op: "write_file",
          path: target.relativePath,
          existedBefore,
          ...snapshot,
          newLen: (content ?? "").length
        });
        if (timeline.length > 200) timeline = timeline.slice(-200);
        await writeFile(tlPath, JSON.stringify(timeline, null, 2), "utf8");
      } catch (tlErr) {
        console.warn(`[Workspace] timeline write failed: ${tlErr.message}`);
      }
      return { ok: true };
    } catch (error) {
      console.warn(`[Workspace] write failed for ${target.fullPath}: ${error.message}`);
      return { ok: false, error: error.message };
    }
  });

  // ─── Agent timeline / undo ────────────────────────────────────────────
  ipcMain.handle("agent:list-timeline", async (_event, { workspacePath } = {}) => {
    const root = normalizeWorkspaceRoot(workspacePath || activeWorkspacePath);
    if (!root) return { ok: false, error: "No workspace open." };
    try {
      const tlPath = join(root, ".orbit", "timeline.json");
      const raw = await readFile(tlPath, "utf8");
      return { ok: true, timeline: JSON.parse(raw) };
    } catch (err) {
      if (err.code === "ENOENT") return { ok: true, timeline: [] };
      return { ok: false, error: err.message };
    }
  });

  // ─── Plugin discovery ─────────────────────────────────────────────────
  // Plugins live under {userData}/plugins/*.js. Each plugin is an ES module
  // with a default export shape:
  //   {
  //     name: "my-plugin",
  //     slashCommands: [{ name: "/hello", desc: "...", run: async (api, args) => {} }]
  //   }
  // We can't directly require user-supplied code from the main process
  // safely, so the renderer dynamic-imports each file:// URL we hand back.
  ipcMain.handle("plugins:list", async () => {
    try {
      const dir = join(app.getPath("userData"), "plugins");
      await mkdir(dir, { recursive: true });
      const entries = await readdir(dir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile() && e.name.endsWith(".js"))
        .map((e) => ({
          name: e.name,
          url: "file://" + join(dir, e.name).replace(/\\/g, "/")
        }));
      return { ok: true, dir, plugins: files };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("agent:revert-write", async (_event, { workspacePath, index } = {}) => {
    const root = normalizeWorkspaceRoot(workspacePath || activeWorkspacePath);
    if (!root) return { ok: false, error: "No workspace open." };
    try {
      const tlPath = join(root, ".orbit", "timeline.json");
      const timeline = JSON.parse(await readFile(tlPath, "utf8"));
      const entry = timeline[index];
      if (!entry || entry.op !== "write_file") {
        return { ok: false, error: "No revertable entry at that index." };
      }
      const { fullPath } = resolveInsideWorkspace(root, entry.path);
      if (!entry.existedBefore) {
        // Newly created — delete it.
        try { await (await import("node:fs/promises")).unlink(fullPath); } catch {}
      } else {
        if (typeof entry.prevContent !== "string") {
          return {
            ok: false,
            error: `Cannot revert "${entry.path}" because previous content was ${entry.prevContentStatus || "not stored"}.`
          };
        }
        await writeFile(fullPath, entry.prevContent ?? "", "utf8");
      }
      // Mark entry as reverted so the UI can show it.
      timeline[index] = { ...entry, reverted: true, revertedAt: new Date().toISOString() };
      await writeFile(tlPath, JSON.stringify(timeline, null, 2), "utf8");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Type text into another window using PowerShell SendKeys. Windows-only
   // but no native module needed. Returns { ok, error? }. If windowTitle is omitted,
   // types directly into the currently active/focused window.
   //
   // `lineBreak` controls how embedded \n in `text` is handled when typing:
   //   "enter" (default): each line is typed, then {ENTER} — good for text boxes
   //   "tab":             each line is typed, then {TAB} — good for PDF form fields
   //   "none":            \n is stripped (single-line typing)
   // `lineDelayMs` waits between lines so the editor's cursor/field can advance.
  ipcMain.handle("desktop:type-text", async (_event, { windowTitle, text, lineBreak, lineDelayMs }) => {
    if (typeof text !== "string") {
      return { ok: false, error: "Missing text" };
    }

    const isTargetingActive = !windowTitle || !windowTitle.trim();

    if (isTargetingActive) {
      if (overlayWindow && overlayWindow.isVisible()) {
        overlayWindow.hide();
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }

    // Single-quote escape for PowerShell string literals: '' is the only way
    // to embed a literal single quote inside a '...' string.
    const psString = (s) => `'${s.replace(/'/g, "''")}'`;

    // SendKeys treats these as control characters; wrap each literal in {} so
    // they are typed as themselves. We must preserve real SendKeys directives
    // (e.g. {ENTER}, {TAB}, {F2}, {BACKSPACE}, {LEFT 5}) — the AI emits these
    // intentionally — so detect them first and only escape everything else.
    const DIRECTIVE_RE = /\{[A-Z][A-Z0-9]*(?: \d+)?\}/g;
    const escapeMeta = (s) => s.replace(/[+^%~()[\]{}]/g, (c) => `{${c}}`);
    const escapeSendKeys = (s) => {
      let out = "";
      let i = 0;
      DIRECTIVE_RE.lastIndex = 0;
      let m;
      while ((m = DIRECTIVE_RE.exec(s)) !== null) {
        out += escapeMeta(s.slice(i, m.index));
        out += m[0];
        i = m.index + m[0].length;
      }
      out += escapeMeta(s.slice(i));
      return out;
    };

    const mode = lineBreak === "tab" ? "tab" : lineBreak === "none" ? "none" : "enter";
    const delay = Number.isFinite(lineDelayMs) ? Math.max(0, Math.min(2000, lineDelayMs)) : 60;

    // Normalize newlines, then split. \r\n and \r both become \n first.
    const normalized = text.replace(/\r\n?/g, "\n");
    const segments = mode === "none" ? [normalized.replace(/\n/g, "")] : normalized.split("\n");

    const lines = [
      "Add-Type -AssemblyName System.Windows.Forms"
    ];

    if (windowTitle && typeof windowTitle === "string" && windowTitle.trim()) {
      lines.push(
        "$wshell = New-Object -ComObject wscript.shell",
        `$title = ${psString(windowTitle)}`,
        "$activated = $wshell.AppActivate($title)",
        "if (-not $activated) {",
        "  $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.IndexOf($title, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1",
        "  if ($proc) { $activated = $wshell.AppActivate($proc.Id) }",
        "}",
        "if (-not $activated) {",
        "  $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -and $_.ProcessName.IndexOf($title, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1",
        "  if ($proc) { $activated = $wshell.AppActivate($proc.Id) }",
        "}",
        "if (-not $activated) { Write-Error 'window-not-found'; exit 1 }",
        "Start-Sleep -Milliseconds 250"
      );
      console.log(`[Orbit Type] window="${windowTitle}" len=${text.length} lines=${segments.length} break=${mode}`);
    } else {
      console.log(`[Orbit Type] active-window len=${text.length} lines=${segments.length} break=${mode}`);
    }

    const advance = mode === "tab" ? "{TAB}" : mode === "enter" ? "{ENTER}" : "";
    segments.forEach((seg, idx) => {
      const escaped = escapeSendKeys(seg);
      if (escaped.length > 0) {
        lines.push(`[System.Windows.Forms.SendKeys]::SendWait(${psString(escaped)})`);
      }
      const isLast = idx === segments.length - 1;
      if (!isLast && advance) {
        lines.push(`[System.Windows.Forms.SendKeys]::SendWait('${advance}')`);
        if (delay > 0) lines.push(`Start-Sleep -Milliseconds ${delay}`);
      }
    });

    lines.push("Write-Output 'OK'");

    const script = lines.join("\n");
    const result = await runPowerShell(script);

    if (isTargetingActive) {
      if (overlayWindow && !overlayWindow.isVisible()) {
        overlayWindow.showInactive();
      }
    }

    if (!result.ok) {
      const errText = result.stderr || result.error || "";
      const msg = /window-not-found/.test(errText)
        ? `No window matched "${windowTitle}". Open the app and try a more specific title (e.g. part of the window's actual title bar text).`
        : errText.trim() || "PowerShell exited non-zero";
      console.warn(`[Orbit Type] failed: ${msg}`);
      return { ok: false, error: msg };
    }
    console.log(`[Orbit Type] ok`);
    return { ok: true };
  });

  // Enumerate all running applications with visible top-level windows on the
  // user's desktop. Returns an array of { title, processName, pid } objects so
  // the model can pick a real, currently-open window to target with
  // <type_text> instead of guessing a hard-coded title like "Notepad".
  ipcMain.handle("desktop:list-windows", async () => {
    const script = [
      "$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim().Length -gt 0 }",
      "$out = $procs | Select-Object -Property @{Name='title';Expression={$_.MainWindowTitle}}, @{Name='processName';Expression={$_.ProcessName}}, @{Name='pid';Expression={$_.Id}}",
      "$out | ConvertTo-Json -Compress -Depth 3"
    ].join("\n");

    const result = await runPowerShell(script);
    if (!result.ok) {
      const msg = (result.stderr || result.error || "").trim() || "PowerShell exited non-zero";
      console.warn(`[Orbit ListWindows] failed: ${msg}`);
      return { ok: false, error: msg, windows: [] };
    }
    const raw = (result.stdout || "").trim();
    if (!raw) {
      return { ok: true, windows: [] };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `Failed to parse window list: ${err.message}`, windows: [] };
    }
    const windows = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((w) => w && typeof w.title === "string")
      .map((w) => ({
        title: w.title,
        processName: w.processName || "",
        pid: typeof w.pid === "number" ? w.pid : Number(w.pid) || 0
      }));
    console.log(`[Orbit ListWindows] returned ${windows.length} windows`);
    return { ok: true, windows };
  });

  // Open external browser for the user using Electron's shell module.
  ipcMain.handle("desktop:open-browser", async (_event, { url }) => {
    if (!isAllowedExternalUrl(url)) {
      return { ok: false, error: "Only http:// and https:// URLs can be opened externally." };
    }
    try {
      await shell.openExternal(url);
      console.log(`[Orbit Browser] Opened external URL: ${url}`);
      return { ok: true };
    } catch (err) {
      console.warn(`[Orbit Browser] Failed to open external URL ${url}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  // Deploy an autonomous background agent runner.
  ipcMain.handle("workspace:deploy-agent", async (_event, { workspacePath, task, model }) => {
    const root = normalizeWorkspaceRoot(workspacePath || activeWorkspacePath);
    if (!root) {
      return { ok: false, error: "No workspace is open. Select a workspace folder first." };
    }
    if (!task || typeof task !== "string") {
      return { ok: false, error: "Missing or invalid agent task." };
    }

    if (activeBackgroundAgents.size >= 5) {
      return { ok: false, error: "Active concurrent background agents limit reached (maximum 5). Please wait for some agents to finish." };
    }

    const agentId = `agent-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const orbitDir = join(root, ".orbit");
    const logFile = join(orbitDir, `${agentId}.log`);

    try {
      await mkdir(orbitDir, { recursive: true });
      await writeFile(
        logFile,
        `================================================================================\nInitializing background agent ${agentId}...\nTask: ${task}\nStarted At: ${new Date().toISOString()}\n================================================================================\n\n`,
        "utf8"
      );

      const runnerScript = join(__dirname, "agent-runner.js");
      console.log(`[Orbit Main] Spawning background agent. Runner: ${runnerScript}, Workspace: ${root}, AgentID: ${agentId}, Log: ${logFile}, Model: ${model || "(default)"}`);

      const child = spawn(process.execPath, [runnerScript, root, task, agentId, logFile, model || ""], {
        cwd: root,
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });

      child.unref();

      activeBackgroundAgents.set(agentId, child);
      child.on("exit", () => {
        activeBackgroundAgents.delete(agentId);
      });

      return { ok: true, agentId, logPath: logFile };
    } catch (err) {
      console.warn(`[Orbit Main] Failed to deploy background agent: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("workspace:run-command", async (_event, { workspacePath, command }) => {
    const root = normalizeWorkspaceRoot(workspacePath || activeWorkspacePath);
    if (!root) {
      return { ok: false, exitCode: 1, stdout: "", stderr: "", error: "No workspace is open." };
    }
    if (typeof command !== "string" || !command.trim()) {
      return { ok: false, exitCode: 1, stdout: "", stderr: "", error: "Missing or invalid command." };
    }
    return new Promise((resolve) => {
      exec(command, { cwd: root, env: { ...process.env, PAGER: "cat" }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          exitCode: error ? error.code : 0,
          stdout: stdout || "",
          stderr: stderr || "",
          error: error ? error.message : null
        });
      });
    });
  });

  ipcMain.handle("desktop:click-pixel", async (_event, { x, y }) => {
    if (typeof x !== "number" || typeof y !== "number") {
      return { ok: false, error: "Invalid coordinates" };
    }
    if (x < 0 || y < 0 || x > 30000 || y > 30000) {
      return { ok: false, error: `Coordinates out of range: (${x}, ${y})` };
    }

    // user32.dll mouse_event constants:
    //   MOUSEEVENTF_LEFTDOWN = 0x0002
    //   MOUSEEVENTF_LEFTUP   = 0x0004
    // The Add-Type DllImport block must be compiled BEFORE we call the
    // static method. With -EncodedCommand the whole script runs as one block
    // so this is reliable; via stdin it sometimes wasn't.
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetCursorPos(int X, int Y);
"@ -Name "OrbitMouse" -Namespace "OrbitWin32"
# Declare this PowerShell process DPI-aware so (X,Y) are interpreted as
# physical pixels — matching the screenshot we captured at physical-pixel
# resolution. Without this, on a 150%-scaled display the cursor lands at
# roughly 2/3 of the intended position. SetCursorPos is the canonical
# low-level call; Forms.Cursor.Position is left as a belt-and-suspenders.
[OrbitWin32.OrbitMouse]::SetProcessDPIAware() | Out-Null
[OrbitWin32.OrbitMouse]::SetCursorPos(${x}, ${y}) | Out-Null
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
Start-Sleep -Milliseconds 80
[OrbitWin32.OrbitMouse]::mouse_event(0x0002, 0, 0, 0, 0)
Start-Sleep -Milliseconds 50
[OrbitWin32.OrbitMouse]::mouse_event(0x0004, 0, 0, 0, 0)
Write-Output 'OK'
`.trim();

    console.log(`[Orbit Click] at (${x}, ${y})`);

    // Make the overlay click-through for the duration of the click so the
    // cursor lands on whatever window is underneath instead of Orbit's own
    // GUI. Without this, if (x, y) falls inside the overlay's bounds the
    // click is consumed by the overlay (selects a button, opens a menu, etc).
    // forward:true keeps mouse-move events flowing to the renderer so hover
    // styling doesn't get stuck after we restore.
    let restoreOverlay = null;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      try {
        overlayWindow.setIgnoreMouseEvents(true, { forward: true });
        restoreOverlay = () => {
          try { overlayWindow.setIgnoreMouseEvents(false); } catch {}
        };
      } catch (err) {
        console.warn("[Orbit Click] could not set overlay click-through:", err.message);
      }
    }

    try {
      const result = await runPowerShell(script);
      if (!result.ok) {
        const msg = (result.stderr || result.error || "PowerShell exited non-zero").trim();
        console.warn(`[Orbit Click] failed: ${msg}`);
        return { ok: false, error: msg };
      }
      console.log(`[Orbit Click] ok`);
      return { ok: true };
    } finally {
      if (restoreOverlay) restoreOverlay();
    }
  });

  ipcMain.on("window:drag", (event, { deltaX, deltaY }) => {
    if (!overlayWindow) return;
    const { x, y, width, height } = overlayWindow.getBounds();
    overlayWindow.setBounds({
      x: x + deltaX,
      y: y + deltaY,
      width,
      height
    });
  });
}


// Whisper's HF Transformers model files land in Chromium's Service Worker
// CacheStorage. Stale dtype/model variants accumulate forever and have grown
// past 1.9 GB in the wild. Evict the whole cache when it exceeds the cap —
// the active model just re-downloads (~80 MB for q4 whisper-base.en).
const SW_CACHE_MAX_BYTES = 300 * 1024 * 1024;
function sweepServiceWorkerCacheIfOversized() {
  const cacheDir = join(app.getPath("userData"), "Service Worker", "CacheStorage");
  if (!existsSync(cacheDir)) return;
  let total = 0;
  const walk = (p) => {
    for (const name of readdirSync(p)) {
      const full = join(p, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else total += st.size;
      if (total > SW_CACHE_MAX_BYTES) throw "OVERSIZED";
    }
  };
  try { walk(cacheDir); } catch (e) {
    if (e === "OVERSIZED") {
      try {
        rmSync(cacheDir, { recursive: true, force: true });
        console.log("[Orbit Main] cleared oversized Service Worker CacheStorage");
      } catch (err) {
        console.warn("[Orbit Main] failed to clear SW cache:", err.message);
      }
    }
  }
}

// Prune userData/screenshots so it doesn't grow without bound. Keeps the most
// recent N files, deletes the rest. Best-effort — never throws to the app.
async function pruneScreenshotsDir(maxKeep = 100) {
  try {
    const dir = join(app.getPath("userData"), "screenshots");
    if (!existsSync(dir)) return;
    const names = await readdir(dir);
    if (names.length <= maxKeep) return;
    const stats = await Promise.all(
      names.map(async (n) => ({ name: n, mtimeMs: (await statAsync(join(dir, n))).mtimeMs }))
    );
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const toDelete = stats.slice(maxKeep);
    await Promise.all(toDelete.map((s) => unlink(join(dir, s.name)).catch(() => {})));
    if (toDelete.length > 0) {
      console.log(`[Orbit Main] Pruned ${toDelete.length} old screenshot(s) (kept ${maxKeep}).`);
    }
  } catch (err) {
    console.warn(`[Orbit Main] Screenshot prune failed: ${err.message}`);
  }
}

app.whenReady().then(async () => {
  console.log("[Orbit Main] app whenReady fired.");
  sweepServiceWorkerCacheIfOversized();
  pruneScreenshotsDir().catch(() => {});

  // Set up microphone / audio permissions in Electron session
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    console.log(`[Orbit Main] Permission request for: ${permission}`);
    if (permission === "media" || permission === "audioCapture" || permission === "audio") {
      callback(true);
    } else {
      callback(false);
    }
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, origin) => {
    console.log(`[Orbit Main] Permission check for: ${permission}`);
    if (permission === "media" || permission === "audioCapture" || permission === "audio") {
      return true;
    }
    return false;
  });

  historyStore = createHistoryStore(join(app.getPath("userData"), "chat-history.json"));
  windowStateStorePath = join(app.getPath("userData"), "window-state.json");
  savedWindowState = await loadSavedWindowState();
  registerIpc();
  createOverlayWindow();
  createSystemTray();
  registerGlobalShortcuts();

  screen.on("display-metrics-changed", () => {
    console.log("[Orbit Main] screen metrics changed");
    // Don't reset to "collapsed" here — that would yank the overlay back to
    // the centered position and lose the user's drag. Only re-clamp if the
    // overlay has been moved entirely off all displays.
    if (!overlayWindow) return;
    const b = overlayWindow.getBounds();
    const stillVisible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x + b.width > a.x && b.x < a.x + a.width &&
             b.y + b.height > a.y && b.y < a.y + a.height;
    });
    if (!stillVisible) {
      console.log("[Orbit Main] overlay drifted off-screen, snapping back");
      setOverlayState("collapsed");
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
