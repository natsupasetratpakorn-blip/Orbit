import { parseAIResponse, renderMarkdown, computeLineDiff, parseQuestions } from "../shared/parser.js";
import { buildInlineToolBadges, streamingToolDisplay } from "../shared/tool-ui.js";
import { parseSlashToolCommand, TOOL_SLASH_COMMANDS } from "../shared/slash-tools.js";
import { transcribeWithWhisper, warmupWhisper } from "./whisper.js";
import { messageNeedsScreen, unsummarizedTail, planSummarization, transcriptFor } from "../shared/memory.js";
import { DEFAULT_MODEL, MODEL_IDS, MODELS } from "../shared/models.js";

// Element Selectors
const overlay = document.querySelector("#overlay");
const bar = document.querySelector("#bar");
const panel = document.querySelector("#panel");
const modelSelectBtn = document.querySelector("#overlayModelSelectBtn");
const modelSelectOptions = document.querySelector("#overlayModelOptions");
const modeSelectBtn = document.querySelector("#overlayModeSelectBtn");
const modeSelectOptions = document.querySelector("#overlayModeOptions");
const promptInput = document.querySelector("#promptInput");
const sendButton = document.querySelector("#sendButton");
const closeButton = document.querySelector("#closeButton");
const statusDot = document.querySelector("#statusDot");
const messages = document.querySelector("#messages");
const panelSubtitle = document.querySelector("#panelSubtitle");

// Coding Automation Selectors
const autoModeButton = document.querySelector("#autoModeButton");
const screenshotToggleButton = document.querySelector("#screenshotToggleButton");
const workspaceButton = document.querySelector("#workspaceButton");
const clearHistoryButton = document.querySelector("#clearHistoryButton");
const widthToggleButton = document.querySelector("#widthToggleButton");
const fullAppButton = document.querySelector("#fullAppButton");
const workspaceDrawer = document.querySelector("#workspaceDrawer");
const workspacePathEl = document.querySelector("#workspacePath");
const changeDirButton = document.querySelector("#changeDirButton");
const fileSearchInput = document.querySelector("#fileSearchInput");
const fileListEl = document.querySelector("#fileList");
const contextTray = document.querySelector("#contextTray");
const attachedFilesEl = document.querySelector("#attachedFiles");

// Premium Voice Selectors
const speakToggleButton = document.querySelector("#speakToggleButton");
const micButton = document.querySelector("#micButton");
const whisperLangBtn = document.querySelector("#whisperLangBtn"); // optional element

// State Variables
let selectedModel = DEFAULT_MODEL;
let chatMessages = [];
let currentMode = "ask"; // "ask", "agents", "planning"
let agentMode = false;
let autoMode = false;
let attachScreenshot = true;  // default on — screen context allowed, but only grabbed when the message needs it
// When true, the very next send captures the screen regardless of the
// message-needs-screen heuristic (set when the user explicitly asks for screen
// context). Consumed and reset on each send.
let forceScreenshotNextSend = false;
// Inline pasted image (Ctrl+V into the prompt). When non-null, it overrides
// the auto-screenshot on the next send and is then cleared.
let pastedImageDataUrl = null;
let pastedImageThumb = null;
// Rolling in-session memory. `conversationSummary` compresses turns older than
// the verbatim window; `summarizedCount` is how many of the oldest messages it
// already covers. Both persist with the chat history.
let conversationSummary = "";
let summarizedCount = 0;
let summarizing = false;

// ─── Session token & cost tracking ──────────────────────────────────────
// Pricing in USD per 1M tokens (rough, public Gemini pricing as of 2026).
// These are estimates — the goal is "give the user a sense of cost", not
// invoice-grade accuracy.
const MODEL_PRICING = {
  "gemini-2.5-flash":       { in: 0.30, out: 2.50 },
  "gemini-2.5-flash-lite":  { in: 0.10, out: 0.40 },
  "gemini-3.5-flash":       { in: 0.30, out: 2.50 },
  "gemini-3.1-flash-lite":  { in: 0.10, out: 0.40 }
};
const MODEL_TO_VERTEX_ID = {
  ...MODEL_IDS
};
let sessionInputTokens = 0;
let sessionOutputTokens = 0;
let sessionCostUsd = 0;
const usageMeterEl = document.querySelector("#usageMeter");

function updateUsageMeter() {
  if (!usageMeterEl) return;
  usageMeterEl.style.display = "none";
}

function recordUsage(payload) {
  const usage = payload?.usage;
  if (!usage) return;
  const inTok = Number(usage.promptTokenCount || 0);
  const outTok = Number(usage.candidatesTokenCount || usage.responseTokenCount || 0);
  sessionInputTokens += inTok;
  sessionOutputTokens += outTok;
  const vertexId = MODEL_TO_VERTEX_ID[payload.model] || MODEL_TO_VERTEX_ID[selectedModel];
  const price = MODEL_PRICING[vertexId] || MODEL_PRICING["gemini-2.5-flash-lite"];
  sessionCostUsd += (inTok / 1_000_000) * price.in + (outTok / 1_000_000) * price.out;
  updateUsageMeter();
}

if (window.orbit.onAIUsage) {
  window.orbit.onAIUsage(recordUsage);
}

// Selection-as-context hotkey (Ctrl+Shift+L globally). Main captures the OS
// selection and forwards the text here — we prefill the prompt with a
// quoted block and focus the input.
if (window.orbit.onSelectionContext) {
  window.orbit.onSelectionContext(({ text }) => {
    if (!text) return;
    const quoted = text.split("\n").map((l) => `> ${l}`).join("\n");
    const existing = promptInput.value.trim();
    promptInput.value = existing ? `${quoted}\n\n${existing}` : `${quoted}\n\n`;
    setOverlayState("expanded");
    promptInput.focus();
    const len = promptInput.value.length;
    promptInput.setSelectionRange(len, len);
    toast("Selection attached as context", { variant: "success" });
  });
}

// ─── Conversation branching ─────────────────────────────────────────────
// Right-click any message → "Fork from here". Snapshots the current chat
// to disk (so nothing is lost), truncates the live conversation to and
// including the clicked message, and re-renders. Subsequent prompts thus
// branch off that point.
function showForkMenu(x, y, messageId) {
  document.querySelectorAll(".context-menu").forEach((m) => m.remove());

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.style.cssText = `
    position: fixed; left: ${x}px; top: ${y}px; z-index: 99999;
    background: var(--bg-strong); color: var(--text);
    border: 1px solid var(--border-strong); border-radius: 8px;
    padding: 4px; min-width: 200px;
    box-shadow: 0 8px 32px var(--shadow);
    font-size: 12px;
  `;

  const item = document.createElement("div");
  item.textContent = "🌿 Fork from here";
  item.style.cssText = "padding: 8px 10px; cursor: pointer; border-radius: 6px;";
  item.addEventListener("mouseenter", () => { item.style.background = "var(--surface-hover)"; });
  item.addEventListener("mouseleave", () => { item.style.background = "transparent"; });
  item.addEventListener("click", async () => {
    menu.remove();
    try {
      const snap = await window.orbit.snapshotHistory({
        selectedModel,
        messages: chatMessages,
        workspacePath,
        forkedAt: messageId,
        forkedAtTime: new Date().toISOString()
      });
      const idx = chatMessages.findIndex((m) => m.id === messageId);
      if (idx === -1) {
        toast("Could not locate that message", { variant: "error" });
        return;
      }
      chatMessages = chatMessages.slice(0, idx + 1);
      cardExecutionStates = {};
      renderMessages();
      await persistHistory();
      const where = snap?.ok ? ` (backup saved)` : "";
      toast(`Forked — conversation truncated${where}`, { variant: "success" });
    } catch (err) {
      toast(`Fork failed: ${err.message}`, { variant: "error" });
    }
  });

  menu.appendChild(item);
  document.body.appendChild(menu);

  // Dismiss on next outside click / escape.
  const dismiss = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener("mousedown", dismiss, true);
      document.removeEventListener("keydown", onKey, true);
    }
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      menu.remove();
      document.removeEventListener("mousedown", dismiss, true);
      document.removeEventListener("keydown", onKey, true);
    }
  };
  setTimeout(() => {
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
}

messages.addEventListener("contextmenu", (event) => {
  const msgEl = event.target.closest(".message[data-msg-id]");
  if (!msgEl) return;
  event.preventDefault();
  showForkMenu(event.clientX, event.clientY, msgEl.dataset.msgId);
});
let agentStepsThisTurn = 0;
const MAX_AGENT_STEPS = 12;
let workspacePath = "";
let workspaceFiles = [];
let selectedFiles = new Set();
let cardExecutionStates = {}; // key: messageId-type-path -> { status, output, error, exitCode }
const READ_ONLY_TOOLS = new Set([
  "read_file", "list_workspace", "list_windows", "search_workspace",
  "list_dir", "git_status", "git_diff", "git_log", "web_search", "deep_research", "read_webpage"
]);
const AUTO_RUN_IN_AGENT_MODE = new Set([
  "execute_command", "write_file", "patch_file",
  "type_text", "click_pixel", "scroll", "keystroke", "focus_window", "wait_ms",
  "open_browser", "open_url", "open_app", "deploy_agent",
  "delete_file", "move_file", "create_directory"
  // deep_research is intentionally NOT here — it's a READ_ONLY_TOOL, so it
  // already auto-runs in every mode. Listing it twice was redundant.
]);
let panelWidthMode = "standard"; // "standard" (600px) or "wide" (850px)
let autoSpeakEnabled = false;
let recognition = null;
let isListening = false;


// Real-time Audio Visualizer State Variables
let audioCtx = null;
let analyser = null;
let visualizerRaf = null;
const visualizerCanvas = document.querySelector("#audioVisualizer");

// Premium Voice & Diff Helper Logic
async function loadDiffData(part, cardKey) {
  if (cardExecutionStates[cardKey].diffLoading || cardExecutionStates[cardKey].diffData) {
    return;
  }
  cardExecutionStates[cardKey].diffLoading = true;
  try {
    const res = await window.orbit.readWorkspaceFile({
      workspacePath,
      relativePath: part.path
    });
    const currentContent = (res && res.ok) ? res.content : "";
    const diffData = computeLineDiff(currentContent, part.content || "");
    cardExecutionStates[cardKey].diffData = diffData;
  } catch (err) {
    console.error("Error computing diff:", err);
    cardExecutionStates[cardKey].diffData = {
      additions: part.content ? part.content.split(/\n/).length : 0,
      deletions: 0,
      diff: (part.content || "").split(/\n/).map(l => ({ type: "added", text: l }))
    };
  } finally {
    cardExecutionStates[cardKey].diffLoading = false;
    renderMessages();
  }
}

function speakText(text) {
  window.speechSynthesis.cancel();
  
  // Filter speech content to read friendly conversational text
  let clean = text.replace(/<write_file[^>]*>([\s\S]*?)<\/write_file>/gi, "")
                  .replace(/<execute_command[^>]*>([\s\S]*?)<\/execute_command>/gi, "")
                  .replace(/<read_file[^>]*>([\s\S]*?)<\/read_file>/gi, "")
                  .replace(/<read_file[^>]*\/>/gi, "")
                  .replace(/<[^>]+>/g, ""); // strip all other tags
  
  // Remove markdown code blocks and symbols
  clean = clean.replace(/```[\s\S]*?```/g, "")
               .replace(/`([^`]+)`/g, "$1")
               .replace(/\*\*([^*]+)\*\*/g, "$1")
               .replace(/^[*-]\s+/gm, "")
               .replace(/^[#]+\s+/gm, "");
               
  clean = clean.trim();
  if (!clean) return;

  const utterance = new SpeechSynthesisUtterance(clean);
  
  // Make sure voices are loaded, browser-native speechSynthesis is highly responsive
  const voices = window.speechSynthesis.getVoices();
  const chosenVoice = voices.find(v => v.lang.startsWith("en-") && v.name.includes("Google")) || 
                      voices.find(v => v.lang.startsWith("en-")) || 
                      voices[0];
  if (chosenVoice) {
    utterance.voice = chosenVoice;
    utterance.lang = chosenVoice.lang;
  }
  utterance.rate = 1.05;
  window.speechSynthesis.speak(utterance);
}

let mediaRecorder = null;
let audioChunks = [];

// Live transcription state. We re-run Whisper on the accumulated audio every
// LIVE_INTERVAL_MS and update the prompt input so text appears as you speak.
let liveTranscribeTimer = null;
let liveTranscribeBusy = false;       // prevents overlapping inferences
let livePrefixText = "";              // anything the user had typed before pressing mic
let liveMimeType = "audio/webm";
// AI response streaming — chunks land in `aiStreamTargetText`, an rAF loop
// types them into `aiStreamTargetEl` at an adaptive rate that catches up
// quickly when chunks arrive in bursts but smooths out single-char drips.
let aiStreamTargetEl = null;
let aiStreamTargetText = "";
let aiStreamDisplayedLen = 0;
let aiStreamRaf = null;
let activeStreamId = null;            // discards chunks from earlier requests
let aiChunkUnsubscribe = null;        // disposes the IPC listener

const LIVE_INTERVAL_MS = 500;
const LIVE_MIN_DURATION_MS = 400;     // first text appears very fast

// Smooth type-in animation. The naive "type N chars per frame" approach makes
// the animation finish in 30ms and then idle for 470ms until the next tick
// arrives — visibly choppy. Instead, we adapt the chars-per-frame so the
// current animation stretches across roughly the same interval as the Whisper
// tick rate, which means the input is always visibly typing.
let smoothTypeTarget = "";
let smoothTypeRaf = null;
let smoothTypeCharsPerFrame = 1;
// Aim to finish the current animation slightly *before* the next tick arrives,
// so there's no idle gap. 80% of LIVE_INTERVAL_MS works well.
const SMOOTH_DURATION_FRACTION = 0.8;

async function toggleSpeechRecognition() {
  if (isListening) {
    stopRecording();
  } else {
    await startRecording();
  }
}

function tickSmoothType() {
  smoothTypeRaf = null;
  const current = promptInput.value;
  if (current === smoothTypeTarget) return;

  // If the target diverges from current (Whisper revised earlier text rather
  // than just appending), snap to the new value — keeps us from going backward.
  if (!smoothTypeTarget.startsWith(current)) {
    promptInput.value = smoothTypeTarget;
    promptInput.setSelectionRange(smoothTypeTarget.length, smoothTypeTarget.length);
    return;
  }

  const nextLen = Math.min(smoothTypeTarget.length, current.length + smoothTypeCharsPerFrame);
  promptInput.value = smoothTypeTarget.slice(0, nextLen);
  promptInput.setSelectionRange(nextLen, nextLen);

  if (nextLen < smoothTypeTarget.length) {
    smoothTypeRaf = requestAnimationFrame(tickSmoothType);
  }
}

function setPromptFromLiveTranscript(transcript) {
  if (!transcript) return;
  const value = livePrefixText ? `${livePrefixText} ${transcript}` : transcript;
  if (value === smoothTypeTarget) return;

  smoothTypeTarget = value;

  // Adapt the chars-per-frame so the new content takes ~SMOOTH_DURATION_FRACTION
  // * LIVE_INTERVAL_MS to render — that way the animation is just finishing as
  // the next Whisper tick arrives, instead of finishing instantly and idling.
  const remaining = smoothTypeTarget.length - promptInput.value.length;
  if (remaining > 0) {
    const targetFrames = Math.max(1, (LIVE_INTERVAL_MS * SMOOTH_DURATION_FRACTION) / 16.67);
    smoothTypeCharsPerFrame = Math.max(1, Math.ceil(remaining / targetFrames));
  }

  if (smoothTypeRaf == null) {
    smoothTypeRaf = requestAnimationFrame(tickSmoothType);
  }
}

// ===== AI response streaming animation =====
function aiStreamTick() {
  aiStreamRaf = null;
  if (!aiStreamTargetEl) return;
  if (aiStreamDisplayedLen >= aiStreamTargetText.length) return;

  // Adaptive: aim to finish what's currently buffered within ~300ms (~18 frames).
  // Burst arrivals → catches up fast. Trickle → 1 char/frame minimum.
  const remaining = aiStreamTargetText.length - aiStreamDisplayedLen;
  const charsThisFrame = Math.max(1, Math.ceil(remaining / 18));
  aiStreamDisplayedLen = Math.min(aiStreamTargetText.length, aiStreamDisplayedLen + charsThisFrame);

  renderStreamingTextContent(aiStreamTargetEl, aiStreamTargetText.slice(0, aiStreamDisplayedLen));
  // Keep the latest text in view inside the chat scroller.
  messages.scrollTop = messages.scrollHeight;

  if (aiStreamDisplayedLen < aiStreamTargetText.length) {
    aiStreamRaf = requestAnimationFrame(aiStreamTick);
  }
}

function appendAIStreamChunk(text) {
  if (!text || !aiStreamTargetEl) return;
  aiStreamTargetText += text;
  if (aiStreamRaf == null) {
    aiStreamRaf = requestAnimationFrame(aiStreamTick);
  }
}

function beginAIStream(targetEl, streamId) {
  aiStreamTargetEl = targetEl;
  aiStreamTargetText = "";
  aiStreamDisplayedLen = 0;
  activeStreamId = streamId;
}

function endAIStream() {
  if (aiStreamRaf != null) {
    cancelAnimationFrame(aiStreamRaf);
    aiStreamRaf = null;
  }
  if (aiStreamTargetEl && aiStreamDisplayedLen < aiStreamTargetText.length) {
    renderStreamingTextContent(aiStreamTargetEl, aiStreamTargetText);
  }
  aiStreamTargetEl = null;
  aiStreamTargetText = "";
  aiStreamDisplayedLen = 0;
  activeStreamId = null;
}

// Singleton chunk listener — installed once, dispatches to the active stream.
function ensureChunkListener() {
  if (aiChunkUnsubscribe) return;
  aiChunkUnsubscribe = window.orbit.onAIChunk((data) => {
    if (!data || data.streamId !== activeStreamId) return;
    appendAIStreamChunk(data.text);
  });
}

function flushSmoothType() {
  if (smoothTypeRaf != null) {
    cancelAnimationFrame(smoothTypeRaf);
    smoothTypeRaf = null;
  }
  if (smoothTypeTarget && promptInput.value !== smoothTypeTarget) {
    promptInput.value = smoothTypeTarget;
    promptInput.setSelectionRange(smoothTypeTarget.length, smoothTypeTarget.length);
  }
}

async function runLiveTranscriptionTick(recordingStartedAt) {
  // Skip if a previous tick is still running, or if we don't have enough audio
  // yet, or if recording has already stopped.
  if (liveTranscribeBusy || !isListening || audioChunks.length === 0) return;
  if (Date.now() - recordingStartedAt < LIVE_MIN_DURATION_MS) return;

  liveTranscribeBusy = true;
  try {
    // Snapshot — chunks may keep accumulating while we transcribe.
    const snapshot = audioChunks.slice();
    const blob = new Blob(snapshot, { type: liveMimeType });
    const transcript = await transcribeWithWhisper(blob);
    if (isListening && transcript) {
      if (livePrefixText.toLowerCase().startsWith("/type")) {
        promptInput.placeholder = `🎤 Typing Preview: ${transcript}`;
      } else {
        setPromptFromLiveTranscript(transcript);
      }
    }
  } catch (e) {
    // Partial WebM blobs occasionally fail to decode mid-stream. Log once but
    // don't surface to the user — the next tick will likely succeed.
    console.debug("[Live Whisper] tick failed:", e?.message);
  } finally {
    liveTranscribeBusy = false;
  }
}

function startLiveTranscription() {
  stopLiveTranscription();
  const startedAt = Date.now();
  liveTranscribeTimer = setInterval(
    () => runLiveTranscriptionTick(startedAt),
    LIVE_INTERVAL_MS
  );
}

function stopLiveTranscription() {
  if (liveTranscribeTimer) {
    clearInterval(liveTranscribeTimer);
    liveTranscribeTimer = null;
  }
}

async function pickBestMicDeviceId() {
  // Enumerate audio inputs and pick the most likely real microphone.
  // Browsers return device labels only after permission has been granted,
  // so we accept the first probe even if labels are empty the first time.
  try {
    // Probe permission so labels become available.
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch { /* user might still pick after this fails */ }

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === "audioinput");

  console.log("[Mic Debug] all audio inputs:");
  for (const d of inputs) {
    console.log(`  - id="${d.deviceId.slice(0, 12)}…" label="${d.label}"`);
  }

  if (inputs.length === 0) return null;

  // Score devices: real hardware first, virtual/duplicate entries last.
  const score = (label) => {
    const l = (label || "").toLowerCase();
    if (!l) return 0;

    // Hard-avoid: virtual mics / loopback / voice changers that have no real audio.
    if (/(voicemod|stereo mix|line in|cable|vb-audio|voicemeeter|virtual|loopback|hdmi|monitor of|nvidia broadcast|krisp)/.test(l)) return -50;

    // Skip duplicate "Default - ..." / "Communications - ..." entries — they point
    // at whichever device Windows has set as default, which is often the wrong one.
    if (l.startsWith("default -") || l.startsWith("communications -")) return -5;

    // Known real-mic brands and headsets get a big boost.
    if (/(razer|blackshark|hyperx|steelseries|sennheiser|shure|blue yeti|samson|rode|audio[- ]technica|airpods|jabra|logitech)/.test(l)) return 100;

    // Generic "Microphone" labels.
    if (/(microphone|mic|headset|bluetooth)/.test(l)) return 10;

    return 1;
  };
  inputs.sort((a, b) => score(b.label) - score(a.label));
  const chosen = inputs[0];
  console.log(`[Mic Debug] choosing: "${chosen.label}" (deviceId=${chosen.deviceId.slice(0, 12)}…)`);
  return chosen.deviceId;
}

async function startRecording() {
  audioChunks = [];
  try {
    const deviceId = await pickBestMicDeviceId();
    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: false,  // Chrome's default NS can silence quiet speakers
      autoGainControl: true,    // Boost low-level audio so STT has signal to work with
      channelCount: 1,
      sampleRate: 48000
    };
    if (deviceId) {
      audioConstraints.deviceId = { exact: deviceId };
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

    // Log the actual track that ended up being used.
    const track = stream.getAudioTracks()[0];
    if (track) {
      const settings = track.getSettings();
      console.log(`[Mic Debug] active track: label="${track.label}" deviceId=${(settings.deviceId || "").slice(0, 12)}… sampleRate=${settings.sampleRate}`);
    }
    
    let mimeType = "audio/webm";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
      mimeType = "audio/webm;codecs=opus";
    }
    
    mediaRecorder = new MediaRecorder(stream, { mimeType });
    liveMimeType = mimeType;
    livePrefixText = promptInput.value.trim();
    smoothTypeTarget = promptInput.value; // start animation aligned with current input
    let startVisualizer = () => {};

    // Set up Web Audio API Frequency Visualizer on Canvas
    if (visualizerCanvas) {
      visualizerCanvas.style.display = "block";
      const dpr = window.devicePixelRatio || 1;
      const ctx = visualizerCanvas.getContext("2d");

      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        let lastVolume = 0.08;
        function drawVisuals() {
          if (!isListening) return;
          visualizerRaf = requestAnimationFrame(drawVisuals);

          // Dynamically scale/read dimensions after layout pass resolves
          const w = visualizerCanvas.clientWidth;
          const h = visualizerCanvas.clientHeight;
          if (w > 0 && h > 0) {
            if (visualizerCanvas.width !== w * dpr || visualizerCanvas.height !== h * dpr) {
              visualizerCanvas.width = w * dpr;
              visualizerCanvas.height = h * dpr;
              ctx.scale(dpr, dpr);
            }
          }

          analyser.getByteFrequencyData(dataArray);
          ctx.clearRect(0, 0, w, h);

          // Focus on active speech frequencies (first 40% of bins) to get a high-fidelity volume signal
          let sum = 0;
          const activeBins = Math.floor(bufferLength * 0.4);
          for (let i = 0; i < activeBins; i++) {
            sum += dataArray[i];
          }
          const average = sum / Math.max(1, activeBins);

          // Noise gate: ignore quiet background hums (average < 10)
          const noiseGate = 10.0;
          const activeSignal = Math.max(0, average - noiseGate);

          // Compress dynamic range using Square Root scaling (prevents frantic visual clipping)
          const targetVolume = 0.08 + Math.sqrt(activeSignal) * 0.16;

          // Linear interpolation (smoothing filter) for liquid, premium transitions
          lastVolume += (targetVolume - lastVolume) * 0.14; // 14% speed for buttery-smooth transitions
          const volume = lastVolume;

          const time = Date.now() * 0.0035;

          // Build a horizontal gradient once per frame so each wave layer picks
          // up a cool silver→blue→silver shimmer instead of flat white.
          const grad = ctx.createLinearGradient(0, 0, w, 0);
          grad.addColorStop(0.0, "rgba(180, 200, 255, 0.0)");
          grad.addColorStop(0.2, "rgba(190, 210, 255, 0.9)");
          grad.addColorStop(0.5, "rgba(255, 255, 255, 0.95)");
          grad.addColorStop(0.8, "rgba(170, 200, 255, 0.9)");
          grad.addColorStop(1.0, "rgba(180, 200, 255, 0.0)");

          // We draw 3 beautiful, overlapping wave layers with organic flow.
          // Layer 1: Soft backdrop (deep silver)
          drawSiriLikeWave(ctx, w, h, volume, time, 0.95, 0.40, "rgba(170, 200, 255, 0.14)", 1.0, 0);

          // Layer 2: Middle layer (cool gradient)
          drawSiriLikeWave(ctx, w, h, volume, time * -1.15, 1.45, 0.65, grad, 1.2, 4);

          // Layer 3: Sharp foreground (crisp gradient with glow)
          drawSiriLikeWave(ctx, w, h, volume, time * 1.45, 2.1, 0.95, grad, 1.6, 7);

          // Center pulse dot — a soft glowing core that breathes with the voice.
          // Capped to the canvas half-height so it never clips on the short bar.
          const pr = Math.min(h / 2 - 0.5, 1.2 + volume * 6);
          ctx.beginPath();
          ctx.fillStyle = "rgba(220, 230, 255, 0.9)";
          ctx.shadowColor = "rgba(150, 190, 255, 0.9)";
          ctx.shadowBlur = 8 + volume * 14;
          ctx.arc(w / 2, h / 2, pr, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }

        function drawSiriLikeWave(ctx, w, h, volume, timeShift, freqScale, ampScale, strokeStyle, lineWidth, glow) {
          ctx.beginPath();
          ctx.lineWidth = lineWidth;
          ctx.strokeStyle = strokeStyle;
          ctx.lineCap = "round";
          if (glow) {
            ctx.shadowColor = "rgba(150, 190, 255, 0.85)";
            ctx.shadowBlur = glow;
          } else {
            ctx.shadowBlur = 0;
          }

          const sliceWidth = w / bufferLength;
          let x = 0;

          for (let i = 0; i < bufferLength; i++) {
            // Taper wave to 0 at left and right edges (symmetric envelope)
            const envelope = Math.sin((i / (bufferLength - 1)) * Math.PI);
            
            // Multiple overlapping sine components for natural/complex voice ripples
            const angle = (i * 0.14 * freqScale) + timeShift;
            // Enhanced baseline swing: (h / 2.2) is the vertical center constraint
            const waveY = Math.sin(angle) * Math.cos(angle * 0.38) * (h / 2.1) * volume * ampScale * envelope;
            
            const y = (h / 2) + waveY;

            if (i === 0) {
              ctx.moveTo(x, y);
            } else {
              const xc = x + sliceWidth / 2;
              const yc = y;
              ctx.quadraticCurveTo(x, y, xc, yc);
            }
            x += sliceWidth;
          }
          ctx.stroke();
          ctx.shadowBlur = 0;
        }

        startVisualizer = drawVisuals;
      } catch (err) {
        console.warn("[Visualizer] initialization failed:", err?.message);
      }
    }

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      stopLiveTranscription();
      const audioBlob = new Blob(audioChunks, { type: mimeType });
      
      // Stop stream tracks to free up the microphone immediately
      stream.getTracks().forEach(track => track.stop());

      // Teardown the audio visualizer Renders
      if (visualizerRaf) {
        cancelAnimationFrame(visualizerRaf);
        visualizerRaf = null;
      }
      if (audioCtx) {
        audioCtx.close().catch(() => {});
        audioCtx = null;
      }
      if (visualizerCanvas) {
        visualizerCanvas.style.display = "none";
      }
      
      micButton.classList.remove("is-listening");
      micButton.title = "Transcribing locally with Whisper...";
      promptInput.placeholder = "Transcribing with Whisper...";

      try {
        const transcript = await transcribeWithWhisper(audioBlob, {
          onProgress: (p) => {
            if (p.status === "progress" && p.file && p.progress != null) {
              const pct = Math.round(p.progress);
              promptInput.placeholder = `Downloading Whisper model… ${pct}%`;
            } else if (p.status === "ready") {
              promptInput.placeholder = "Transcribing with Whisper...";
            }
          }
        });

        if (transcript) {
          // OPTION 3: Dictate-to-Active-Editor Mode (/type)
          if (livePrefixText.toLowerCase().startsWith("/type")) {
            const typedText = transcript.trim();
            toast(`Dictation typed: "${typedText.slice(0, 30)}..."`, { variant: "success", duration: 3000 });
            
            // Keep prompt bar as "/type " for repeating dictation session
            promptInput.value = "/type ";
            smoothTypeTarget = "/type ";
            
            // Invoke the PowerShell typing tool on focused window
            await window.orbit.typeIntoWindow({ text: typedText });
            promptInput.focus();
            return;
          }

          // Live transcription has been updating the input as you spoke. The
          // final pass is more accurate than any intermediate tick — replace
          // with prefix + final transcript so we don't double-concatenate.
          setPromptFromLiveTranscript(transcript);
          flushSmoothType(); // snap to final instantly, no half-typed transcript
          promptInput.focus();
        } else {
          console.warn("Whisper returned empty — no speech detected.");
          promptInput.placeholder = "No speech detected — try again";
          setTimeout(() => {
            promptInput.placeholder = "Ask with screen context...";
          }, 2500);
        }
      } catch (err) {
        console.error("Whisper failed:", err);
        promptInput.placeholder = `Whisper error: ${(err?.message || "").slice(0, 60)}`;
        setTimeout(() => {
          promptInput.placeholder = "Ask with screen context...";
        }, 4000);
      } finally {
        promptInput.placeholder = "Ask with screen context...";
        micButton.title = "Voice Input (Dictate prompt)";
      }
    };
    
    // 500 ms timeslice so ondataavailable fires regularly during recording,
    // which is what makes the live transcription loop possible.
    mediaRecorder.start(500);
    isListening = true;
    micButton.classList.add("is-listening");
    micButton.title = "Recording... Click again to stop";
    startLiveTranscription();
    startVisualizer();
  } catch (err) {
    console.error("Microphone access denied or failed:", err);
    micButton.title = "Microphone access denied.";
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  isListening = false;
}

// Helper Utilities
function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function setStatus(mode) {
  statusDot.dataset.mode = mode;
  statusDot.setAttribute("aria-label", mode === "working" ? "Working" : "Ready");
}

// Override the global window.confirm / window.alert so ANY accidental call —
// from our own code, a library, an inline handler — gets routed through the
// custom Orbit modal instead of showing the ugly OS-default dialog.
// confirm() returns boolean and is normally synchronous; we can't fake sync
// since the custom modal is async. We return a thenable that also coerces
// to `false` immediately if used as a bare value (best we can do without
// rewriting every call site).
const _nativeConfirm = window.confirm.bind(window);
const _nativeAlert = window.alert.bind(window);
window.confirm = (message) => {
  // Return a Promise so `await confirm("...")` works. Bare `if (confirm())`
  // will see a truthy Promise object — caller should await.
  return customConfirm({ title: "Confirm", message: String(message || "") });
};
window.alert = (message) => {
  return customConfirm({
    title: "Notice",
    message: String(message || ""),
    confirmText: "OK",
    cancelText: ""
  });
};
// Keep references in case anything needs to bypass intentionally.
window.__nativeConfirm = _nativeConfirm;
window.__nativeAlert = _nativeAlert;

// Custom in-app confirm dialog. Replaces native confirm() which steals
// Electron focus (input goes dead after dismiss) and looks like an OS popup.
// Returns Promise<boolean>.
function customConfirm({ title, message, confirmText = "Confirm", cancelText = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");

    const modal = document.createElement("div");
    modal.className = "modal";

    const h = document.createElement("h3");
    h.className = "modal-title";
    h.textContent = title || "Are you sure?";

    const p = document.createElement("p");
    p.className = "modal-message";
    p.textContent = message || "";

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "modal-btn cancel";
    cancelBtn.type = "button";
    cancelBtn.textContent = cancelText;

    const confirmBtn = document.createElement("button");
    confirmBtn.className = `modal-btn ${danger ? "danger" : "primary"}`;
    confirmBtn.type = "button";
    confirmBtn.textContent = confirmText;

    // alert()-style calls pass cancelText="" — only show the OK button.
    if (cancelText) actions.append(cancelBtn);
    actions.append(confirmBtn);
    modal.append(h, p, actions);
    backdrop.append(modal);
    document.body.append(backdrop);

    let cleaned = false;
    const close = (result) => {
      if (cleaned) return;
      cleaned = true;
      document.removeEventListener("keydown", keyHandler, true);
      backdrop.classList.add("is-leaving");
      setTimeout(() => {
        backdrop.remove();
        // Always hand focus back to the prompt input so the user can
        // immediately keep typing — fixes the "input locked after agent/auto
        // toggle" symptom that native confirm() caused.
        try { promptInput.focus(); } catch { /* ignore */ }
        resolve(result);
      }, 140);
    };

    const keyHandler = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); close(true); }
    };
    document.addEventListener("keydown", keyHandler, true);

    cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(false); });

    requestAnimationFrame(() => confirmBtn.focus());
  });
}

// Toast notifications — small in-page status messages so the user sees what
// went wrong without opening DevTools. Variants: "error" (red), "success"
// (green), default (neutral).
const toastContainer = document.querySelector("#toastContainer");
// Keep the panel subtitle showing the live model + active modes so the user
// always knows what they're operating in.
function updatePanelSubtitle() {
  const badges = [];
  const capitalizedMode = currentMode.charAt(0).toUpperCase() + currentMode.slice(1);
  badges.push(capitalizedMode);
  if (autoMode) badges.push("Auto");
  if (!attachScreenshot) badges.push("No screen");
  const tail = badges.length ? `  ·  ${badges.join(" · ")}` : "";
  panelSubtitle.textContent = `${selectedModel}${tail}`;
}

function toast(message, { variant = "default", duration = 3500 } = {}) {
  if (!toastContainer || !message) return;
  const el = document.createElement("div");
  el.className = `toast ${variant === "error" ? "is-error" : variant === "success" ? "is-success" : ""}`;
  el.textContent = message;
  toastContainer.append(el);

  const dismiss = () => {
    el.classList.add("is-leaving");
    setTimeout(() => el.remove(), 200);
  };
  setTimeout(dismiss, duration);
  el.addEventListener("click", dismiss);
}

// Hard reset for the input controls. Called from every `finally` block in the
// async send flows so a thrown error mid-loop can never leave the prompt
// permanently locked.
function resetInputState() {
  sendButton.disabled = false;
  promptInput.disabled = false;
  promptInput.readOnly = false;
  setStatus("ready");
}

function setOverlayState(state) {
  overlay.dataset.state = state;
  window.orbit.setOverlayState(state);
}

// History Store Persistence
async function persistHistory() {
  const persistable = chatMessages
    .filter((m) => !m.pending)
    .map(({ pending, error, ...rest }) => rest);
  await window.orbit.saveHistory({
    selectedModel,
    messages: persistable,
    workspacePath,
    currentMode,
    agentMode,
    autoMode,
    attachScreenshot,
    panelWidthMode,
    autoSpeakEnabled,
    conversationSummary,
    summarizedCount
  });
}

function updateSpeakToggleUI() {
  if (autoSpeakEnabled) {
    speakToggleButton.classList.add("is-active");
    speakToggleButton.title = "Auto-Speak Enabled (Orbit will read replies aloud)";
  } else {
    speakToggleButton.classList.remove("is-active");
    speakToggleButton.title = "Auto-Speak Disabled (Replies are silent)";
  }
}

// Whisper language button UI update — optional UI element, no-op if not present
function updateWhisperLangUI() {
  if (!whisperLangBtn) return; // element is optional
}

async function loadHistory() {
  try {
    const history = await window.orbit.loadHistory();
    selectedModel = MODELS.includes(history?.selectedModel) ? history.selectedModel : DEFAULT_MODEL;
    chatMessages = Array.isArray(history?.messages) ? history.messages : [];
    workspacePath = typeof history?.workspacePath === "string" ? history.workspacePath : "";
    currentMode = typeof history?.currentMode === "string" ? history.currentMode : (history?.agentMode ? "agents" : "ask");
    agentMode = (currentMode === "agents");
    autoMode = typeof history?.autoMode === "boolean" ? history.autoMode : false;
    attachScreenshot = typeof history?.attachScreenshot === "boolean" ? history.attachScreenshot : true;
    panelWidthMode = history?.panelWidthMode === "wide" ? "wide" : "standard";
    autoSpeakEnabled = typeof history?.autoSpeakEnabled === "boolean" ? history.autoSpeakEnabled : false;
    conversationSummary = typeof history?.conversationSummary === "string" ? history.conversationSummary : "";
    summarizedCount = Number.isInteger(history?.summarizedCount) && history.summarizedCount >= 0 ? history.summarizedCount : 0;

    if (modelSelectBtn) {
      const textSpan = modelSelectBtn.querySelector("span");
      if (textSpan) textSpan.textContent = selectedModel;
    }
    if (modelSelectOptions) {
      modelSelectOptions.querySelectorAll(".custom-select-option").forEach(opt => {
        opt.classList.toggle("selected", opt.dataset.value === selectedModel);
      });
    }
    updatePanelSubtitle();

    updateModeUI();
    updateAutoModeUI();
    updateScreenshotToggleUI();
    updateSpeakToggleUI();
    updateWhisperLangUI();

    // Restore saved panel width
    if (panelWidthMode === "wide") {
      widthToggleButton.classList.add("is-active");
      try {
        await window.orbit.setWidth(850);
      } catch (widthErr) {
        console.error("Error setting panel width:", widthErr);
      }
    }

    if (!workspacePath) {
      try {
        const info = await window.orbit.getWorkspaceInfo("");
        if (info && info.path) {
          workspacePath = info.path;
        }
      } catch (infoErr) {
        console.error("Error getting workspace info:", infoErr);
      }
    }

    if (workspacePath) {
      await initWorkspace();
    } else {
      updateWorkspaceUI();
    }

    renderMessages();
  } catch (error) {
    console.error("Critical error in loadHistory:", error);
    // Secure Fallbacks to ensure overlay still displays
    selectedModel = DEFAULT_MODEL;
    chatMessages = [];
    workspacePath = "";
    currentMode = "ask";
    agentMode = false;
    autoMode = false;
    attachScreenshot = true;
    panelWidthMode = "standard";
    autoSpeakEnabled = false;
    autoSpeakEnabled = false;

    if (modelSelectBtn) {
      const textSpan = modelSelectBtn.querySelector("span");
      if (textSpan) textSpan.textContent = selectedModel;
    }
    if (modelSelectOptions) {
      modelSelectOptions.querySelectorAll(".custom-select-option").forEach(opt => {
        opt.classList.toggle("selected", opt.dataset.value === selectedModel);
      });
    }
    updatePanelSubtitle();
    updateModeUI();
    updateAutoModeUI();
    updateScreenshotToggleUI();
    updateSpeakToggleUI();
    updateWorkspaceUI();
    renderMessages();
  }
}

// Workspace Management
async function initWorkspace() {
  const info = await window.orbit.getWorkspaceInfo(workspacePath);
  if (info && !info.error) {
    workspacePath = info.path;
    workspaceFiles = info.files || [];
    renderFilesList();
  } else {
    workspaceFiles = [];
    workspacePath = "";
  }
  updateWorkspaceUI();
}

function updateWorkspaceUI() {
  if (workspacePath) {
    const parts = workspacePath.split(/[/\\]/);
    const folderName = parts[parts.length - 1] || workspacePath;
    workspacePathEl.textContent = folderName;
    workspacePathEl.title = workspacePath;
  } else {
    workspacePathEl.textContent = "No project folder selected";
    workspacePathEl.title = "Click to set project folder";
  }
}

function getFileBadgeClass(path) {
  const ext = path.split('.').pop().toLowerCase();
  if (['js', 'jsx', 'ts', 'tsx'].includes(ext)) return { text: 'JS', class: 'badge-js' };
  if (['py'].includes(ext)) return { text: 'PY', class: 'badge-py' };
  if (['html', 'htm'].includes(ext)) return { text: 'HTML', class: 'badge-html' };
  if (['css', 'scss', 'less'].includes(ext)) return { text: 'CSS', class: 'badge-css' };
  if (['json'].includes(ext)) return { text: 'JSON', class: 'badge-json' };
  if (['md'].includes(ext)) return { text: 'MD', class: 'badge-md' };
  return { text: ext.substring(0, 3).toUpperCase(), class: 'badge-def' };
}

function renderFilesList() {
  fileListEl.innerHTML = "";
  const filter = fileSearchInput.value.toLowerCase();

  const filtered = workspaceFiles.filter(
    (f) => f.name.toLowerCase().includes(filter) || f.path.toLowerCase().includes(filter)
  );

  if (filtered.length === 0) {
    const li = document.createElement("li");
    li.className = "file-item";
    li.style.color = "var(--muted)";
    li.textContent = workspaceFiles.length === 0 ? "No code files found" : "No matching files";
    fileListEl.appendChild(li);
    return;
  }

  for (const file of filtered) {
    const li = document.createElement("li");
    li.className = "file-item";
    if (selectedFiles.has(file.path)) {
      li.classList.add("is-selected");
    }

    // Language Badge
    const badge = document.createElement("span");
    const badgeInfo = getFileBadgeClass(file.path);
    badge.className = `file-item-badge ${badgeInfo.class}`;
    badge.textContent = badgeInfo.text;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "file-item-checkbox";
    checkbox.checked = selectedFiles.has(file.path);

    const nameSpan = document.createElement("span");
    nameSpan.className = "file-item-name";
    nameSpan.textContent = file.path;
    nameSpan.title = file.path;

    li.append(badge, checkbox, nameSpan);

    const toggleSelection = (e) => {
      e.stopPropagation();
      if (selectedFiles.has(file.path)) {
        selectedFiles.delete(file.path);
        li.classList.remove("is-selected");
        checkbox.checked = false;
      } else {
        selectedFiles.add(file.path);
        li.classList.add("is-selected");
        checkbox.checked = true;
      }
      renderContextTray();
    };

    li.addEventListener("click", toggleSelection);
    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
      if (checkbox.checked) {
        selectedFiles.add(file.path);
        li.classList.add("is-selected");
      } else {
        selectedFiles.delete(file.path);
        li.classList.remove("is-selected");
      }
      renderContextTray();
    });

    fileListEl.appendChild(li);
  }
}

function renderContextTray() {
  attachedFilesEl.innerHTML = "";
  if (selectedFiles.size === 0 && !pastedImageDataUrl) {
    contextTray.style.display = "none";
    return;
  }

  contextTray.style.display = "flex";

  // Pasted-image chip (always rendered first so users see it right away).
  if (pastedImageDataUrl) {
    const pill = document.createElement("span");
    pill.className = "attached-pill attached-pill-image";
    const thumb = document.createElement("img");
    thumb.src = pastedImageThumb || pastedImageDataUrl;
    thumb.alt = "Pasted image";
    thumb.style.cssText = "width:18px;height:18px;border-radius:3px;object-fit:cover;margin-right:6px;vertical-align:middle;";
    const label = document.createElement("span");
    label.textContent = "Pasted image";
    const removeBtn = document.createElement("span");
    removeBtn.className = "attached-pill-remove";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      pastedImageDataUrl = null;
      pastedImageThumb = null;
      renderContextTray();
    });
    pill.append(thumb, label, removeBtn);
    attachedFilesEl.appendChild(pill);
  }

  for (const path of selectedFiles) {
    const pill = document.createElement("span");
    pill.className = "attached-pill";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = path.split("/").pop();

    const removeBtn = document.createElement("span");
    removeBtn.className = "attached-pill-remove";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectedFiles.delete(path);
      renderFilesList();
      renderContextTray();
    });

    pill.append(nameSpan, removeBtn);
    attachedFilesEl.appendChild(pill);
  }
}

// Action Cards & Execution
function isSummonAgentsAuthorized() {
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    const m = chatMessages[i];
    if (m.role === "user" && !m.isToolResult) {
      return m.content.toLowerCase().includes("/summon-agents");
    }
  }
  return false;
}

const SVG_ICONS = {
  command: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,
  file: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
  folder: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
  search: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
  globe: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
  mouse: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="7"></rect><line x1="12" y1="6" x2="12" y2="10"></line></svg>`,
  window: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>`,
  bot: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>`,
  trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
  move: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 2 12 5 15"></polyline><polyline points="9 5 12 2 15 5"></polyline><polyline points="19 9 22 12 19 15"></polyline><polyline points="9 19 12 22 15 19"></polyline><line x1="2" y1="12" x2="22" y2="12"></line><line x1="12" y1="2" x2="12" y2="22"></line></svg>`,
  git: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><circle cx="18" cy="6" r="3"></circle><path d="M18 9v6"></path><path d="M6 9v3a3 3 0 0 0 3 3h6"></path></svg>`,
  book: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>`,
  link: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`,
  gear: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`
};

const TOOL_ICON = {
  execute_command: SVG_ICONS.command,
  write_file: SVG_ICONS.file,
  patch_file: SVG_ICONS.file,
  read_file: SVG_ICONS.file,
  list_workspace: SVG_ICONS.folder,
  list_windows: SVG_ICONS.window,
  search_workspace: SVG_ICONS.search,
  type_text: SVG_ICONS.command,
  click_pixel: SVG_ICONS.mouse,
  scroll: SVG_ICONS.mouse,
  keystroke: SVG_ICONS.command,
  focus_window: SVG_ICONS.window,
  wait_ms: SVG_ICONS.command,
  open_browser: SVG_ICONS.globe,
  deploy_agent: SVG_ICONS.bot,
  list_dir: SVG_ICONS.folder,
  delete_file: SVG_ICONS.trash,
  move_file: SVG_ICONS.move,
  create_directory: SVG_ICONS.folder,
  git_status: SVG_ICONS.git,
  git_diff: SVG_ICONS.git,
  git_log: SVG_ICONS.git,
  web_search: SVG_ICONS.globe,
  deep_research: SVG_ICONS.search,
  read_webpage: SVG_ICONS.book,
  open_url: SVG_ICONS.link,
  open_app: SVG_ICONS.window
};

const INLINE_TOOL_ICON = {
  terminal: SVG_ICONS.command,
  edit: SVG_ICONS.file,
  read: SVG_ICONS.book,
  research: SVG_ICONS.globe,
  action: SVG_ICONS.mouse,
  agent: SVG_ICONS.bot
};

function renderInlineToolBadges(parts, statusForPart = () => "running") {
  const row = document.createElement("div");
  row.className = "inline-tool-row";
  const badges = buildInlineToolBadges(parts, statusForPart);
  badges.forEach((badge) => {
    const el = document.createElement("span");
    el.className = `inline-tool-badge inline-tool-${badge.kind}`;
    el.innerHTML = `<span class="inline-tool-icon">${INLINE_TOOL_ICON[badge.kind] || SVG_ICONS.gear}</span><span></span>`;
    el.querySelector("span:last-child").textContent = badge.label;
    row.append(el);
  });
  return row;
}

function renderThinkingBlock(toolGroup, messageId) {
  const details = document.createElement("details");
  const hasRunning = toolGroup.some(({ part, partIndex }) => {
    const cardKey = `${messageId}-${part.type}-${part.path || "command"}-${partIndex}`;
    const status = cardExecutionStates[cardKey]?.status;
    return !status || status === "pending" || status === "working";
  });
  // Only spin while tools are actually running. Otherwise the spinner animation
  // ran forever next to "Thought process" — looked like an endless loop.
  details.className = `thinking-block ${hasRunning ? "is-running" : "is-complete"}`;

  const summary = document.createElement("summary");
  const statusIcon = hasRunning
    ? `<span class="thinking-spinner" aria-hidden="true"></span>`
    : `<span class="thinking-done" aria-hidden="true">${SVG_ICONS.check}</span>`;
  summary.innerHTML = `
    ${statusIcon}
    <span>${hasRunning ? "Orbit is thinking..." : "Thought process"}</span>
    <span class="thinking-count">${toolGroup.length} tool${toolGroup.length === 1 ? "" : "s"}</span>
  `;
  details.append(summary);

  const body = document.createElement("div");
  body.className = "thinking-body";
  toolGroup.forEach(({ part, partIndex }) => {
    body.append(renderActionCard(part, messageId, partIndex));
  });
  details.append(body);
  return details;
}

function renderStreamingTextContent(targetEl, rawText) {
  if (!targetEl) return;
  const display = streamingToolDisplay(rawText || "");
  targetEl.innerHTML = "";
  if (display.text) {
    const text = document.createElement("span");
    text.innerHTML = renderMarkdown(display.text);
    targetEl.append(text);
  }
  if (display.badges.length) {
    const row = document.createElement("span");
    row.className = "inline-tool-row inline-tool-row-stream";
    display.badges.forEach((badge) => {
      const el = document.createElement("span");
      el.className = `inline-tool-badge inline-tool-${badge.kind} is-live`;
      el.innerHTML = `<span class="inline-tool-icon">${INLINE_TOOL_ICON[badge.kind] || SVG_ICONS.gear}</span><span></span>`;
      el.querySelector("span:last-child").textContent = badge.label;
      row.append(el);
    });
    targetEl.append(row);
  }
}

function renderActionCard(part, messageId, partIndex) {
  const cardKey = `${messageId}-${part.type}-${part.path || "command"}-${partIndex}`;
  const cardState = cardExecutionStates[cardKey] || (cardExecutionStates[cardKey] = { status: "pending" });

  const card = document.createElement("div");
  card.className = "action-card";

  const header = document.createElement("div");
  header.className = "action-card-header";

  const typeClass =
    part.type === "execute_command" ? "command" :
    part.type === "write_file" ? "write" :
    part.type === "type_text" ? "type" :
    part.type === "list_workspace" ? "list" :
    part.type === "list_windows" ? "list" :
    part.type === "click_pixel" ? "click" :
    part.type === "scroll" ? "click" :
    part.type === "keystroke" ? "type" :
    part.type === "focus_window" ? "list" :
    part.type === "wait_ms" ? "read" :
    part.type === "open_browser" ? "browser" :
    part.type === "open_url" ? "browser" :
    part.type === "web_search" || part.type === "deep_research" || part.type === "read_webpage" ? "read" :
    part.type === "open_app" ? "browser" :
    part.type === "delete_file" ? "write" :
    part.type === "move_file" ? "write" :
    part.type === "create_directory" ? "write" :
    part.type === "list_dir" ? "list" :
    part.type === "read_files" ? "read" :
    part.type === "git_status" || part.type === "git_diff" || part.type === "git_log" ? "command" :
    part.type === "deploy_agent" ? "agent" : "read";
  const typeLabel =
    part.type === "execute_command" ? "Command" :
    part.type === "write_file" ? "Write File" :
    part.type === "type_text" ? `Type into "${part.window || "?"}"` :
    part.type === "list_workspace" ? "List Workspace" :
    part.type === "list_windows" ? "List Windows" :
    part.type === "click_pixel" ? (part.button === "right" ? "Right Click" : part.count === 2 ? "Double Click" : "Click Pixel") :
    part.type === "scroll" ? "Scroll" :
    part.type === "keystroke" ? `Keystroke${part.window ? ` → "${part.window}"` : ""}` :
    part.type === "focus_window" ? "Focus Window" :
    part.type === "wait_ms" ? "Wait" :
    part.type === "open_browser" ? "Open Browser" :
    part.type === "open_url" ? "Open URL" :
    part.type === "web_search" ? "Web Search" :
    part.type === "deep_research" ? "Deep Research" :
    part.type === "read_webpage" ? "Read Webpage" :
    part.type === "open_app" ? "Open App" :
    part.type === "list_dir" ? "List Directory" :
    part.type === "delete_file" ? "Delete File" :
    part.type === "move_file" ? "Move File" :
    part.type === "create_directory" ? "Create Folder" :
    part.type === "git_status" ? "Git Status" :
    part.type === "git_diff" ? "Git Diff" :
    part.type === "git_log" ? "Git Log" :
    part.type === "deploy_agent" ? "Deploy Agent" :
    part.type === "read_files" ? "Read Files" :
    part.type === "read_file" && part.start != null ? `Read File :${part.start}-${part.end}` : "Read File";

  const typeSpan = document.createElement("span");
  typeSpan.className = `action-card-type ${typeClass}`;

  const icon = TOOL_ICON[part.type] || "⚙️";
  typeSpan.innerHTML = `<span style="margin-right: 6px;">${icon}</span>${typeLabel}`;

  const pathSpan = document.createElement("span");
  pathSpan.className = "action-card-path";
  pathSpan.textContent =
    part.type === "read_files" ? (part.glob ? part.glob : `${(part.paths || []).length} files`) :
    part.type === "click_pixel" ? `x=${part.x}, y=${part.y}` :
    part.type === "scroll" ? `x=${part.x}, y=${part.y}, ticks=${part.ticks}` :
    part.type === "keystroke" ? part.content || "" :
    part.type === "focus_window" ? `"${part.window || ""}"` :
    part.type === "wait_ms" ? `${part.ms}ms` :
    part.type === "open_browser" ? part.url :
    part.type === "open_url" || part.type === "read_webpage" ? part.url :
    part.type === "web_search" || part.type === "deep_research" ? `"${part.query || ""}"` :
    part.type === "open_app" ? `${part.name}${part.args ? ` ${part.args}` : ""}` :
    part.type === "list_windows" ? "Active Application Windows" :
    part.type === "deploy_agent" ? "Autonomous Background Agent" :
    part.type === "move_file" ? `${part.from} → ${part.to}` :
    part.type === "git_status" ? "working tree" :
    part.type === "git_log" ? `last ${part.count || 20} commits` :
    part.type === "git_diff" ? (part.path || "all changes") : (part.path || "");

  header.append(typeSpan, pathSpan);

  // Stats badges for write file changes
  if (part.type === "write_file") {
    // Add "🔍 Inspect Diff" button in card header
    const inspectBtn = document.createElement("button");
    inspectBtn.className = "agent-btn";
    inspectBtn.style.padding = "2px 8px";
    inspectBtn.style.fontSize = "10px";
    inspectBtn.style.height = "20px";
    inspectBtn.style.marginLeft = "12px";
    inspectBtn.textContent = "🔍 Inspect Diff";
    inspectBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openSideBySideDiff(part);
    });
    header.append(inspectBtn);

    if (cardState.diffData) {
      const { additions, deletions } = cardState.diffData;
      const addBadge = document.createElement("span");
      addBadge.className = "diff-badge add";
      addBadge.textContent = `+${additions}`;
      const delBadge = document.createElement("span");
      delBadge.className = "diff-badge del";
      delBadge.textContent = `-${deletions}`;
      header.append(addBadge, delBadge);
    }
  }

  card.append(header);

  const body = document.createElement("div");
  body.className = "action-card-body";

  if (part.type === "write_file") {
    if (cardState.diffData) {
      const diffContainer = document.createElement("div");
      diffContainer.className = "diff-container";
      
      for (const line of cardState.diffData.diff) {
        const lineEl = document.createElement("div");
        lineEl.className = `diff-line ${line.type}`;
        lineEl.textContent = (line.type === "added" ? "+ " : line.type === "deleted" ? "- " : "  ") + line.text;
        diffContainer.append(lineEl);
      }
      body.append(diffContainer);
    } else if (cardState.diffLoading) {
      const loader = document.createElement("div");
      loader.className = "action-card-status working";
      loader.style.padding = "10px";
      loader.textContent = "Calculating diff changes...";
      body.append(loader);
    } else {
      // Trigger lazy load
      loadDiffData(part, cardKey);
      const loader = document.createElement("div");
      loader.className = "action-card-status working";
      loader.style.padding = "10px";
      loader.textContent = "Loading current file...";
      body.append(loader);
    }
  } else if (part.type === "deploy_agent") {
    const desc = document.createElement("div");
    desc.className = "action-card-description";
    desc.textContent = `Deploying background coding agent to perform task:\n"${part.task}"`;
    body.append(desc);

    if (cardState.status === "pending") {
      const controls = document.createElement("div");
      controls.className = "agent-controls";
      controls.style.marginTop = "10px";
      controls.style.display = "flex";
      controls.style.alignItems = "center";
      controls.style.gap = "8px";

      const label = document.createElement("span");
      label.textContent = "Deploy Count:";
      label.style.fontSize = "12px";
      label.style.color = "#94a3b8";

      const select = document.createElement("select");
      select.className = "agent-count-select";
      select.id = `count-select-${cardKey}`;
      select.style.background = "rgba(0, 0, 0, 0.4)";
      select.style.border = "1px solid rgba(255, 255, 255, 0.1)";
      select.style.borderRadius = "4px";
      select.style.color = "#f8fafc";
      select.style.padding = "2px 6px";
      select.style.fontSize = "12px";
      select.style.cursor = "pointer";

      for (let i = 1; i <= 5; i++) {
        const opt = document.createElement("option");
        opt.value = i;
        opt.textContent = i;
        select.appendChild(opt);
      }

      controls.append(label, select);
      body.append(controls);
    }

    if (cardState.status === "success") {
      if (!cardState.agents && cardState.agentId) {
        cardState.agents = [{ agentId: cardState.agentId, logPath: cardState.logPath }];
      }

      if (cardState.agents && cardState.agents.length > 0) {
        const infoBox = document.createElement("div");
        infoBox.className = "agent-info-box";
        
        cardState.agents.forEach((ag, idx) => {
          const item = document.createElement("div");
          item.className = "agent-info-item";
          if (idx > 0) {
            item.style.marginTop = "10px";
            item.style.borderTop = "1px solid rgba(168, 85, 247, 0.1)";
            item.style.paddingTop = "8px";
          }
          
          const idDiv = document.createElement("div");
          idDiv.innerHTML = `<strong>Agent #${idx + 1} ID:</strong> <code>${ag.agentId}</code>`;
          
          const pathDiv = document.createElement("div");
          pathDiv.innerHTML = `<strong>Log Path:</strong> <code>${ag.logPath}</code>`;
          
          const viewLogBtn = document.createElement("button");
          viewLogBtn.className = "view-log-btn";
          viewLogBtn.innerHTML = `👁️ View Live Console`;
          
          const viewerContainer = document.createElement("div");
          viewerContainer.className = "agent-log-viewer";
          viewerContainer.id = `log-viewer-${ag.agentId}`;
          viewerContainer.style.display = "none";
          
          viewerContainer.innerHTML = `
            <div class="log-viewer-header">
              <span class="log-title">Live Agent Console — ${ag.agentId}</span>
              <div class="log-actions">
                <button class="agent-btn" id="log-pause-${ag.agentId}" style="height: 20px; font-size: 10px; margin-right: 8px;">⏸ Pause</button>
                <span class="log-status-badge status-running" id="log-badge-${ag.agentId}">Running</span>
                <button class="log-refresh-btn" id="log-refresh-${ag.agentId}" title="Refresh Now">↻</button>
              </div>
            </div>
            <pre class="log-viewer-content" id="log-content-${ag.agentId}">Reading log file...</pre>
            
            <!-- Interception control rows inside the Live Console dashboard -->
            <div class="agent-controls-panel" id="log-ctrl-panel-${ag.agentId}">
              <div class="agent-control-row">
                <input type="text" class="agent-control-input" id="log-stdin-input-${ag.agentId}" placeholder="Send stdin command inputs (e.g. y/n, password, option text)..." />
                <button class="agent-btn primary" id="log-stdin-send-${ag.agentId}">Send Stdin</button>
              </div>
              <div class="agent-control-row">
                <input type="text" class="agent-control-input" id="log-prompt-input-${ag.agentId}" placeholder="Inject custom mid-run directive instruction to the Agent..." />
                <button class="agent-btn" id="log-prompt-inject-${ag.agentId}" style="border-color: rgba(52, 211, 153, 0.4); color: #34d399;">Inject Directive</button>
              </div>
            </div>
          `;
          
          item.append(idDiv, pathDiv, viewLogBtn, viewerContainer);
          infoBox.append(item);

          let logInterval = null;
          let isAgentPaused = false;
          
          const pauseBtn = viewerContainer.querySelector(`#log-pause-${ag.agentId}`);
          const stdinInput = viewerContainer.querySelector(`#log-stdin-input-${ag.agentId}`);
          const stdinSend = viewerContainer.querySelector(`#log-stdin-send-${ag.agentId}`);
          const directiveInput = viewerContainer.querySelector(`#log-prompt-input-${ag.agentId}`);
          const directiveInject = viewerContainer.querySelector(`#log-prompt-inject-${ag.agentId}`);
          
          // Wire up Pause / Resume file control toggler
          pauseBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            isAgentPaused = !isAgentPaused;
            
            const controlFileRel = `.orbit/${ag.agentId}.control.json`;
            let ctrl = { paused: false, injectedInstruction: "", stdin: "" };
            try {
              const res = await window.orbit.readWorkspaceFile({ workspacePath, relativePath: controlFileRel });
              if (res && res.ok) ctrl = JSON.parse(res.content);
            } catch {}
            
            ctrl.paused = isAgentPaused;
            await window.orbit.writeWorkspaceFile({
              workspacePath,
              relativePath: controlFileRel,
              content: JSON.stringify(ctrl, null, 2)
            });
            
            pauseBtn.textContent = isAgentPaused ? "▶ Resume" : "⏸ Pause";
            pauseBtn.style.color = isAgentPaused ? "#34d399" : "#fff";
            
            const badge = viewerContainer.querySelector(`#log-badge-${ag.agentId}`);
            badge.textContent = isAgentPaused ? "Paused" : "Running";
            badge.className = isAgentPaused ? "log-status-badge status-completed" : "log-status-badge status-running";
            toast(isAgentPaused ? "Agent execution paused — standing by" : "Agent execution resumed", { variant: "success" });
          });
          
          // Wire up Send Stdin
          stdinSend.addEventListener("click", async (e) => {
            e.stopPropagation();
            const text = stdinInput.value.trim();
            if (!text) return;
            
            const controlFileRel = `.orbit/${ag.agentId}.control.json`;
            let ctrl = { paused: isAgentPaused, injectedInstruction: "", stdin: "" };
            try {
              const res = await window.orbit.readWorkspaceFile({ workspacePath, relativePath: controlFileRel });
              if (res && res.ok) ctrl = JSON.parse(res.content);
            } catch {}
            
            ctrl.stdin = text;
            await window.orbit.writeWorkspaceFile({
              workspacePath,
              relativePath: controlFileRel,
              content: JSON.stringify(ctrl, null, 2)
            });
            
            stdinInput.value = "";
            toast(`Sent stdin input: "${text}"`, { variant: "success" });
          });
          
          // Wire up Inject Directive
          directiveInject.addEventListener("click", async (e) => {
            e.stopPropagation();
            const text = directiveInput.value.trim();
            if (!text) return;
            
            const controlFileRel = `.orbit/${ag.agentId}.control.json`;
            let ctrl = { paused: isAgentPaused, injectedInstruction: "", stdin: "" };
            try {
              const res = await window.orbit.readWorkspaceFile({ workspacePath, relativePath: controlFileRel });
              if (res && res.ok) ctrl = JSON.parse(res.content);
            } catch {}
            
            ctrl.injectedInstruction = text;
            await window.orbit.writeWorkspaceFile({
              workspacePath,
              relativePath: controlFileRel,
              content: JSON.stringify(ctrl, null, 2)
            });
            
            directiveInput.value = "";
            toast(`Injected instruction: "${text}"`, { variant: "success" });
          });
          
          const updateLogView = async () => {
            try {
              const res = await window.orbit.readWorkspaceFile({
                workspacePath,
                relativePath: `.orbit/${ag.agentId}.log`
              });
              const contentPre = viewerContainer.querySelector(`#log-content-${ag.agentId}`);
              const badge = viewerContainer.querySelector(`#log-badge-${ag.agentId}`);
              
              if (res && res.ok && contentPre) {
                contentPre.textContent = res.content || "Empty log.";
                contentPre.scrollTop = contentPre.scrollHeight;
                
                const isFinished = res.content.includes("AGENT FINISHED SUCCESSFULLY");
                const isFailed = res.content.includes("CRITICAL ERROR") || res.content.includes("FAILED");
                const isStopped = res.content.includes("Stopping background agent loop") || res.content.includes("Reached maximum steps");
                
                if (isFinished || isFailed || isStopped) {
                  badge.textContent = isFinished ? "Completed" : isStopped ? "Stopped" : "Failed";
                  badge.className = isFinished ? "log-status-badge status-completed" : "log-status-badge status-failed";
                  
                  // Disable live interaction controls on exit
                  pauseBtn.disabled = true;
                  stdinSend.disabled = true;
                  directiveInject.disabled = true;
                  stdinInput.disabled = true;
                  directiveInput.disabled = true;
                  
                  if (logInterval) { clearInterval(logInterval); logInterval = null; }
                }
              } else if (contentPre) {
                contentPre.textContent = "Log file not created yet or inaccessible.";
              }
            } catch (err) {
              console.error("Error reading agent log:", err);
            }
          };

          const refreshBtn = viewerContainer.querySelector(`#log-refresh-${ag.agentId}`);
          if (refreshBtn) {
            refreshBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              updateLogView();
            });
          }

          viewLogBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const isOpen = viewerContainer.style.display !== "none";
            if (isOpen) {
              viewerContainer.style.display = "none";
              viewLogBtn.innerHTML = `👁️ View Live Console`;
              if (logInterval) {
                clearInterval(logInterval);
                logInterval = null;
              }
            } else {
              viewerContainer.style.display = "flex";
              viewLogBtn.innerHTML = `🙈 Hide Live Console`;
              updateLogView();
              logInterval = setInterval(updateLogView, 1500);
            }
          });
        });

        const note = document.createElement("div");
        note.className = "agent-info-note";
        note.textContent = "The agent(s) are running autonomously in the background. You can open their live console views above to monitor progress, pause, or send inputs in real-time.";
        infoBox.append(note);
        body.append(infoBox);

        if (isSummonAgentsAuthorized()) {
          const deployMoreContainer = document.createElement("div");
          deployMoreContainer.style.margin = "10px 14px";
          deployMoreContainer.style.textAlign = "right";

          const deployMoreBtn = document.createElement("button");
          deployMoreBtn.className = "action-btn primary";
          deployMoreBtn.style.padding = "4px 10px";
          deployMoreBtn.style.fontSize = "11px";
          deployMoreBtn.textContent = "+ Deploy Another Agent";

          deployMoreBtn.addEventListener("click", async () => {
            try {
              const count = await window.orbit.getActiveAgentsCount();
              if (count >= 5) {
                toast("Active concurrent background agents limit reached (max 5)", { variant: "error" });
                deployMoreBtn.remove();
                return;
              }
            } catch (e) {
              console.error(e);
            }

            deployMoreBtn.disabled = true;
            deployMoreBtn.textContent = "Deploying...";
            
            const res = await window.orbit.deployAgent({
              workspacePath,
              task: part.task,
              model: selectedModel
            });

            if (res && res.ok) {
              cardState.agents.push({
                agentId: res.agentId,
                logPath: res.logPath
              });
              renderMessages();
            } else {
              alert(`Failed to deploy additional agent: ${res?.error || "Unknown error"}`);
              deployMoreBtn.disabled = false;
              deployMoreBtn.textContent = "+ Deploy Another Agent";
            }
          });

          deployMoreContainer.append(deployMoreBtn);
          body.append(deployMoreContainer);
        }
      }
    }
  } else if (part.type === "web_search") {
    const desc = document.createElement("div");
    desc.className = "action-card-description";
    desc.textContent = `Searching the web for:\n"${part.query}"`;
    body.append(desc);
  } else if (part.type === "deep_research") {
    const desc = document.createElement("div");
    desc.className = "action-card-description";
    desc.textContent = `Researching the web and reading top results for:\n"${part.query}"`;
    body.append(desc);
  } else if (part.type === "read_webpage") {
    const desc = document.createElement("div");
    desc.className = "action-card-description";
    desc.textContent = `Reading webpage:\n"${part.url}"`;
    body.append(desc);
  } else if (part.type === "open_browser" || part.type === "open_url") {
    const desc = document.createElement("div");
    desc.className = "action-card-description";
    desc.textContent = `Opening URL:\n"${part.url}"`;
    body.append(desc);
  } else if (part.type === "list_windows" && cardState.windows) {
    const list = document.createElement("div");
    list.className = "terminal-box";
    list.style.marginTop = "8px";
    const headerEl = document.createElement("div");
    headerEl.className = "terminal-header";
    headerEl.textContent = `Visible Application Windows (${cardState.windows.length})`;
    const pre = document.createElement("pre");
    pre.className = "terminal-output";
    pre.textContent = cardState.windows.map(w => `[Process: ${w.processName}] Title: "${w.title}" (PID: ${w.pid})`).join("\n");
    list.append(headerEl, pre);
    body.append(list);
  } else if (part.content && part.type !== "read_file" && part.type !== "click_pixel" && part.type !== "list_windows") {
    const code = document.createElement("pre");
    code.className = "action-card-code";
    code.textContent = part.content.trim();
    body.append(code);
  } else if (part.type === "read_file" && cardState.fileContent) {
    const code = document.createElement("pre");
    code.className = "action-card-code";
    code.textContent = cardState.fileContent.trim();
    body.append(code);
  }

  const actions = document.createElement("div");
  actions.className = "action-card-actions";

  const statusSpan = document.createElement("span");
  statusSpan.className = "action-card-status";

  if (cardState.status === "pending") {
    statusSpan.textContent = "Requires approval";

    if (part.type === "deploy_agent" && !isSummonAgentsAuthorized()) {
      statusSpan.textContent = "🔒 Requires /summon-agents to deploy";
    } else {
      const approveBtn = document.createElement("button");
      approveBtn.className = "action-btn primary";
      approveBtn.textContent =
        part.type === "execute_command" ? "Execute" :
        part.type === "write_file" ? "Apply" :
        part.type === "type_text" ? "Type" :
        part.type === "list_workspace" ? "Scan" :
        part.type === "list_windows" ? "List" :
        part.type === "click_pixel" ? "Click" :
        part.type === "open_browser" ? "Open" :
        part.type === "open_url" ? "Open" :
        part.type === "web_search" ? "Search" :
        part.type === "deep_research" ? "Research" :
        part.type === "read_webpage" ? "Read" :
        part.type === "deploy_agent" ? "Deploy" : "Load";

      if (part.type === "deploy_agent") {
        approveBtn.addEventListener("click", async () => {
          try {
            const count = await window.orbit.getActiveAgentsCount();
            if (count >= 5) {
              statusSpan.textContent = "Deploy limit reached (max 5 active)";
              approveBtn.remove();
              toast("Active concurrent background agents limit reached (max 5)", { variant: "error" });
              return;
            }
          } catch (e) {
            console.error(e);
          }
          await runActionCard(part, cardKey, statusSpan, approveBtn, messageId);
        });
      } else {
        approveBtn.addEventListener("click", async () => {
          await runActionCard(part, cardKey, statusSpan, approveBtn, messageId);
        });
      }

      actions.append(statusSpan, approveBtn);
    }
  } else if (cardState.status === "working") {
    statusSpan.className = "action-card-status working";
    statusSpan.textContent =
      part.type === "execute_command" ? "Running..." :
      part.type === "list_windows" ? "Listing..." :
      part.type === "click_pixel" ? "Clicking..." : "Applying...";

    const loader = document.createElement("button");
    loader.className = "action-btn primary";
    loader.disabled = true;
    loader.textContent = "...";

    actions.append(statusSpan, loader);
  } else if (cardState.status === "success") {
    statusSpan.className = "action-card-status success";
    statusSpan.textContent = "✓ Completed";
    actions.append(statusSpan);
  } else if (cardState.status === "error") {
    statusSpan.className = "action-card-status error";
    statusSpan.textContent = `✗ Failed: ${cardState.error}`;
    actions.append(statusSpan);
  }

  body.append(actions);

  if (part.type === "execute_command" && cardState.output) {
    const term = document.createElement("div");
    term.className = "terminal-box";

    const termHeader = document.createElement("div");
    termHeader.className = "terminal-header";
    termHeader.textContent = `Terminal Output (Exit code: ${cardState.exitCode})`;

    const termOut = document.createElement("pre");
    termOut.className = "terminal-output";
    termOut.textContent = cardState.output;

    term.append(termHeader, termOut);
    body.append(term);
  }

  card.append(body);
  return card;
}

// Interactive Side-by-Side Diff Inspector Modal builder
async function openSideBySideDiff(part) {
  const backdrop = document.createElement("div");
  backdrop.className = "diff-modal-backdrop";
  
  const modal = document.createElement("div");
  modal.className = "diff-modal";
  
  modal.innerHTML = `
    <div class="diff-modal-header">
      <span class="diff-modal-title">🔍 Inspect Diff — ${part.path}</span>
      <button class="agent-btn" id="close-diff-modal" style="height: 24px; width: 24px; padding: 0;">×</button>
    </div>
    <div class="diff-modal-body">
      <div class="diff-panel">
        <span class="diff-panel-title">Original File</span>
        <div class="diff-panel-content" id="diff-original-content">Loading...</div>
      </div>
      <div class="diff-panel">
        <span class="diff-panel-title">Proposed Changes</span>
        <div class="diff-panel-content" id="diff-proposed-content">Loading...</div>
      </div>
    </div>
    <div class="diff-modal-footer">
      <button class="agent-btn" id="diff-cancel-btn">Close Review</button>
    </div>
  `;
  
  backdrop.append(modal);
  document.body.append(backdrop);
  
  const close = () => {
    backdrop.classList.add("is-leaving");
    setTimeout(() => backdrop.remove(), 180);
  };
  
  modal.querySelector("#close-diff-modal").addEventListener("click", close);
  modal.querySelector("#diff-cancel-btn").addEventListener("click", close);
  
  try {
    const res = await window.orbit.readWorkspaceFile({
      workspacePath,
      relativePath: part.path
    });
    const oldText = (res && res.ok) ? res.content : "";
    const diffData = computeLineDiff(oldText, part.content || "");
    
    const origContainer = modal.querySelector("#diff-original-content");
    const propContainer = modal.querySelector("#diff-proposed-content");
    
    origContainer.innerHTML = "";
    propContainer.innerHTML = "";
    
    let oldLineNum = 1;
    let newLineNum = 1;
    
    for (const item of diffData.diff) {
      const origLine = document.createElement("div");
      origLine.className = "diff-line-item";
      
      const propLine = document.createElement("div");
      propLine.className = "diff-line-item";
      
      if (item.type === "deleted") {
        origLine.classList.add("deleted");
        origLine.innerHTML = `<span class="diff-line-number">${oldLineNum++}</span><span class="diff-line-code">${escapeHtml(item.text)}</span>`;
        
        propLine.classList.add("empty");
        propLine.innerHTML = `<span class="diff-line-number"></span><span class="diff-line-code"></span>`;
      } else if (item.type === "added") {
        origLine.classList.add("empty");
        origLine.innerHTML = `<span class="diff-line-number"></span><span class="diff-line-code"></span>`;
        
        propLine.classList.add("added");
        propLine.innerHTML = `<span class="diff-line-number">${newLineNum++}</span><span class="diff-line-code">${escapeHtml(item.text)}</span>`;
      } else {
        origLine.innerHTML = `<span class="diff-line-number">${oldLineNum++}</span><span class="diff-line-code">${escapeHtml(item.text)}</span>`;
        propLine.innerHTML = `<span class="diff-line-number">${newLineNum++}</span><span class="diff-line-code">${escapeHtml(item.text)}</span>`;
      }
      
      origContainer.appendChild(origLine);
      propContainer.appendChild(propLine);
    }
    
    // Synchronize scrolling!
    origContainer.addEventListener("scroll", () => {
      propContainer.scrollTop = origContainer.scrollTop;
    });
    propContainer.addEventListener("scroll", () => {
      origContainer.scrollTop = propContainer.scrollTop;
    });
    
  } catch (err) {
    modal.querySelector("#diff-original-content").textContent = `Error: ${err.message}`;
    modal.querySelector("#diff-proposed-content").textContent = `Error: ${err.message}`;
  }
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Compact web-search results into text the AI can act on next turn.
function formatWebResultsForAI(results) {
  if (!Array.isArray(results) || results.length === 0) return "(no web results)";
  return results.slice(0, 8).map((r, idx) => [
    `${idx + 1}. ${r.title}`,
    `URL: ${r.url}`,
    r.source ? `Source: ${r.source}` : "",
    r.snippet ? `Snippet: ${r.snippet}` : ""
  ].filter(Boolean).join("\n")).join("\n\n");
}

async function runActionCard(part, cardKey, statusSpan, approveBtn, messageId) {
  cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "working" };
  if (statusSpan) {
    statusSpan.className = "action-card-status working";
    statusSpan.textContent = "Processing...";
  }
  if (approveBtn) approveBtn.disabled = true;
  renderMessages();

  let toolResult = null;

  if (part.type === "execute_command") {
    const res = await window.orbit.runWorkspaceCommand({
      workspacePath,
      command: part.content.trim(),
      shell: part.shell || undefined
    });

    if (res && res.ok) {
      cardExecutionStates[cardKey] = {
        ...cardExecutionStates[cardKey],
        status: "success",
        output: res.stdout || res.stderr || "(no output)",
        exitCode: res.exitCode
      };
      toolResult =
        `[TOOL_RESULT] execute_command: \`${part.content.trim()}\`\n` +
        `exit code: ${res.exitCode}\n` +
        `stdout:\n${res.stdout || "(empty)"}\n` +
        `stderr:\n${res.stderr || "(empty)"}`;
    } else {
      cardExecutionStates[cardKey] = {
        ...cardExecutionStates[cardKey],
        status: "error",
        error: res?.error || "Execution failed",
        output: res?.stderr || res?.stdout || "",
        exitCode: res?.exitCode ?? 1
      };
      toolResult =
        `[TOOL_RESULT] execute_command FAILED: \`${part.content.trim()}\`\n` +
        `exit code: ${res?.exitCode ?? 1}\n` +
        `error: ${res?.error || "Execution failed"}\n` +
        `stderr:\n${res?.stderr || ""}`;
    }
  } else if (part.type === "write_file") {
    // Guard 1: missing path. AI sometimes emits <write_file> without the
    // path="..." attribute. Without a path we have nowhere to write.
    if (!part.path) {
      const msg = "write_file is missing the required path attribute. Use <write_file path=\"relative/path.ext\">...</write_file>.";
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: msg };
      toolResult = `[TOOL_RESULT] write_file FAILED: ${msg}`;
    }
    // Guard 2: no workspace open. Without a workspace, the file would land in
    // a random fallback directory. Tell the AI to ask the user to open one.
    else if (!workspacePath) {
      const msg = "No workspace is open. Ask the user to click the folder icon and select a project directory before writing files.";
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: msg };
      toolResult = `[TOOL_RESULT] write_file FAILED: ${msg}`;
    }
    else {
      const res = await window.orbit.writeWorkspaceFile({
        workspacePath,
        relativePath: part.path,
        content: part.content ?? ""
      });

      if (res && res.ok) {
        cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success" };
        await initWorkspace();
        toolResult = `[TOOL_RESULT] write_file: ${part.path} — written successfully (${(part.content || "").split(/\n/).length} lines).`;
      } else {
        cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "Write failed" };
        toolResult = `[TOOL_RESULT] write_file FAILED: ${part.path} — ${res?.error || "Write failed"}`;
      }
    }
  } else if (part.type === "read_file") {
    const res = await window.orbit.readWorkspaceFile({
      workspacePath,
      relativePath: part.path
    });

    if (res && res.ok) {
      if (part.start != null && part.end != null) {
        // Precise line-range read — slice the requested 1-indexed range and
        // number each line so the model can cite path:line accurately.
        const lines = String(res.content).split(/\r?\n/);
        const start = Math.max(1, part.start);
        const end = Math.min(lines.length, part.end);
        const slice = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join("\n");
        cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success", fileContent: slice };
        toolResult =
          `[TOOL_RESULT] read_file: ${part.path} (lines ${start}-${end})\n` +
          `--- FILE CONTENT START ---\n${slice}\n--- FILE CONTENT END ---`;
      } else {
        cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success", fileContent: res.content };
        toolResult =
          `[TOOL_RESULT] read_file: ${part.path}\n` +
          `--- FILE CONTENT START ---\n${res.content}\n--- FILE CONTENT END ---`;
      }
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "Read failed" };
      toolResult = `[TOOL_RESULT] read_file FAILED: ${part.path} — ${res?.error || "Read failed"}`;
    }
  } else if (part.type === "read_files") {
    const res = await window.orbit.readWorkspaceFiles({
      workspacePath,
      paths: part.paths || [],
      glob: part.glob || ""
    });
    if (res && res.ok) {
      const blocks = [];
      let okCount = 0;
      let errCount = 0;
      for (const f of res.files) {
        if (f.error) {
          errCount++;
          blocks.push(`--- FILE: ${f.path} (ERROR: ${f.error}) ---`);
        } else {
          okCount++;
          const note = f.truncatedFile ? " (truncated — byte budget)" : "";
          blocks.push(`--- FILE: ${f.path}${note} ---\n${f.content}`);
        }
      }
      const notes = [];
      if (res.fileCapped) notes.push("more files matched than the cap; narrow the glob to get the rest");
      if (res.bytesTruncated) notes.push("output trimmed at the context byte budget");
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success", fileCount: okCount };
      toolResult =
        `[TOOL_RESULT] read_files: ${okCount} file(s) read${errCount ? `, ${errCount} failed` : ""}` +
        `${notes.length ? ` [${notes.join("; ")}]` : ""}\n` +
        `--- BATCH READ START ---\n${blocks.join("\n\n")}\n--- BATCH READ END ---`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "Batch read failed" };
      toolResult = `[TOOL_RESULT] read_files FAILED: ${res?.error || "Batch read failed"}`;
    }
  } else if (part.type === "list_dir") {
    try {
      const info = await window.orbit.getWorkspaceInfo(workspacePath);
      if (info && !info.error) {
        const prefix = (part.path || "").replace(/^[./]+|\/+$/g, "");
        const all = (info.files || []).map((f) => (typeof f === "string" ? f : f.path));
        const inDir = prefix ? all.filter((p) => p === prefix || p.startsWith(prefix + "/")) : all;
        const depth = prefix ? prefix.split("/").length : 0;
        const children = new Set();
        for (const p of inDir) {
          const segs = p.split("/");
          if (segs.length > depth + 1) children.add(segs.slice(0, depth + 1).join("/") + "/");
          else children.add(p);
        }
        const list = Array.from(children).sort();
        cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success", fileList: list };
        toolResult = `[TOOL_RESULT] list_dir: ${part.path}\n${list.length ? list.map((c) => `- ${c}`).join("\n") : "(empty or no such directory)"}`;
      } else {
        cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: info?.error || "Workspace not available" };
        toolResult = `[TOOL_RESULT] list_dir FAILED: ${info?.error || "No workspace open"}`;
      }
    } catch (e) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: e?.message || String(e) };
      toolResult = `[TOOL_RESULT] list_dir FAILED: ${e?.message || e}`;
    }
  } else if (part.type === "delete_file") {
    const res = await window.orbit.deleteWorkspaceFile({ workspacePath, relativePath: part.path });
    if (res && res.ok) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success" };
      toolResult = `[TOOL_RESULT] delete_file: deleted ${part.path}`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "delete failed" };
      toolResult = `[TOOL_RESULT] delete_file FAILED: ${part.path} — ${res?.error || "delete failed"}`;
    }
  } else if (part.type === "move_file") {
    const res = await window.orbit.moveWorkspaceFile({ workspacePath, from: part.from, to: part.to });
    if (res && res.ok) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success" };
      toolResult = `[TOOL_RESULT] move_file: ${part.from} → ${part.to}`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "move failed" };
      toolResult = `[TOOL_RESULT] move_file FAILED: ${part.from} → ${part.to} — ${res?.error || "move failed"}`;
    }
  } else if (part.type === "create_directory") {
    const res = await window.orbit.createWorkspaceDir({ workspacePath, relativePath: part.path });
    if (res && res.ok) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success" };
      toolResult = `[TOOL_RESULT] create_directory: created ${part.path}`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "mkdir failed" };
      toolResult = `[TOOL_RESULT] create_directory FAILED: ${part.path} — ${res?.error || "mkdir failed"}`;
    }
  } else if (part.type === "git_status" || part.type === "git_diff" || part.type === "git_log") {
    const cmd = part.type === "git_status"
      ? "git status --porcelain=v1 -b"
      : part.type === "git_diff"
        ? `git --no-pager diff${part.path ? ` -- "${part.path}"` : ""}`
        : `git --no-pager log --oneline -n ${Math.min(Math.max(part.count || 20, 1), 100)}`;
    const res = await window.orbit.runWorkspaceCommand({ workspacePath, command: cmd });
    const out = `${(res?.stdout || "").trim()}${res?.stderr ? "\n--- stderr ---\n" + res.stderr.trim() : ""}`.trim() || "(no output)";
    if (res && res.ok) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success", output: out };
      toolResult = `[TOOL_RESULT] ${part.type}:\n${out}`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || out };
      toolResult = `[TOOL_RESULT] ${part.type} FAILED: ${res?.error || out}`;
    }
  } else if (part.type === "list_workspace") {
    try {
      const info = await window.orbit.getWorkspaceInfo(workspacePath);
      if (info && !info.error) {
        const fileLines = (info.files || []).map((f) => f.path);
        cardExecutionStates[cardKey] = {
          ...cardExecutionStates[cardKey],
          status: "success",
          fileList: fileLines
        };
        const preview = fileLines.length > 400 ? fileLines.slice(0, 400).join("\n") + `\n…(${fileLines.length - 400} more files truncated)` : fileLines.join("\n");
        toolResult =
          `[TOOL_RESULT] list_workspace: ${info.path}\n` +
          `${fileLines.length} files\n` +
          `--- FILE TREE START ---\n${preview}\n--- FILE TREE END ---`;
      } else {
        cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: info?.error || "Workspace not available" };
        toolResult = `[TOOL_RESULT] list_workspace FAILED: ${info?.error || "No workspace open"}`;
      }
    } catch (e) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: e?.message || String(e) };
      toolResult = `[TOOL_RESULT] list_workspace FAILED: ${e?.message || e}`;
    }
  } else if (part.type === "type_text") {
    const res = await window.orbit.typeIntoWindow({
      windowTitle: part.window,
      text: part.content || ""
    });

    const targetDesc = part.window ? `into "${part.window}"` : "into active window";
    if (res && res.ok) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success" };
      toolResult = `[TOOL_RESULT] type_text ${targetDesc} — typed ${(part.content || "").length} characters successfully.`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "Type failed" };
      toolResult = `[TOOL_RESULT] type_text ${targetDesc} FAILED: ${res?.error || "Type failed"}`;
    }
  } else if (part.type === "click_pixel") {
    const res = await window.orbit.clickPixel({
      x: part.x,
      y: part.y,
      button: part.button || "left",
      count: part.count || 1
    });
    const desc = `${part.button === "right" ? "right_click" : part.count === 2 ? "double_click" : "click_pixel"} at x=${part.x}, y=${part.y}`;
    if (res && res.ok) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success" };
      toolResult = `[TOOL_RESULT] ${desc} — clicked successfully.`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "Click failed" };
      toolResult = `[TOOL_RESULT] ${desc} FAILED: ${res?.error || "Click failed"}`;
    }
  } else if (part.type === "scroll") {
    const res = await window.orbit.scrollAt({ x: part.x, y: part.y, ticks: part.ticks });
    if (res && res.ok) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success" };
      toolResult = `[TOOL_RESULT] scroll at (${part.x}, ${part.y}) ticks=${part.ticks} — done.`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "scroll failed" };
      toolResult = `[TOOL_RESULT] scroll FAILED: ${res?.error || "scroll failed"}`;
    }
  } else if (part.type === "keystroke") {
    const res = await window.orbit.keystroke({ windowTitle: part.window || null, keys: part.content || "" });
    const where = part.window ? `into "${part.window}"` : "into active window";
    if (res && res.ok) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success" };
      toolResult = `[TOOL_RESULT] keystroke ${where} — sent "${part.content}".`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "keystroke failed" };
      toolResult = `[TOOL_RESULT] keystroke ${where} FAILED: ${res?.error || "keystroke failed"}`;
    }
  } else if (part.type === "focus_window") {
    const res = await window.orbit.focusWindow({ windowTitle: part.window });
    if (res && res.ok) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success" };
      toolResult = `[TOOL_RESULT] focus_window "${part.window}" — brought to front.`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "focus failed" };
      toolResult = `[TOOL_RESULT] focus_window FAILED: ${res?.error || "focus failed"}`;
    }
  } else if (part.type === "wait_ms") {
    const res = await window.orbit.waitMs({ ms: part.ms });
    cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success" };
    toolResult = `[TOOL_RESULT] wait_ms — paused ${res?.waitedMs ?? part.ms}ms.`;
  } else if (part.type === "open_browser") {
    const res = await window.orbit.openBrowser({
      url: part.url
    });

    if (res && res.ok) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success" };
      toolResult = `[TOOL_RESULT] open_browser: Opened URL "${part.url}" successfully.`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "Failed to open browser" };
      toolResult = `[TOOL_RESULT] open_browser FAILED: ${res?.error || "Failed to open browser"}`;
    }
  } else if (part.type === "open_url") {
    const res = await window.orbit.openBrowser({ url: part.url });
    if (res && res.ok) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success" };
      toolResult = `[TOOL_RESULT] open_url: Opened URL "${part.url}" successfully.`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "Failed to open URL" };
      toolResult = `[TOOL_RESULT] open_url FAILED: ${res?.error || "Failed to open URL"}`;
    }
  } else if (part.type === "web_search") {
    const res = await window.orbit.webSearch({ query: part.query });
    if (res && res.ok) {
      const results = Array.isArray(res.results) ? res.results : [];
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success", results };
      toolResult = `[TOOL_RESULT] web_search query="${part.query}":\n${formatWebResultsForAI(results)}`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "web search failed" };
      toolResult = `[TOOL_RESULT] web_search FAILED: ${res?.error || "web search failed"}`;
    }
  } else if (part.type === "deep_research") {
    const res = await window.orbit.deepSearch({ query: part.query });
    if (res && res.ok) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success", output: res.report || "" };
      toolResult = `[TOOL_RESULT] deep_research query="${part.query}":\n${res.report || "(no report returned)"}`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "deep research failed" };
      toolResult = `[TOOL_RESULT] deep_research FAILED: ${res?.error || "deep research failed"}`;
    }
  } else if (part.type === "read_webpage") {
    const res = await window.orbit.readWebpage({ url: part.url });
    if (res && res.ok) {
      const text = `${res.text || "(no readable text)"}`;
      const capped = text.length > 8000 ? `${text.slice(0, 8000)}\n\n[…truncated…]` : text;
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success" };
      toolResult = `[TOOL_RESULT] read_webpage url="${part.url}":\nTitle: ${res.title || part.url}\nURL: ${res.url || part.url}\n\n${capped}${res.truncated ? "\n\n[Page text truncated]" : ""}`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "read_webpage failed" };
      toolResult = `[TOOL_RESULT] read_webpage FAILED: ${res?.error || "read_webpage failed"}`;
    }
  } else if (part.type === "open_app") {
    const res = await window.orbit.openApp({ name: part.name, args: part.args });
    if (res && res.ok) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success" };
      toolResult = `[TOOL_RESULT] open_app: Launched "${part.name}" successfully.`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "Failed to open app" };
      toolResult = `[TOOL_RESULT] open_app FAILED: ${res?.error || "Failed to launch application"}`;
    }
  } else if (part.type === "list_windows") {
    try {
      const res = await window.orbit.listWindows();
      if (res && res.ok) {
        cardExecutionStates[cardKey] = {
          ...cardExecutionStates[cardKey],
          status: "success",
          windows: res.windows
        };
        const text = res.windows.map(w => `[PID ${w.pid}] ${w.processName} — "${w.title}"`).join("\n");
        toolResult = `[TOOL_RESULT] list_windows:\n--- WINDOW LIST START ---\n${text}\n--- WINDOW LIST END ---`;
      } else {
        cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "Failed to list windows" };
        toolResult = `[TOOL_RESULT] list_windows FAILED: ${res?.error || "Unknown error"}`;
      }
    } catch (e) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: e?.message || String(e) };
      toolResult = `[TOOL_RESULT] list_windows FAILED: ${e?.message || e}`;
    }
  } else if (part.type === "deploy_agent") {
    let count = 1;
    const selectEl = document.getElementById(`count-select-${cardKey}`);
    if (selectEl) {
      count = parseInt(selectEl.value, 10) || 1;
    }

    const agents = [];
    let deployedSuccessfully = 0;
    let lastError = null;

    for (let i = 0; i < count; i++) {
      const res = await window.orbit.deployAgent({
        workspacePath,
        task: part.task,
        model: selectedModel
      });

      if (res && res.ok) {
        agents.push({
          agentId: res.agentId,
          logPath: res.logPath
        });
        deployedSuccessfully++;
      } else {
        lastError = res?.error || "Failed to deploy agent";
      }
    }

    if (deployedSuccessfully > 0) {
      cardExecutionStates[cardKey] = {
        ...cardExecutionStates[cardKey],
        status: "success",
        agentId: agents[0].agentId,
        logPath: agents[0].logPath,
        agents: agents
      };
      const countDesc = count > 1 ? `${deployedSuccessfully} autonomous background agents` : `autonomous background agent`;
      toolResult = `[TOOL_RESULT] deploy_agent: Successfully deployed ${countDesc} with Agent IDs: ${agents.map(a => `\`${a.agentId}\``).join(", ")}. Their progress is being logged.`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: lastError || "Failed to deploy agent" };
      toolResult = `[TOOL_RESULT] deploy_agent FAILED: ${lastError || "Failed to deploy agent"}`;
    }
  }

  if (toolResult) {
    cardExecutionStates[cardKey].toolResult = toolResult;
  }
  renderMessages();

  if (messageId) {
    const msg = chatMessages.find(m => m.id === messageId);
    if (msg) {
      const msgParts = parseAIResponse(msg.content);
      const toolParts = msgParts.filter(p => p.type !== "text" && p.type !== "ask_user_questions");
      const allDone = toolParts.every((p, idx) => {
        const key = `${messageId}-${p.type}-${p.path || "command"}-${idx}`;
        const state = cardExecutionStates[key];
        return state && (state.status === "success" || state.status === "error");
      });

      if (allDone) {
        const hasDeployAgent = toolParts.some(p => p.type === "deploy_agent");
        // Continue the turn in agent mode, OR when the message only used
        // read-only tools (web_search / read_webpage / read_file, etc.) that
        // auto-run even in ask mode. Otherwise the AI never sees the tool
        // result and the conversation dead-ends right after the tool runs.
        const allReadOnly = toolParts.length > 0 && toolParts.every(p => READ_ONLY_TOOLS.has(p.type));
        const results = toolParts.map((p, idx) => {
          const key = `${messageId}-${p.type}-${p.path || "command"}-${idx}`;
          return cardExecutionStates[key]?.toolResult;
        }).filter(Boolean);

        if (results.length > 0 && !hasDeployAgent && (agentMode || allReadOnly)) {
          await sendToolResult(results.join("\n\n"));
        }
      }
    }
  }
}

// Send a tool result back to the AI as a continuation turn.
// This is what makes <read_file>, <write_file>, <execute_command> chain instead
// of dead-ending after the first action.
async function sendToolResult(toolResultText) {
  if (agentStepsThisTurn >= MAX_AGENT_STEPS) {
    chatMessages = [
      ...chatMessages,
      {
        id: createId(),
        role: "assistant",
        content: `[Agent loop stopped: reached ${MAX_AGENT_STEPS}-step limit for this turn. Send another message to continue.]`,
        timestamp: new Date().toISOString(),
        model: selectedModel,
        error: true
      }
    ];
    renderMessages();
    await persistHistory();
    return;
  }
  agentStepsThisTurn += 1;

  setStatus("working");
  sendButton.disabled = true;

  const userMessage = {
    id: createId(),
    role: "user",
    content: toolResultText,
    timestamp: new Date().toISOString(),
    model: selectedModel,
    isToolResult: true
  };

  const pendingId = createId();
  const pendingMessage = {
    id: pendingId,
    role: "assistant",
    content: "",
    timestamp: new Date().toISOString(),
    model: selectedModel,
    streaming: true
  };

  chatMessages = [...chatMessages, userMessage, pendingMessage];
  renderMessages();

  const cleanMessages = chatMessages
    .filter((m) => !m.pending && !m.streaming && (m.role === "user" || m.role === "assistant") && m.content?.trim())
    .map((m) => ({ role: m.role, content: m.content }));
  const apiMessages = unsummarizedTail(cleanMessages, summarizedCount);

  const result = await callAIStreaming(apiMessages, null, pendingId);

  try {
    chatMessages = chatMessages.map((m) => {
      if (m.id !== pendingId) return m;
      if (result?.ok) {
        return {
          id: m.id,
          role: "assistant",
          content: result.content,
          timestamp: new Date().toISOString(),
          model: selectedModel
        };
      }
      // Stopped is a normal user action, not an error — quieter UX.
      if (result?.stopped) {
        toast("Stopped");
        return {
          id: m.id,
          role: "assistant",
          content: "(Stopped by user)",
          timestamp: new Date().toISOString(),
          model: selectedModel,
          error: true
        };
      }
      toast(result?.error || "Request failed", { variant: "error", duration: 5000 });
      return {
        id: m.id,
        role: "assistant",
        content: `Error: ${result?.error || "Unknown failure"}`,
        timestamp: new Date().toISOString(),
        model: selectedModel,
        error: true
      };
    });

    renderMessages();
    try { await persistHistory(); } catch (e) { console.warn("persistHistory failed:", e); }
  } finally {
    resetInputState();
  }
}

// Shared streaming call. Finds the streaming bubble for `pendingId` in the
// DOM, binds the typing animator to its content element, fires the streaming
// AI request, and returns the final `{ ok, content | error }` result. Both
// sendMessage and sendToolResult use this.
function buildWorkspaceContext() {
  if (!workspacePath) return null;

  // Build a compact summary: top-level entries + total file count.
  // The AI can request the full tree via <list_workspace /> if it needs more.
  const topLevel = new Set();
  for (const f of workspaceFiles) {
    const head = f.path.split("/")[0];
    if (head) topLevel.add(head);
  }
  return {
    path: workspacePath,
    fileCount: workspaceFiles.length,
    topLevel: Array.from(topLevel).slice(0, 40).sort()
  };
}

async function callAIStreaming(apiMessages, screenshotPath, pendingId) {
  ensureChunkListener();
  const streamId = createId();
  const targetEl = document.querySelector(`[data-msg-id="${pendingId}"] .streaming-text`);
  if (targetEl) {
    beginAIStream(targetEl, streamId);
  }

  // Expose this stream's id so the Send button (now acting as Stop) and the
  // Esc handler can call window.orbit.abortAI(streamId) to cancel mid-stream.
  currentStreamId = streamId;
  setSendButtonMode("stop");

  let result;
  try {
    result = await window.orbit.sendToAI({
      model: selectedModel,
      messages: apiMessages,
      screenshotPath,
      agentMode,
      streamId,
      workspaceContext: buildWorkspaceContext(),
      mode: currentMode,
      conversationSummary
    });
  } catch (error) {
    result = { ok: false, error: error?.message || String(error) };
  } finally {
    endAIStream();
    currentStreamId = null;
    setSendButtonMode("send");
  }
  return result;
}

let currentStreamId = null;

const SEND_ARROW_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="13 6 19 12 13 18" /></svg>`;
const STOP_SQUARE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>`;

function setSendButtonMode(mode) {
  if (mode === "stop") {
    sendButton.dataset.mode = "stop";
    sendButton.innerHTML = STOP_SQUARE_SVG;
    sendButton.disabled = false;
    sendButton.title = "Stop generating (Esc)";
    sendButton.setAttribute("aria-label", "Stop");
  } else {
    sendButton.dataset.mode = "send";
    sendButton.innerHTML = SEND_ARROW_SVG;
    sendButton.title = "Send";
    sendButton.setAttribute("aria-label", "Send");
  }
}

async function abortCurrentStream() {
  if (currentStreamId) {
    try {
      await window.orbit.abortAI(currentStreamId);
    } catch (e) {
      console.warn("abort failed:", e);
    }
  }
}

function parseFlashcardsBlock(body) {
  const text = String(body || "").trim();
  if (!text) return null;
  const entries = text.split(/^\s*---\s*$/m);
  const cards = [];
  for (const entry of entries) {
    const qMatch = entry.match(/^\s*Q:\s*([\s\S]*?)(?=^\s*A:|\Z)/m);
    const aMatch = entry.match(/^\s*A:\s*([\s\S]*)$/m);
    if (qMatch && aMatch) {
      cards.push({ q: qMatch[1].trim(), a: aMatch[1].trim() });
    }
  }
  return cards.length > 0 ? cards : null;
}

function buildFlashcardWidget(cards, sourceId) {
  const widget = document.createElement("div");
  widget.className = "flashcard-widget";

  const header = document.createElement("div");
  header.className = "flashcard-header";
  const title = document.createElement("span");
  title.className = "flashcard-title";
  title.textContent = `Flashcards · ${cards.length} card${cards.length === 1 ? "" : "s"}`;
  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.className = "flashcard-export";
  exportBtn.textContent = "Export CSV";
  header.append(title, exportBtn);

  const card = document.createElement("div");
  card.className = "flashcard-card";
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");

  const faceLabel = document.createElement("div");
  faceLabel.className = "flashcard-face-label";
  const faceText = document.createElement("div");
  faceText.className = "flashcard-face-text";
  const hint = document.createElement("div");
  hint.className = "flashcard-hint";
  hint.textContent = "Click or press Space to flip";
  card.append(faceLabel, faceText, hint);

  const controls = document.createElement("div");
  controls.className = "flashcard-controls";
  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "flashcard-nav";
  prevBtn.textContent = "‹ Prev";
  const progress = document.createElement("span");
  progress.className = "flashcard-progress";
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "flashcard-nav";
  nextBtn.textContent = "Next ›";
  controls.append(prevBtn, progress, nextBtn);

  widget.append(header, card, controls);

  let idx = 0;
  let showingAnswer = false;
  const update = () => {
    const c = cards[idx];
    faceLabel.textContent = showingAnswer ? "Answer" : "Question";
    faceText.textContent = showingAnswer ? c.a : c.q;
    progress.textContent = `${idx + 1} / ${cards.length}`;
    prevBtn.disabled = idx === 0;
    nextBtn.disabled = idx === cards.length - 1;
    card.classList.toggle("is-flipped", showingAnswer);
  };
  const flip = () => { showingAnswer = !showingAnswer; update(); };
  const go = (delta) => {
    const next = idx + delta;
    if (next < 0 || next >= cards.length) return;
    idx = next;
    showingAnswer = false;
    update();
  };
  card.addEventListener("click", flip);
  card.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
  });
  prevBtn.addEventListener("click", () => go(-1));
  nextBtn.addEventListener("click", () => go(1));

  exportBtn.addEventListener("click", () => {
    const escape = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const csv = ["Question,Answer"].concat(cards.map((c) => `${escape(c.q)},${escape(c.a)}`)).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `orbit-flashcards-${sourceId || Date.now()}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  update();
  return widget;
}

function appendTextWithFlashcards(container, text, sourceId) {
  const re = /```flashcards\s*\n([\s\S]*?)\n```/g;
  let lastIdx = 0;
  let match;
  let widgetIdx = 0;
  while ((match = re.exec(text)) !== null) {
    const before = text.slice(lastIdx, match.index);
    if (before.trim()) {
      const p = document.createElement("p");
      p.className = "message-content";
      p.innerHTML = renderMarkdown(before);
      container.append(p);
    }
    const cards = parseFlashcardsBlock(match[1]);
    if (cards) {
      container.append(buildFlashcardWidget(cards, `${sourceId || "msg"}-${widgetIdx++}`));
    } else {
      const p = document.createElement("p");
      p.className = "message-content";
      p.innerHTML = renderMarkdown("```\n" + match[1] + "\n```");
      container.append(p);
    }
    lastIdx = re.lastIndex;
  }
  const tail = text.slice(lastIdx);
  if (tail.trim() || lastIdx === 0) {
    const p = document.createElement("p");
    p.className = "message-content";
    p.innerHTML = renderMarkdown(tail);
    container.append(p);
  }
}

function renderAskUserQuestionsCard(part, messageId) {
  const card = document.createElement("div");
  card.className = "action-card action-ask-user-questions";
  
  const head = document.createElement("div");
  head.className = "action-card-header";
  head.innerHTML = `
    <div style="display: flex; align-items: center; gap: 8px;">
      <span class="action-icon" style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #38bdf8; box-shadow: 0 0 8px #38bdf8;"></span>
      <span class="action-card-type write" style="font-weight: 600; color: #38bdf8;">Clarifying Questions</span>
    </div>
  `;
  card.append(head);

  const qList = parseQuestions(part.content || "");
  if (qList.length === 0) {
    const body = document.createElement("pre");
    body.className = "action-card-body";
    body.style.whiteSpace = "pre-wrap";
    body.textContent = part.content;
    card.append(body);
    return card;
  }

  const formContainer = document.createElement("div");
  formContainer.className = "action-card-body ask-questions-form-container";
  formContainer.style.padding = "14px";
  
  const form = document.createElement("form");
  form.className = "ask-questions-form";
  
  const inputs = [];
  qList.forEach((q, idx) => {
    const qGroup = document.createElement("div");
    qGroup.className = "ask-question-group";
    qGroup.style.marginBottom = "14px";
    
    const label = document.createElement("label");
    label.className = "ask-question-label";
    label.style.display = "block";
    label.style.marginBottom = "6px";
    label.style.fontWeight = "500";
    label.style.fontSize = "12px";
    label.style.color = "rgba(255, 255, 255, 0.8)";
    label.textContent = `${idx + 1}. ${q.text}`;
    qGroup.append(label);
    
    let inputEl;
    if (q.type === "select") {
      inputEl = document.createElement("select");
      inputEl.className = "ask-question-select";
      inputEl.style.width = "100%";
      inputEl.style.padding = "8px 12px";
      inputEl.style.borderRadius = "6px";
      inputEl.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
      inputEl.style.border = "1px solid rgba(255, 255, 255, 0.1)";
      inputEl.style.color = "#ffffff";
      inputEl.style.fontSize = "12px";
      inputEl.style.outline = "none";
      
      q.options.forEach(opt => {
        const option = document.createElement("option");
        option.value = opt;
        option.textContent = opt;
        option.style.backgroundColor = "#1e1e1e";
        option.style.color = "#ffffff";
        inputEl.append(option);
      });
    } else {
      inputEl = document.createElement("input");
      inputEl.type = "text";
      inputEl.className = "ask-question-input";
      inputEl.placeholder = "Type your answer...";
      inputEl.style.width = "100%";
      inputEl.style.padding = "8px 12px";
      inputEl.style.borderRadius = "6px";
      inputEl.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
      inputEl.style.border = "1px solid rgba(255, 255, 255, 0.1)";
      inputEl.style.color = "#ffffff";
      inputEl.style.fontSize = "12px";
      inputEl.style.outline = "none";
      
      // Prevent keystrokes from bubbling to window level
      inputEl.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
      });
    }
    
    qGroup.append(inputEl);
    form.append(qGroup);
    inputs.push({ questionText: q.text, element: inputEl });
  });
  
  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "ask-questions-submit-btn";
  submitBtn.textContent = "Submit Answers";
  submitBtn.style.padding = "8px 16px";
  submitBtn.style.borderRadius = "6px";
  submitBtn.style.backgroundColor = "rgba(56, 189, 248, 0.2)";
  submitBtn.style.border = "1px solid rgba(56, 189, 248, 0.4)";
  submitBtn.style.color = "#38bdf8";
  submitBtn.style.fontWeight = "600";
  submitBtn.style.fontSize = "12px";
  submitBtn.style.cursor = "pointer";
  submitBtn.style.transition = "background-color 0.2s, transform 0.1s";
  
  submitBtn.addEventListener("mouseover", () => {
    if (!submitBtn.disabled) {
      submitBtn.style.backgroundColor = "rgba(56, 189, 248, 0.35)";
    }
  });
  submitBtn.addEventListener("mouseout", () => {
    if (!submitBtn.disabled) {
      submitBtn.style.backgroundColor = "rgba(56, 189, 248, 0.2)";
    }
  });
  
  // If a later user message already answered these questions, lock the card and
  // restore the submitted values (parsed back by position) so the Q&A stays
  // visible as one unit. The answer message itself isn't rendered as a separate
  // bubble — see renderMessages.
  let isAnswered = false;
  let priorAnswers = [];
  const msgIdx = chatMessages.findIndex(m => m.id === messageId);
  if (msgIdx !== -1) {
    for (let i = msgIdx + 1; i < chatMessages.length; i++) {
      const m = chatMessages[i];
      if (m.role === "user" && typeof m.content === "string" && m.content.startsWith("**User's Answers:**")) {
        isAnswered = true;
        priorAnswers = m.content.split("\n")
          .map((line) => line.match(/^\s*\d+\.\s*.+?:\s?(.*)$/))
          .filter(Boolean)
          .map((mm) => mm[1]);
        break;
      }
    }
  }

  if (isAnswered) {
    submitBtn.disabled = true;
    submitBtn.textContent = "✓ Answers Submitted";
    submitBtn.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
    submitBtn.style.border = "1px solid rgba(255, 255, 255, 0.1)";
    submitBtn.style.color = "rgba(255, 255, 255, 0.4)";
    submitBtn.style.cursor = "default";
    inputs.forEach((inp, idx) => {
      if (priorAnswers[idx] !== undefined) inp.element.value = priorAnswers[idx];
      inp.element.disabled = true;
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isAnswered) return;
    isAnswered = true;
    
    let answersText = "**User's Answers:**\n";
    inputs.forEach((inp, idx) => {
      answersText += `${idx + 1}. ${inp.questionText}: ${inp.element.value}\n`;
    });
    
    submitBtn.disabled = true;
    submitBtn.textContent = "Answers Submitted";
    submitBtn.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
    submitBtn.style.border = "1px solid rgba(255, 255, 255, 0.1)";
    submitBtn.style.color = "rgba(255, 255, 255, 0.4)";
    submitBtn.style.cursor = "default";
    inputs.forEach(inp => inp.element.disabled = true);

    sendMessage(answersText).catch(() => {});
  });
  
  form.append(submitBtn);
  formContainer.append(form);
  card.append(formContainer);
  return card;
}

function renderAssistantMessage(message, container) {
  const parts = parseAIResponse(message.content);

  let partIndex = 0;
  let toolGroup = [];
  const flushToolGroup = () => {
    if (!toolGroup.length) return;
    container.append(renderInlineToolBadges(
      toolGroup.map((item) => item.part),
      (part, idx) => {
        const item = toolGroup[idx];
        const key = `${message.id}-${item.part.type}-${item.part.path || "command"}-${item.partIndex}`;
        return cardExecutionStates[key]?.status || "running";
      }
    ));
    container.append(renderThinkingBlock(toolGroup, message.id));
    toolGroup = [];
  };

  for (const part of parts) {
    if (part.type === "text") {
      flushToolGroup();
      appendTextWithFlashcards(container, part.content, message.id);
    } else if (part.type === "ask_user_questions") {
      flushToolGroup();
      container.append(renderAskUserQuestionsCard(part, message.id));
    } else {
      toolGroup.push({ part, partIndex });
      partIndex++;
    }
  }
  flushToolGroup();


  // Auto Mode: kick off any still-pending action cards immediately, without
  // waiting for a click. Runs at most one action per render to avoid races —
  // the next card will fire after the tool result comes back and re-renders.
  if (autoMode || agentMode || parts.some((part) => READ_ONLY_TOOLS.has(part.type))) {
    let loopPartIndex = 0;
    for (const part of parts) {
      if (part.type === "text" || part.type === "ask_user_questions") continue;
      if (part.type === "deploy_agent" && !isSummonAgentsAuthorized()) {
        loopPartIndex++;
        continue;
      }
      const cardKey = `${message.id}-${part.type}-${part.path || "command"}-${loopPartIndex}`;
      const state = cardExecutionStates[cardKey];
      const canAuto = autoMode || READ_ONLY_TOOLS.has(part.type) || (agentMode && AUTO_RUN_IN_AGENT_MODE.has(part.type));
      if (canAuto && (!state || state.status === "pending")) {
        // Claim the card synchronously so a second render can't double-fire.
        cardExecutionStates[cardKey] = { status: "working", queued: true };
        // Defer so the DOM commits before we mutate state.
        setTimeout(() => runActionCard(part, cardKey, null, null, message.id), 0);
        break;
      }
      loopPartIndex++;
    }
  }
}

// Message Timeline Renderer
function renderMessages() {
  messages.innerHTML = "";

  if (chatMessages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No messages yet. Ask Orbit anything about your workspace!";
    messages.append(empty);
    return;
  }

  for (const message of chatMessages) {
    if (message.isToolResult) {
      continue;
    }
    // Clarifying-question answers are shown inside the question card itself, so
    // don't also render them as a separate user bubble — keeps the ask/answer
    // exchange feeling like one message.
    if (message.role === "user" && typeof message.content === "string" && message.content.startsWith("**User's Answers:**")) {
      continue;
    }
    const item = document.createElement("article");
    item.className = `message message-${message.role}`;
    item.dataset.msgId = message.id;
    if (message.pending) item.classList.add("is-pending");
    if (message.streaming) item.classList.add("is-streaming");
    if (message.error) item.classList.add("is-error");

    if (message.streaming) {
      const meta = document.createElement("div");
      meta.className = "message-meta";
      meta.textContent = `Orbit · ${selectedModel}`;

      const content = document.createElement("p");
      content.className = "message-content streaming-content";

      // Two siblings: a text span the animator types into, and a blinking
      // caret pinned next to the latest character.
      const textSpan = document.createElement("span");
      textSpan.className = "streaming-text";
      const cursor = document.createElement("span");
      cursor.className = "streaming-cursor";
      content.append(textSpan, cursor);

      item.append(meta, content);
      messages.append(item);
      continue;
    }

    if (message.role === "assistant" && !message.pending) {
      const meta = document.createElement("div");
      meta.className = "message-meta";
      meta.textContent = `Orbit · ${formatTime(message.timestamp)}`;

      const speakBtn = document.createElement("button");
      speakBtn.className = "voice-button";
      speakBtn.type = "button";
      speakBtn.title = "Read aloud";
      speakBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 5L6 9H2v6h4l5 4V5z"/>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
        </svg>
      `;
      speakBtn.addEventListener("click", () => {
        speakText(message.content);
      });
      meta.append(speakBtn);

      item.append(meta);
      renderAssistantMessage(message, item);
    } else if (message.pending) {
      const meta = document.createElement("div");
      meta.className = "message-meta";
      meta.textContent = `Orbit · thinking`;

      const indicator = document.createElement("div");
      indicator.className = "thinking-indicator";
      for (let i = 0; i < 3; i++) {
        const bar = document.createElement("div");
        bar.className = "shimmer-bar";
        indicator.append(bar);
      }

      item.append(meta, indicator);
    } else {
      const meta = document.createElement("div");
      meta.className = "message-meta";
      meta.textContent = `${message.role === "user" ? "You" : "Orbit"} · ${formatTime(message.timestamp)}`;

      const content = document.createElement("p");
      content.className = "message-content";
      content.textContent = message.content;

      item.append(meta, content);
    }

    if (message.screenshotPath) {
      const attachment = document.createElement("div");
      attachment.className = "attachment";
      attachment.textContent = "Screenshot context attached";
      item.append(attachment);
    }

    messages.append(item);
  }

  // Smooth scroll to the latest message
  messages.scrollTo({
    top: messages.scrollHeight,
    behavior: "smooth"
  });

  // Belt-and-suspenders: if no AI request is currently in flight, make sure
  // the input is unlocked. Cheap defensive cleanup against any orphaned
  // disabled state that an earlier error might have left behind.
  const hasInFlight = chatMessages.some((m) => m.pending || m.streaming);
  if (!hasInFlight) {
    promptInput.disabled = false;
    promptInput.readOnly = false;
    sendButton.disabled = false;
  }
}

// Send Chat Message
async function sendMessage(content) {
  closeModelDropdown();
  let trimmed = content.trim();
  if (!trimmed) {
    return;
  }

  const slashToolRequest = parseSlashToolCommand(trimmed);
  if (slashToolRequest?.error) {
    toast(slashToolRequest.error, { variant: "error" });
    resetInputState();
    return;
  }
  if (slashToolRequest) {
    agentStepsThisTurn = 0;
    const now = new Date().toISOString();
    chatMessages = [...chatMessages, {
      id: createId(),
      role: "user",
      content: trimmed,
      timestamp: now,
      model: selectedModel
    }, {
      id: createId(),
      role: "assistant",
      content: slashToolRequest.assistantContent,
      timestamp: now,
      model: selectedModel
    }];
    promptInput.value = "";
    selectedFiles.clear();
    renderFilesList();
    renderContextTray();
    renderMessages();
    setOverlayState("expanded");
    try { await persistHistory(); } catch (e) { console.warn("persistHistory failed:", e); }
    return;
  }

  // Fresh user turn — reset agent step counter so the loop can run again.
  agentStepsThisTurn = 0;

  sendButton.disabled = true;
  setStatus("working");

  // 1. Compile selected files context
  let contextText = "";
  if (selectedFiles.size > 0) {
    for (const relPath of selectedFiles) {
      try {
        const fileData = await window.orbit.readWorkspaceFile({
          workspacePath,
          relativePath: relPath
        });
        if (fileData && fileData.ok) {
          contextText += `=== WORKSPACE FILE CONTEXT: ${relPath} ===\n${fileData.content}\n=======================================\n\n`;
        }
      } catch (e) {
        // ignore
      }
    }
  }

  // 2. Capture primary screen screenshot (or use a pasted image if present).
  // A pasted image takes priority: the user explicitly attached it, so we
  // don't want to clobber it with an auto-screenshot.
  let screenshotPath = null;
  if (pastedImageDataUrl) {
    try {
      const res = await window.orbit.savePastedImage(pastedImageDataUrl);
      if (res?.ok) screenshotPath = res.path;
    } catch {
      screenshotPath = null;
    }
    pastedImageDataUrl = null;
    pastedImageThumb = null;
    renderContextTray();
  } else if (attachScreenshot && (forceScreenshotNextSend || messageNeedsScreen(trimmed))) {
    // Only grab the screen when the toggle is on AND the message actually
    // refers to what's visible (or the user forced it for this send). This
    // keeps general questions from being answered against the screenshot.
    try {
      screenshotPath = await window.orbit.captureScreen();
    } catch {
      screenshotPath = null;
    }
  }
  // One-shot force flag is consumed by every send regardless of outcome.
  forceScreenshotNextSend = false;

  // Create message bubbles
  const userMessage = {
    id: createId(),
    role: "user",
    content: trimmed,
    timestamp: new Date().toISOString(),
    model: selectedModel,
    screenshotPath
  };

  const pendingId = createId();
  const pendingMessage = {
    id: pendingId,
    role: "assistant",
    content: "",
    timestamp: new Date().toISOString(),
    model: selectedModel,
    streaming: true
  };

  chatMessages = [...chatMessages, userMessage, pendingMessage];
  promptInput.value = "";

  // Reset attached files selections
  selectedFiles.clear();
  renderFilesList();
  renderContextTray();

  renderMessages();
  setOverlayState("expanded");

  // Retrieve clean API conversation thread. Older turns are represented by
  // conversationSummary (injected into the system prompt), so we only send the
  // verbatim tail that the summary doesn't yet cover. This keeps context small
  // while the model still "remembers" far-back turns via the summary.
  const cleanMessages = chatMessages
    .filter((m) => !m.pending && !m.streaming && (m.role === "user" || m.role === "assistant") && m.content?.trim())
    .map((m) => ({ role: m.role, content: m.content }));
  const apiMessages = unsummarizedTail(cleanMessages, summarizedCount);

  // Attach workspace code context to the last message payload
  if (contextText && apiMessages.length > 0) {
    const lastMsg = apiMessages[apiMessages.length - 1];
    if (lastMsg.role === "user") {
      lastMsg.content = `${contextText}\nUSER QUESTION: ${lastMsg.content}`;
    }
  }

  const result = await callAIStreaming(apiMessages, screenshotPath, pendingId);

  try {
    chatMessages = chatMessages.map((m) => {
      if (m.id !== pendingId) return m;
      if (result?.ok) {
        return {
          id: m.id,
          role: "assistant",
          content: result.content,
          timestamp: new Date().toISOString(),
          model: selectedModel
        };
      }
      if (result?.stopped) {
        toast("Stopped");
        return {
          id: m.id,
          role: "assistant",
          content: "(Stopped by user)",
          timestamp: new Date().toISOString(),
          model: selectedModel,
          error: true
        };
      }
      toast(result?.error || "Request failed", { variant: "error", duration: 5000 });
      return {
        id: m.id,
        role: "assistant",
        content: `Error: ${result?.error || "Unknown failure"}`,
        timestamp: new Date().toISOString(),
        model: selectedModel,
        error: true
      };
    });

    renderMessages();
    if (autoSpeakEnabled && result?.ok) {
      try { speakText(result.content); } catch (e) { console.warn("speakText failed:", e); }
    }
    try { await persistHistory(); } catch (e) { console.warn("persistHistory failed:", e); }
    // Fire-and-forget: fold any turns that scrolled past the verbatim window
    // into the rolling summary so the next request stays small. Runs after the
    // reply is already shown, so it never adds latency to this turn.
    maybeSummarizeOlderTurns();
  } finally {
    // ALWAYS re-enable, even if something above threw.
    resetInputState();
  }
}

// When the conversation outgrows the verbatim window, compress the overflow
// into conversationSummary (and harvest durable user facts) via a cheap model
// call in the main process. Guarded so only one summarization runs at a time.
async function maybeSummarizeOlderTurns() {
  if (summarizing) return;
  const clean = chatMessages
    .filter((m) => !m.pending && !m.streaming && (m.role === "user" || m.role === "assistant") && m.content?.trim())
    .map((m) => ({ role: m.role, content: m.content }));
  const plan = planSummarization(clean.length, summarizedCount);
  if (!plan.shouldSummarize) return;

  summarizing = true;
  try {
    const slice = clean.slice(plan.fromIndex, plan.toIndex);
    const res = await window.orbit.summarizeMemory({
      priorSummary: conversationSummary,
      transcript: transcriptFor(slice)
    });
    // Guard against the chat being cleared/reset while the call was in flight:
    // only apply if the conversation is still at least as long as what we summarized.
    const currentLen = chatMessages.filter(
      (m) => !m.pending && !m.streaming && (m.role === "user" || m.role === "assistant") && m.content?.trim()
    ).length;
    if (res?.ok && typeof res.summary === "string" && plan.newSummarizedCount <= currentLen) {
      conversationSummary = res.summary;
      summarizedCount = plan.newSummarizedCount;
      try { await persistHistory(); } catch (e) { console.warn("persistHistory (summary) failed:", e); }
    }
  } catch (e) {
    console.warn("summarizeMemory failed:", e);
  } finally {
    summarizing = false;
  }
}

function updateModeUI() {
  if (modeSelectBtn) {
    const textSpan = modeSelectBtn.querySelector("span");
    if (textSpan) {
      textSpan.textContent = currentMode.charAt(0).toUpperCase() + currentMode.slice(1);
    }
  }
  if (modeSelectOptions) {
    modeSelectOptions.querySelectorAll(".custom-select-option").forEach(opt => {
      opt.classList.toggle("selected", opt.dataset.value === currentMode);
    });
  }
}

function updateAutoModeUI() {
  if (autoMode) {
    autoModeButton.classList.add("is-active");
    autoModeButton.title = "Auto Mode ON — actions run without confirmation";
  } else {
    autoModeButton.classList.remove("is-active");
    autoModeButton.title = "Auto Mode OFF — each action requires approval";
  }
}

function updateScreenshotToggleUI() {
  if (attachScreenshot) {
    screenshotToggleButton.classList.add("is-active");
    screenshotToggleButton.title = "Screen context ON — your screen is attached only when your message refers to it";
  } else {
    screenshotToggleButton.classList.remove("is-active");
    screenshotToggleButton.title = "Screen context OFF — messages sent without screenshot";
  }
}

// UI Event Listeners
bar.addEventListener("mouseenter", () => {
  if (overlay.dataset.state !== "expanded" && !modelSelectOptions.classList.contains("open")) {
    setOverlayState("hover");
  }
});

overlay.addEventListener("mouseleave", (event) => {
  if (overlay.dataset.state === "expanded" || modelSelectOptions.classList.contains("open")) {
    return;
  }
  if (document.activeElement && overlay.contains(document.activeElement)) {
    return;
  }
  const next = event.relatedTarget;
  if (next && overlay.contains(next)) {
    return;
  }
  setOverlayState("collapsed");
});

bar.addEventListener("click", (event) => {
  if (event.target.closest("button, input, select")) {
    return;
  }
  setOverlayState("expanded");
  promptInput.focus();
});

closeButton.addEventListener("click", () => {
  setOverlayState("collapsed");
});

if (fullAppButton) {
  fullAppButton.addEventListener("click", async () => {
    await window.orbit.setAppMode("app");
  });
}

function closeModelDropdown() {
  if (modelSelectOptions && modelSelectOptions.classList.contains("open")) {
    modelSelectOptions.classList.remove("open");
    if (overlay.dataset.state === "dropdown-open" && (!modeSelectOptions || !modeSelectOptions.classList.contains("open"))) {
      setTimeout(() => {
        if (!modelSelectOptions.classList.contains("open") && (!modeSelectOptions || !modeSelectOptions.classList.contains("open")) && overlay.dataset.state === "dropdown-open") {
          setOverlayState("collapsed");
        }
      }, 200);
    }
  }
}

function closeModeDropdown() {
  if (modeSelectOptions && modeSelectOptions.classList.contains("open")) {
    modeSelectOptions.classList.remove("open");
    if (overlay.dataset.state === "dropdown-open" && (!modelSelectOptions || !modelSelectOptions.classList.contains("open"))) {
      setTimeout(() => {
        if (!modeSelectOptions.classList.contains("open") && (!modelSelectOptions || !modelSelectOptions.classList.contains("open")) && overlay.dataset.state === "dropdown-open") {
          setOverlayState("collapsed");
        }
      }, 200);
    }
  }
}

function expandSelectedModelCategory() {
  if (!modelSelectOptions) return;
  modelSelectOptions.querySelectorAll(".custom-select-category").forEach((cat) => {
    const hasSelected = !!cat.querySelector(".custom-select-option.selected");
    cat.classList.toggle("is-open", hasSelected);
  });
}

if (modelSelectBtn && modelSelectOptions) {
  modelSelectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeModeDropdown();
    const willOpen = !modelSelectOptions.classList.contains("open");
    if (willOpen) {
      modelSelectOptions.classList.add("open");
      expandSelectedModelCategory();
      if (overlay.dataset.state !== "expanded") {
        setOverlayState("dropdown-open");
      }
    } else {
      closeModelDropdown();
    }
  });

  modelSelectOptions.addEventListener("click", async (e) => {
    const header = e.target.closest(".custom-select-category-header");
    if (header) {
      e.stopPropagation();
      const cat = header.parentElement;
      const wasOpen = cat.classList.contains("is-open");
      modelSelectOptions.querySelectorAll(".custom-select-category").forEach((c) => {
        if (c !== cat) c.classList.remove("is-open");
      });
      cat.classList.toggle("is-open", !wasOpen);
      return;
    }

    const option = e.target.closest(".custom-select-option");
    if (!option) return;

    e.stopPropagation();
    selectedModel = option.dataset.value;
    
    const textSpan = modelSelectBtn.querySelector("span");
    if (textSpan) textSpan.textContent = selectedModel;

    modelSelectOptions.querySelectorAll(".custom-select-option").forEach(opt => {
      opt.classList.toggle("selected", opt === option);
    });

    closeModelDropdown();
    updatePanelSubtitle();
    await persistHistory();
  });
}

if (modeSelectBtn && modeSelectOptions) {
  modeSelectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeModelDropdown();
    const willOpen = !modeSelectOptions.classList.contains("open");
    if (willOpen) {
      modeSelectOptions.classList.add("open");
      if (overlay.dataset.state !== "expanded") {
        setOverlayState("dropdown-open");
      }
    } else {
      closeModeDropdown();
    }
  });

  modeSelectOptions.addEventListener("click", async (e) => {
    const option = e.target.closest(".custom-select-option");
    if (!option) return;

    e.stopPropagation();
    currentMode = option.dataset.value;
    agentMode = (currentMode === "agents");

    const textSpan = modeSelectBtn.querySelector("span");
    if (textSpan) {
      textSpan.textContent = currentMode.charAt(0).toUpperCase() + currentMode.slice(1);
    }

    modeSelectOptions.querySelectorAll(".custom-select-option").forEach(opt => {
      opt.classList.toggle("selected", opt === option);
    });

    closeModeDropdown();

    // Auto-switch model to Orchestra 1.1 if currentMode === "planning"
    if (currentMode === "planning" && selectedModel !== "Orchestra 1.1") {
      selectedModel = "Orchestra 1.1";
      const modelTextSpan = modelSelectBtn.querySelector("span");
      if (modelTextSpan) modelTextSpan.textContent = selectedModel;
      modelSelectOptions.querySelectorAll(".custom-select-option").forEach(opt => {
        opt.classList.toggle("selected", opt.dataset.value === "Orchestra 1.1");
      });
    }

    updateModeUI();
    updatePanelSubtitle();
    toast(`Switched to ${currentMode.charAt(0).toUpperCase() + currentMode.slice(1)} Mode`);
    await persistHistory();
    resetInputState();
    promptInput.focus();
  });
}

document.addEventListener("click", () => {
  closeModelDropdown();
  closeModeDropdown();
});

// Screenshot Attachment Toggle
screenshotToggleButton.addEventListener("click", async () => {
  attachScreenshot = !attachScreenshot;
  // Turning it on is an explicit "look at my screen" signal — force a grab on
  // the next send even if the message doesn't obviously reference the screen.
  forceScreenshotNextSend = attachScreenshot;
  updateScreenshotToggleUI();
  updatePanelSubtitle();
  toast(attachScreenshot ? "Screen context on — next message includes your screen" : "Screen context off");
  await persistHistory();
  resetInputState();
  promptInput.focus();
});

// Auto Mode Button Toggle
autoModeButton.addEventListener("click", async () => {
  if (!autoMode) {
    const proceed = await customConfirm({
      title: "Enable Auto Mode?",
      message:
        "Orbit will execute every action (write files, run commands, read files) " +
        "WITHOUT asking for confirmation. Use only in workspaces you trust.",
      confirmText: "Enable Auto Mode",
      cancelText: "Cancel",
      danger: true
    });
    if (!proceed) {
      resetInputState();
      promptInput.focus();
      return;
    }
  }
  autoMode = !autoMode;
  updateAutoModeUI();
  updatePanelSubtitle();
  toast(autoMode ? "Auto Mode on — actions run without asking" : "Auto Mode off", {
    variant: autoMode ? "error" : "default"
  });
  await persistHistory();
  resetInputState();
  promptInput.focus();
});

// Workspace Drawer Button Toggle
workspaceButton.addEventListener("click", async () => {
  const isShown = workspaceDrawer.style.display !== "none";
  if (isShown) {
    workspaceDrawer.style.display = "none";
    workspaceButton.classList.remove("is-active");
  } else {
    workspaceDrawer.style.display = "flex";
    workspaceButton.classList.add("is-active");
    if (!workspacePath) {
      const chosen = await window.orbit.selectWorkspaceDir();
      if (chosen) {
        workspacePath = chosen;
        await initWorkspace();
        await persistHistory();
      }
    } else {
      await initWorkspace();
    }
  }
});

// Reload chat history when switching workspaces so each project gets its
// own conversation bucket on disk. We keep the user's UI settings (mode,
// width, etc.) by only replacing chatMessages.
async function reloadHistoryForWorkspace(newPath) {
  try {
    const history = await window.orbit.loadHistory(newPath);
    chatMessages = Array.isArray(history?.messages) ? history.messages : [];
    conversationSummary = typeof history?.conversationSummary === "string" ? history.conversationSummary : "";
    summarizedCount = Number.isInteger(history?.summarizedCount) && history.summarizedCount >= 0 ? history.summarizedCount : 0;
    cardExecutionStates = {};
    renderMessages();
  } catch (err) {
    console.warn("Failed to reload history for workspace:", err);
  }
}

// Change Directory Button
changeDirButton.addEventListener("click", async () => {
  const chosen = await window.orbit.selectWorkspaceDir();
  if (chosen) {
    workspacePath = chosen;
    await initWorkspace();
    await reloadHistoryForWorkspace(chosen);
    await persistHistory();
  }
});

workspacePathEl.addEventListener("click", async () => {
  const chosen = await window.orbit.selectWorkspaceDir();
  if (chosen) {
    workspacePath = chosen;
    await initWorkspace();
    await reloadHistoryForWorkspace(chosen);
    await persistHistory();
  }
});

// File Tree Search / Filter
fileSearchInput.addEventListener("input", () => {
  renderFilesList();
});

// Wide HUD Toggle Button
widthToggleButton.addEventListener("click", async () => {
  if (panelWidthMode === "standard") {
    panelWidthMode = "wide";
    widthToggleButton.classList.add("is-active");
    await window.orbit.setWidth(850);
  } else {
    panelWidthMode = "standard";
    widthToggleButton.classList.remove("is-active");
    await window.orbit.setWidth(600);
  }
});

// Export chat history as Markdown
const exportChatButton = document.querySelector("#exportChatButton");

function chatMessagesToMarkdown(msgs) {
  const lines = [];
  lines.push(`# Orbit Conversation`);
  lines.push("");
  lines.push(`*Exported ${new Date().toISOString()} — model: ${selectedModel}, mode: ${currentMode}*`);
  lines.push("");
  for (const m of msgs || []) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const heading = m.role === "user" ? "## 🧑 User" : "## 🤖 Orbit";
    const stamp = m.timestamp ? ` _(${new Date(m.timestamp).toLocaleString()})_` : "";
    lines.push(`${heading}${stamp}`);
    lines.push("");
    lines.push((m.content || "").trim());
    lines.push("");
  }
  return lines.join("\n");
}

if (exportChatButton) {
  exportChatButton.addEventListener("click", () => {
    if (!chatMessages || chatMessages.length === 0) {
      toast("Nothing to export — chat is empty", { variant: "default" });
      return;
    }
    try {
      const md = chatMessagesToMarkdown(chatMessages);
      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      a.href = url;
      a.download = `orbit-chat-${ts}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Chat exported as Markdown", { variant: "success" });
    } catch (err) {
      console.warn("[Orbit Export] failed:", err);
      toast(`Export failed: ${err.message}`, { variant: "error" });
    }
  });
}

// Clear Chat History
clearHistoryButton.addEventListener("click", async () => {
  const proceed = await customConfirm({
    title: "Clear chat history?",
    message: "Every message in this conversation will be permanently deleted.",
    confirmText: "Clear history",
    cancelText: "Keep",
    danger: true
  });
  if (proceed) {
    chatMessages = [];
    cardExecutionStates = {};
    conversationSummary = "";
    summarizedCount = 0;
    renderMessages();
    await persistHistory();
    toast("Chat history cleared");
  }
  resetInputState();
  promptInput.focus();
});

// Submit prompt form. If a stream is in flight, the Send button shows "Stop"
// instead — clicking it cancels rather than submits.
// Slash command configuration.
// `template` (optional) — when present, selecting the command prefills the
// input with this string instead of just the command name, so the user can
// edit it and hit Enter. Pure-action commands (no template) are handled in
// executeSlashCommand below.
const SLASH_COMMANDS = [
  { name: "/explain",  desc: "Ask Orbit to explain the attached selection or screen",
    template: "/explain — Walk me through what's on screen / in the attached context. Highlight anything non-obvious." },
  { name: "/fix",      desc: "Ask Orbit to fix a bug",
    template: "/fix — There's a bug here: <describe symptom>. Find the root cause and patch it." },
  { name: "/test",     desc: "Ask Orbit to write tests",
    template: "/test — Write comprehensive tests for the code on screen / in context. Cover edge cases." },
  { name: "/refactor", desc: "Ask Orbit to refactor code",
    template: "/refactor — Refactor this for readability and maintainability without changing behavior. Explain each change briefly." },
  { name: "/summarize", desc: "Ask Orbit to summarize a long doc or chat",
    template: "/summarize — Give me a tight bullet-point summary of the attached content." },
  ...TOOL_SLASH_COMMANDS.map(({ name, desc, template }) => ({ name, desc, template })),
  { name: "/goal", desc: "Start an extra thorough long-running autonomous background task" },
  { name: "/schedule", desc: "Schedule an action or set a timer schedule" },
  { name: "/grill-me", desc: "Run an interactive design review interview" },
  { name: "/type", desc: "Dictate voice transcription directly into your active text editor" },
  { name: "/ask", desc: "Switch to 'Ask' mode (chat companion)" },
  { name: "/agents", desc: "Switch to 'Agents' mode (coding automation)" },
  { name: "/planning", desc: "Switch to 'Planning' mode (architecture and design)" },
  { name: "/clear", desc: "Clear all messages in chat history" },
  { name: "/wide", desc: "Toggle standard (600px) or wide (850px) layout width" },
  { name: "/auto", desc: "Toggle Auto Mode (agents run terminal/file changes without asking)" },
  { name: "/screenshot", desc: "Toggle attaching desktop screenshot to messages" },
  { name: "/speak", desc: "Toggle reading response text aloud (Auto-Speak)" },
  { name: "/export", desc: "Export the current chat as a Markdown file" },
  { name: "/snap", desc: "Snap the overlay to whichever monitor your cursor is on" },
  { name: "/region", desc: "Capture a screen region (drag rectangle) to attach to the next message" },
  { name: "/timeline", desc: "List recent agent file writes in this workspace" },
  { name: "/revert", desc: "Revert the most recent agent file write (use /revert N for the Nth-back)" },
  { name: "/wake", desc: "Toggle 'Hey Orbit' wake-word listening (opt-in, uses your mic continuously)" },
  { name: "/summon-agents", desc: "Spawn N parallel background agents on one task. Usage: /summon-agents 3 <task>" },
  { name: "/calibrate", desc: "Open a coordinate-calibration tool to verify click/type targeting and DPI scaling" }
];

// ─── Wake word listening ────────────────────────────────────────────────
// Opt-in via /wake. Uses the browser SpeechRecognition API (the same engine
// that powers Web Speech) in continuous mode to listen for "hey orbit" or
// "orbit" as a wake phrase. On match, triggers the existing dictation flow.
// Light on CPU and doesn't hold a Whisper pipeline in memory.
let wakeRecognition = null;
let wakeListening = false;
const WAKE_PATTERNS = [/\bhey,?\s*orbit\b/i, /\bok,?\s*orbit\b/i, /^\s*orbit[\s,.!?]/i];

function startWakeWord() {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) {
    toast("Wake word not supported in this runtime", { variant: "error" });
    return false;
  }
  if (wakeRecognition) {
    try { wakeRecognition.stop(); } catch {}
  }
  wakeRecognition = new Ctor();
  wakeRecognition.continuous = true;
  wakeRecognition.interimResults = true;
  wakeRecognition.lang = "en-US";

  wakeRecognition.onresult = (event) => {
    // Stitch the latest interim transcript and check for the wake phrase.
    let text = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      text += event.results[i][0].transcript + " ";
    }
    const trimmed = text.trim();
    if (!trimmed) return;
    if (WAKE_PATTERNS.some((re) => re.test(trimmed))) {
      console.log("[Wake] phrase detected:", trimmed);
      // Pause wake listening, surface the overlay, kick off dictation. The
      // existing toggle starts a recording; user can speak their command.
      try { wakeRecognition.stop(); } catch {}
      setOverlayState("expanded");
      promptInput.focus();
      toast("👋 Orbit listening — speak now", { variant: "success" });
      toggleSpeechRecognition();
      // Resume wake listening once the dictation finishes (best-effort
      // tail-call after a few seconds so it doesn't fight the mic).
      setTimeout(() => {
        if (wakeListening) {
          try { wakeRecognition.start(); } catch {}
        }
      }, 6000);
    }
  };

  wakeRecognition.onerror = (e) => {
    console.warn("[Wake] error:", e?.error);
    // Auto-restart on transient errors so the loop survives.
    if (wakeListening && e?.error !== "not-allowed") {
      setTimeout(() => { try { wakeRecognition.start(); } catch {} }, 1500);
    }
  };

  wakeRecognition.onend = () => {
    if (wakeListening) {
      try { wakeRecognition.start(); } catch {}
    }
  };

  try {
    wakeRecognition.start();
    wakeListening = true;
    return true;
  } catch (err) {
    console.warn("[Wake] start failed:", err);
    return false;
  }
}

function stopWakeWord() {
  wakeListening = false;
  if (wakeRecognition) {
    try { wakeRecognition.stop(); } catch {}
    wakeRecognition = null;
  }
}

// ─── Plugin system ──────────────────────────────────────────────────────
// Plugins are JS modules dropped into {userData}/plugins/*.js. Each plugin
// can register additional slash commands. At startup we ask main for the
// list, dynamic-import each module, and merge its slash commands into the
// SLASH_COMMANDS array.
const pluginCommands = new Map(); // "/cmdName" -> { run, plugin }

function makePluginApi(pluginName) {
  return {
    pluginName,
    toast: (msg, opts) => toast(msg, opts || { variant: "success" }),
    sendPrompt: (text) => {
      promptInput.value = text;
      bar.dispatchEvent(new Event("submit", { cancelable: true }));
    },
    appendAssistantMessage: (content) => {
      chatMessages = [...chatMessages, {
        id: createId(),
        role: "assistant",
        content,
        timestamp: new Date().toISOString(),
        model: selectedModel,
        pluginSource: pluginName
      }];
      renderMessages();
      setOverlayState("expanded");
    },
    getWorkspacePath: () => workspacePath,
    getChatMessages: () => chatMessages.slice(),
    runWorkspaceCommand: (command) =>
      window.orbit.runWorkspaceCommand({ workspacePath, command }),
    readWorkspaceFile: (relativePath) =>
      window.orbit.readWorkspaceFile({ workspacePath, relativePath }),
    openBrowser: (url) => window.orbit.openBrowser({ url })
  };
}

async function loadPlugins() {
  if (!window.orbit.listPlugins) return;
  try {
    const res = await window.orbit.listPlugins();
    if (!res?.ok || !res.plugins?.length) return;
    for (const entry of res.plugins) {
      try {
        const mod = await import(entry.url);
        const plugin = mod.default || mod.plugin || mod;
        if (!plugin || typeof plugin !== "object") continue;
        const pluginName = plugin.name || entry.name;
        const cmds = Array.isArray(plugin.slashCommands) ? plugin.slashCommands : [];
        for (const cmd of cmds) {
          if (!cmd?.name?.startsWith("/") || typeof cmd.run !== "function") continue;
          // Don't let plugins clobber built-ins.
          if (SLASH_COMMANDS.some((c) => c.name === cmd.name)) {
            console.warn(`[Plugin] ${pluginName}: skipping ${cmd.name} (built-in)`);
            continue;
          }
          SLASH_COMMANDS.push({ name: cmd.name, desc: cmd.desc || `[${pluginName}]` });
          pluginCommands.set(cmd.name, { run: cmd.run, plugin });
        }
        console.log(`[Plugin] loaded ${pluginName} with ${cmds.length} commands`);
      } catch (err) {
        console.warn(`[Plugin] failed to load ${entry.name}:`, err);
      }
    }
  } catch (err) {
    console.warn("[Plugin] discovery failed:", err);
  }
}

let selectedSlashIndex = 0;
let filteredSlashCommands = [];
const slashMenuEl = document.querySelector("#slashMenu");

// ─── Prompt history (terminal-style ↑/↓ recall) ─────────────────────────
// Ring buffer of recently submitted prompts. Persists across sessions via
// localStorage so the recall list survives an app relaunch. We deliberately
// avoid storing this in chat-history.json so users can clear chat without
// losing their recall history.
const PROMPT_HISTORY_KEY = "orbit.promptHistory";
const PROMPT_HISTORY_MAX = 50;
let promptHistory = [];
let promptHistoryIndex = -1;    // -1 = "not navigating"; otherwise index from the END (0 = most recent)
let promptHistoryDraft = "";    // what the user had typed before they started cycling

function loadPromptHistory() {
  try {
    const raw = localStorage.getItem(PROMPT_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      promptHistory = parsed.filter((s) => typeof s === "string");
    }
  } catch {
    promptHistory = [];
  }
}

function savePromptHistory() {
  try {
    localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(promptHistory));
  } catch { /* quota — ignore */ }
}

function pushPromptHistory(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return;
  // De-duplicate consecutive identical submissions so spamming Enter
  // doesn't bury the rest of the history.
  if (promptHistory.length > 0 && promptHistory[promptHistory.length - 1] === trimmed) return;
  promptHistory.push(trimmed);
  if (promptHistory.length > PROMPT_HISTORY_MAX) {
    promptHistory = promptHistory.slice(-PROMPT_HISTORY_MAX);
  }
  promptHistoryIndex = -1;
  promptHistoryDraft = "";
  savePromptHistory();
}

function navigatePromptHistory(direction) {
  if (promptHistory.length === 0) return false;
  if (promptHistoryIndex === -1) {
    // Capture whatever the user was typing so ↓ back to the bottom restores it.
    promptHistoryDraft = promptInput.value;
  }

  if (direction === "up") {
    if (promptHistoryIndex < promptHistory.length - 1) {
      promptHistoryIndex += 1;
    }
  } else {
    promptHistoryIndex -= 1;
  }

  if (promptHistoryIndex < 0) {
    promptHistoryIndex = -1;
    promptInput.value = promptHistoryDraft;
  } else {
    const idx = promptHistory.length - 1 - promptHistoryIndex;
    promptInput.value = promptHistory[idx] || "";
  }
  // Move caret to end so the user can keep editing without re-positioning.
  const len = promptInput.value.length;
  promptInput.setSelectionRange(len, len);
  return true;
}

loadPromptHistory();

// ─── @filename autocomplete ─────────────────────────────────────────────
// Watches the input for "@<partial>" tokens and shows a fuzzy file picker
// drawn from the current workspace tree. Selecting a file replaces the @-token
// with its path AND attaches it to selectedFiles so the AI gets its content.
let filteredAtFiles = [];
let selectedAtIndex = 0;
let atTokenStart = -1; // caret-index of the "@" sigil for the active query

function getAtQuery() {
  const val = promptInput.value;
  const caret = promptInput.selectionStart ?? val.length;
  // Walk back from caret to find an unbroken @<chars> token. Break on
  // whitespace so "foo @bar baz" doesn't match against the wrong region.
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(val[i]) && val[i] !== "@") i -= 1;
  if (i < 0 || val[i] !== "@") return null;
  return { start: i, query: val.slice(i + 1, caret) };
}

function updateAtMenu() {
  if (!slashMenuEl) return false;
  const at = getAtQuery();
  if (!at) return false;

  const q = at.query.toLowerCase();
  filteredAtFiles = (workspaceFiles || [])
    .filter((f) => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
    .slice(0, 8);

  if (filteredAtFiles.length === 0) return false;
  if (selectedAtIndex >= filteredAtFiles.length) selectedAtIndex = 0;
  atTokenStart = at.start;

  slashMenuEl.replaceChildren(
    ...filteredAtFiles.map((f, index) => {
      const item = document.createElement("div");
      item.className = `slash-item${index === selectedAtIndex ? " is-active" : ""}`;
      item.dataset.atIndex = String(index);

      const name = document.createElement("span");
      name.className = "slash-name";
      name.textContent = `@${f.name}`;

      const desc = document.createElement("span");
      desc.className = "slash-desc";
      desc.textContent = f.path;

      item.append(name, desc);
      return item;
    })
  );
  slashMenuEl.style.display = "block";
  slashMenuEl.querySelectorAll(".slash-item[data-at-index]").forEach((item) => {
    item.addEventListener("click", () => {
      const idx = parseInt(item.dataset.atIndex, 10);
      selectAtFile(filteredAtFiles[idx]);
    });
  });

  const selectedEl = slashMenuEl.querySelector(".slash-item.is-active");
  if (selectedEl) {
    selectedEl.scrollIntoView({ block: "nearest" });
  }
  return true;
}

function updateAtSelection() {
  const items = slashMenuEl.querySelectorAll(".slash-item");
  items.forEach((el, i) => {
    if (i === selectedAtIndex) {
      el.classList.add("is-active");
      el.scrollIntoView({ block: "nearest" });
    } else {
      el.classList.remove("is-active");
    }
  });
}

function selectAtFile(file) {
  if (!file) return;
  const val = promptInput.value;
  const caret = promptInput.selectionStart ?? val.length;
  const before = val.slice(0, atTokenStart);
  const after = val.slice(caret);
  const insertion = `@${file.path}`;
  promptInput.value = `${before}${insertion} ${after}`;
  const newCaret = (before + insertion + " ").length;
  promptInput.setSelectionRange(newCaret, newCaret);

  // Also attach the file as workspace context for the AI call.
  selectedFiles.add(file.path);
  if (typeof renderFilesList === "function") renderFilesList();
  if (typeof renderContextTray === "function") renderContextTray();

  hideSlashMenu();
  promptInput.focus();
}

function updateSlashMenu() {
  if (!slashMenuEl) return;
  // @-autocomplete takes priority when the active token starts with @.
  if (updateAtMenu()) return;
  filteredAtFiles = [];
  const val = promptInput.value;

  if (val.startsWith("/") && !val.includes(" ")) {
    const query = val.toLowerCase();
    filteredSlashCommands = SLASH_COMMANDS.filter(cmd => cmd.name.startsWith(query));
    
    if (filteredSlashCommands.length > 0) {
      if (selectedSlashIndex >= filteredSlashCommands.length) {
        selectedSlashIndex = 0;
      }
      
      slashMenuEl.innerHTML = filteredSlashCommands.map((cmd, index) => `
        <div class="slash-item ${index === selectedSlashIndex ? 'is-active' : ''}" data-index="${index}">
          <span class="slash-name">${cmd.name}</span>
          <span class="slash-desc">${cmd.desc}</span>
        </div>
      `).join("");
      
      slashMenuEl.style.display = "block";

      const selectedEl = slashMenuEl.querySelector(".slash-item.is-active");
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: "nearest" });
      }
      
      // Wire up clicks
      slashMenuEl.querySelectorAll(".slash-item").forEach(item => {
        item.addEventListener("click", () => {
          const idx = parseInt(item.dataset.index, 10);
          selectSlashCommand(filteredSlashCommands[idx].name);
        });
      });
      return;
    }
  }
  
  hideSlashMenu();
}

function updateSlashSelection() {
  const items = slashMenuEl.querySelectorAll(".slash-item");
  items.forEach((el, i) => {
    if (i === selectedSlashIndex) {
      el.classList.add("is-active");
      el.scrollIntoView({ block: "nearest" });
    } else {
      el.classList.remove("is-active");
    }
  });
}

function hideSlashMenu() {
  if (slashMenuEl) {
    slashMenuEl.style.display = "none";
  }
  filteredSlashCommands = [];
  selectedSlashIndex = 0;
  filteredAtFiles = [];
  selectedAtIndex = 0;
  atTokenStart = -1;
}

function selectSlashCommand(name) {
  const cmd = SLASH_COMMANDS.find((c) => c.name === name);
  if (cmd && cmd.template) {
    promptInput.value = cmd.template;
    // Place caret at the end so the user can start editing/typing immediately.
    const len = promptInput.value.length;
    setTimeout(() => promptInput.setSelectionRange(len, len), 0);
  } else {
    promptInput.value = name + " ";
  }
  hideSlashMenu();
  promptInput.focus();
}

async function executeSlashCommand(cmd) {
  const c = cmd.toLowerCase().trim();
  // Plugin dispatch comes first so user-defined commands can override
  // nothing important (we already skipped collisions in loadPlugins).
  const cmdHead = c.split(/\s+/)[0];
  if (pluginCommands.has(cmdHead)) {
    const entry = pluginCommands.get(cmdHead);
    const args = cmd.slice(cmdHead.length).trim();
    try {
      await entry.run(makePluginApi(entry.plugin.name || cmdHead), args);
    } catch (err) {
      toast(`Plugin ${cmdHead} failed: ${err.message}`, { variant: "error" });
    }
    return true;
  }

  if (c === "/clear") {
    const proceed = await customConfirm({
      title: "Clear chat history?",
      message: "Every message in this conversation will be permanently deleted.",
      confirmText: "Clear history",
      cancelText: "Keep",
      danger: true
    });
    if (proceed) {
      chatMessages = [];
      cardExecutionStates = {};
      conversationSummary = "";
      summarizedCount = 0;
      renderMessages();
      await persistHistory();
      toast("Chat history cleared", { variant: "success" });
    }
  } else if (c === "/wide") {
    panelWidthMode = panelWidthMode === "standard" ? "wide" : "standard";
    if (panelWidthMode === "wide") {
      widthToggleButton.classList.add("is-active");
      await window.orbit.setWidth(850);
    } else {
      widthToggleButton.classList.remove("is-active");
      await window.orbit.setWidth(600);
    }
    await persistHistory();
    toast(`Layout width: ${panelWidthMode}`, { variant: "success" });
  } else if (c === "/auto") {
    if (!autoMode) {
      const proceed = await customConfirm({
        title: "Enable Auto Mode?",
        message:
          "Orbit will execute every action (write files, run commands, read files) " +
          "WITHOUT asking for confirmation. Use only in workspaces you trust.",
        confirmText: "Enable Auto Mode",
        cancelText: "Cancel",
        danger: true
      });
      if (!proceed) return true;
    }
    autoMode = !autoMode;
    updateAutoModeUI();
    updatePanelSubtitle();
    toast(autoMode ? "Auto Mode on — actions run without asking" : "Auto Mode off", {
      variant: autoMode ? "error" : "default"
    });
    await persistHistory();
  } else if (c === "/speak") {
    autoSpeakEnabled = !autoSpeakEnabled;
    updateSpeakToggleUI();
    await persistHistory();
    toast(autoSpeakEnabled ? "Auto-speak activated" : "Auto-speak deactivated", { variant: "success" });
    if (autoSpeakEnabled) {
      speakText("Auto-speak activated");
    } else {
      window.speechSynthesis.cancel();
    }
  } else if (c === "/screenshot") {
    attachScreenshot = !attachScreenshot;
    forceScreenshotNextSend = attachScreenshot;
    updateScreenshotToggleUI();
    updatePanelSubtitle();
    await persistHistory();
    toast(attachScreenshot ? "Screen context on — next message includes your screen" : "Screen context off", { variant: "success" });
  } else if (c === "/ask" || c === "/agents" || c === "/planning") {
    currentMode = c.slice(1);
    agentMode = (currentMode === "agents");
    updateModeUI();
    updatePanelSubtitle();
    await persistHistory();
    toast(`Switched mode to ${currentMode}`, { variant: "success" });
  } else if (c.startsWith("/type")) {
    toast("Voice Typing Mode: Click mic, focus editor/window, and speak!", { variant: "success", duration: 4000 });
    return true;
  } else if (c === "/export") {
    if (exportChatButton) exportChatButton.click();
    return true;
  } else if (c === "/snap") {
    try {
      if (window.orbit.snapToCursor) await window.orbit.snapToCursor();
      toast("Snapped overlay to cursor's monitor", { variant: "success" });
    } catch (err) {
      toast(`Snap failed: ${err.message}`, { variant: "error" });
    }
    return true;
  } else if (c === "/timeline") {
    try {
      const res = await window.orbit.listAgentTimeline(workspacePath);
      if (!res?.ok) {
        toast(`Timeline error: ${res?.error || "unknown"}`, { variant: "error" });
        return true;
      }
      const tl = res.timeline || [];
      if (tl.length === 0) {
        toast("No agent writes recorded in this workspace yet", { variant: "default" });
        return true;
      }
      const lines = tl.slice(-12).reverse().map((e, i) => {
        const tag = e.reverted ? " [reverted]" : "";
        return `${i + 1}. ${e.ts.slice(11, 19)}  ${e.op}  ${e.path}${tag}`;
      });
      chatMessages = [...chatMessages, {
        id: createId(),
        role: "assistant",
        content: "**Agent timeline (most recent first):**\n\n```\n" + lines.join("\n") + "\n```\n\nUse `/revert N` to revert the Nth entry.",
        timestamp: new Date().toISOString(),
        model: selectedModel
      }];
      renderMessages();
      setOverlayState("expanded");
    } catch (err) {
      toast(`Timeline failed: ${err.message}`, { variant: "error" });
    }
    return true;
  } else if (c.startsWith("/revert")) {
    const parts = c.split(/\s+/);
    const n = Math.max(1, parseInt(parts[1] || "1", 10)) || 1;
    try {
      const res = await window.orbit.listAgentTimeline(workspacePath);
      const tl = res?.timeline || [];
      // Pick the Nth-most-recent non-reverted write_file entry.
      const candidates = [];
      for (let i = tl.length - 1; i >= 0; i--) {
        if (tl[i].op === "write_file" && !tl[i].reverted) candidates.push(i);
      }
      if (candidates.length < n) {
        toast(`No revertable entry at position ${n}`, { variant: "error" });
        return true;
      }
      const idx = candidates[n - 1];
      const revRes = await window.orbit.revertAgentWrite(workspacePath, idx);
      if (revRes?.ok) {
        toast(`Reverted: ${tl[idx].path}`, { variant: "success" });
      } else {
        toast(`Revert failed: ${revRes?.error || "unknown"}`, { variant: "error" });
      }
    } catch (err) {
      toast(`Revert failed: ${err.message}`, { variant: "error" });
    }
    return true;
  } else if (c === "/wake") {
    if (wakeListening) {
      stopWakeWord();
      toast("Wake word listening: off", { variant: "default" });
    } else {
      const ok = startWakeWord();
      if (ok) toast("Wake word listening: on — say 'Hey Orbit'", { variant: "success" });
    }
    return true;
  } else if (c === "/region") {
    try {
      const path = window.orbit.captureRegion ? await window.orbit.captureRegion() : null;
      if (!path) {
        toast("Region capture cancelled", { variant: "default" });
        return true;
      }
      // Reuse the pasted-image pipeline: prime a data URL so the chip shows
      // up immediately and the next send uses this image instead of the
      // auto-screenshot.
      const fileUrl = `file://${path.replace(/\\/g, "/")}`;
      pastedImageDataUrl = fileUrl;       // sendMessage savePastedImage handles either path
      pastedImageThumb = fileUrl;
      // Convert to data URL so save-pasted-image can re-serialize it. The
      // file:// protocol works here because the renderer can fetch local
      // files via XHR/fetch in Electron's renderer.
      try {
        const res = await fetch(fileUrl);
        const blob = await res.blob();
        await new Promise((resolveFR) => {
          const fr = new FileReader();
          fr.onload = () => {
            pastedImageDataUrl = String(fr.result);
            pastedImageThumb = pastedImageDataUrl;
            resolveFR();
          };
          fr.readAsDataURL(blob);
        });
      } catch (err) {
        console.warn("Region: data-URL conversion failed", err);
      }
      renderContextTray();
      toast("Region attached to next message", { variant: "success" });
    } catch (err) {
      toast(`Region capture failed: ${err.message}`, { variant: "error" });
    }
    return true;
  } else if (c.startsWith("/summon-agents")) {
    const rest = cmd.slice("/summon-agents".length).trim();
    const m = rest.match(/^(\d+)\s+(.+)$/s);
    if (!m) {
      toast("Usage: /summon-agents <N> <task>  (e.g. /summon-agents 3 build tic-tac-toe)", { variant: "error", duration: 6000 });
      return true;
    }
    const count = Math.max(1, Math.min(8, parseInt(m[1], 10)));
    const task = m[2].trim();
    if (!workspacePath) {
      toast("Open a workspace first (folder icon) — agents need somewhere to write.", { variant: "error" });
      return true;
    }
    toast(`Summoning ${count} parallel agent${count === 1 ? "" : "s"} on: ${task.slice(0, 60)}${task.length > 60 ? "…" : ""}`, { variant: "success", duration: 5000 });
    const launches = Array.from({ length: count }, () =>
      window.orbit.deployAgent({ workspacePath, task, model: selectedModel })
        .catch((err) => ({ ok: false, error: err?.message || String(err) }))
    );
    Promise.all(launches).then((results) => {
      const ok = results.filter((r) => r && r.ok).length;
      const failed = results.length - ok;
      toast(`Summoned ${ok}/${results.length} agent${results.length === 1 ? "" : "s"}${failed > 0 ? ` (${failed} failed)` : ""}. Check .orbit/ logs.`, {
        variant: failed > 0 ? "error" : "success",
        duration: 6000
      });
    });
    return true;
  } else if (c === "/calibrate" || c.startsWith("/calibrate ")) {
    openCalibrationModal();
    return true;
  } else {
    // Other slash commands (/goal, /schedule, /grill-me) should proceed as LLM messages
    return false;
  }
  return true;
}

// Coordinate calibration helper. Opens a small modal showing screen size and
// devicePixelRatio, with controls to probe a (x, y) click and verify the
// AI's pixel-coordinate model matches the user's actual desktop. Useful when
// click_pixel or type_text seem to land in the wrong spot (multi-monitor,
// DPI scaling, taskbar offsets).
function openCalibrationModal() {
  const existing = document.getElementById("orbitCalibrationModal");
  if (existing) existing.remove();

  const backdrop = document.createElement("div");
  backdrop.id = "orbitCalibrationModal";
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal modal-calibration";
  const dpr = window.devicePixelRatio || 1;
  const scrW = window.screen.width;
  const scrH = window.screen.height;
  const realW = Math.round(scrW * dpr);
  const realH = Math.round(scrH * dpr);

  modal.innerHTML = `
    <div class="modal-header">
      <h3>Coordinate Calibration</h3>
      <button type="button" class="modal-close" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <p style="margin:0 0 8px;font-size:12px;opacity:.75;">Use this to verify the AI's click/type targeting matches your real desktop. Multi-monitor setups and DPI scaling are common sources of drift.</p>
      <div class="calibration-grid">
        <div><strong>CSS resolution:</strong> ${scrW} × ${scrH}</div>
        <div><strong>Device pixel ratio:</strong> ${dpr}</div>
        <div><strong>Physical resolution:</strong> ${realW} × ${realH}</div>
      </div>
      <div class="calibration-row">
        <label>X <input id="calX" type="number" value="${Math.round(scrW / 2)}" min="0" max="${realW}"></label>
        <label>Y <input id="calY" type="number" value="${Math.round(scrH / 2)}" min="0" max="${realH}"></label>
        <button type="button" id="calProbeClick" class="modal-btn">Probe click (3s)</button>
        <button type="button" id="calProbeType" class="modal-btn">Probe type (3s)</button>
      </div>
      <p id="calStatus" class="calibration-status" style="font-size:11px;opacity:.7;min-height:14px;">Tip: Click "Probe" then quickly focus the target window to see where the click/type actually lands.</p>
    </div>
  `;

  backdrop.append(modal);
  document.body.append(backdrop);

  const close = () => backdrop.remove();
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  modal.querySelector(".modal-close").addEventListener("click", close);

  const status = modal.querySelector("#calStatus");
  const setStatus = (msg) => { status.textContent = msg; };

  const probe = async (kind) => {
    const x = parseInt(modal.querySelector("#calX").value, 10);
    const y = parseInt(modal.querySelector("#calY").value, 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { setStatus("Enter valid X / Y."); return; }
    for (let i = 3; i > 0; i--) {
      setStatus(`Probing ${kind} at (${x}, ${y}) in ${i}…`);
      await new Promise((r) => setTimeout(r, 800));
    }
    try {
      if (kind === "click") {
        const res = await window.orbit.clickPixel({ x, y });
        setStatus(res?.ok ? `✓ Clicked at (${x}, ${y}).` : `Click failed: ${res?.error || "unknown"}`);
      } else {
        const res = await window.orbit.typeIntoWindow({ text: `[Orbit calibration ${x},${y}]` });
        setStatus(res?.ok ? `✓ Typed marker into the focused window.` : `Type failed: ${res?.error || "unknown"}`);
      }
    } catch (err) {
      setStatus(`Probe error: ${err?.message || err}`);
    }
  };
  modal.querySelector("#calProbeClick").addEventListener("click", () => probe("click"));
  modal.querySelector("#calProbeType").addEventListener("click", () => probe("type"));
}

// Track input changes for autocomplete
promptInput.addEventListener("input", () => {
  updateSlashMenu();
});

// Handle keydowns on the prompt input for navigation
promptInput.addEventListener("keydown", (event) => {
  // @-file menu navigation
  if (slashMenuEl && slashMenuEl.style.display === "block" && filteredAtFiles.length > 0) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedAtIndex = (selectedAtIndex + 1) % filteredAtFiles.length;
      updateAtSelection();
      return;
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedAtIndex = (selectedAtIndex - 1 + filteredAtFiles.length) % filteredAtFiles.length;
      updateAtSelection();
      return;
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      selectAtFile(filteredAtFiles[selectedAtIndex]);
      return;
    } else if (event.key === "Escape") {
      event.preventDefault();
      hideSlashMenu();
      return;
    }
  }

  if (slashMenuEl && slashMenuEl.style.display === "block" && filteredSlashCommands.length > 0) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedSlashIndex = (selectedSlashIndex + 1) % filteredSlashCommands.length;
      updateSlashSelection();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedSlashIndex = (selectedSlashIndex - 1 + filteredSlashCommands.length) % filteredSlashCommands.length;
      updateSlashSelection();
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      selectSlashCommand(filteredSlashCommands[selectedSlashIndex].name);
    } else if (event.key === "Escape") {
      event.preventDefault();
      hideSlashMenu();
    }
    return;
  }

  // Terminal-style prompt recall. Only triggers on bare ↑/↓ (no modifiers),
  // and only when the input is single-line — current input doesn't support
  // multi-line, so cursor-position checks aren't needed.
  if ((event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (navigatePromptHistory(event.key === "ArrowUp" ? "up" : "down")) {
      event.preventDefault();
    }
  }
});

// Any non-arrow input invalidates the "currently navigating history" state
// so the next ↑ starts cycling from the top again.
promptInput.addEventListener("input", () => {
  promptHistoryIndex = -1;
});

// Ctrl+V image paste — stash the image as context for the next send.
promptInput.addEventListener("paste", (event) => {
  const items = event.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (!file) continue;
      event.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        if (!dataUrl.startsWith("data:image/")) return;
        pastedImageDataUrl = dataUrl;
        pastedImageThumb = dataUrl;
        renderContextTray();
        toast("Image attached to next message", { variant: "success" });
      };
      reader.readAsDataURL(file);
      return;
    }
  }
});

// Submit prompt form. If a stream is in flight, the Send button shows "Stop"
// instead — clicking it cancels rather than submits.
bar.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (sendButton.dataset.mode === "stop") {
    await abortCurrentStream();
    return;
  }
  
  const val = promptInput.value.trim();
  if (val.startsWith("/")) {
    const isLocalAction = await executeSlashCommand(val);
    if (isLocalAction) {
      pushPromptHistory(val);
      promptInput.value = "";
      hideSlashMenu();
      return;
    }
  }

  pushPromptHistory(promptInput.value);
  await sendMessage(promptInput.value);
});

// Keyboard controls.
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    // Esc during streaming = stop. Esc otherwise = collapse the overlay.
    if (currentStreamId) {
      abortCurrentStream();
      return;
    }
    setOverlayState("collapsed");
    return;
  }
  // Ctrl/Cmd+L → focus the prompt from anywhere.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
    event.preventDefault();
    setOverlayState("expanded");
    promptInput.focus();
    promptInput.select();
  }
});

// Toggle Auto-Speak
speakToggleButton.addEventListener("click", async () => {
  autoSpeakEnabled = !autoSpeakEnabled;
  updateSpeakToggleUI();
  await persistHistory();
  if (autoSpeakEnabled) {
    speakText("Auto-speak activated");
  } else {
    window.speechSynthesis.cancel();
  }
});

// Toggle Speech Recognition dictation
micButton.addEventListener("click", () => {
  toggleSpeechRecognition();
});



// Load configuration and launch
loadHistory();

// Load user plugins from {userData}/plugins/*.js (best-effort, non-blocking).
loadPlugins();

// Warm up Whisper in the background so the first voice press is instant.
// Downloads the model on first run (~150 MB for whisper-base.en or whisper-base), cached
// afterwards in IndexedDB.
warmupWhisper((p) => {
  if (p.status === "progress" && p.file && p.progress != null) {
    console.log(`[Whisper warmup] downloading ${p.file}: ${Math.round(p.progress)}%`);
  } else if (p.status === "ready") {
    console.log(`[Whisper warmup] model loaded and ready.`);
  }
});

// Window Dragging Support
let isDragging = false;
let startX = 0;
let startY = 0;
const grabLine = document.querySelector(".grab-line");

if (grabLine) {
  grabLine.addEventListener("mousedown", (e) => {
    isDragging = true;
    startX = e.screenX;
    startY = e.screenY;
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const deltaX = e.screenX - startX;
    const deltaY = e.screenY - startY;
    startX = e.screenX;
    startY = e.screenY;
    window.orbit.dragWindow({ deltaX, deltaY });
  });

  window.addEventListener("mouseup", () => {
    isDragging = false;
  });
}
