import { parseAIResponse, renderMarkdown, computeLineDiff } from "../shared/parser.js";
import { transcribeWithWhisper, warmupWhisper } from "./whisper.js";

const MODELS = [
  "Auto",
  "Voyager 1",
  "Voyager 1 Flash",
  "Voyager 2 Preview",
  "Voyager 2 Pro",
  "Orchestra 1.1"
];
const DEFAULT_MODEL = "Voyager 1 Flash";

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
const whisperLangBtn = document.querySelector("#whisperLangBtn");

// State Variables
let selectedModel = DEFAULT_MODEL;
let chatMessages = [];
let currentMode = "ask"; // "ask", "agents", "planning"
let agentMode = false;
let autoMode = false;
let attachScreenshot = true;  // default on — screen context is the whole point of Orbit
// Inline pasted image (Ctrl+V into the prompt). When non-null, it overrides
// the auto-screenshot on the next send and is then cleared.
let pastedImageDataUrl = null;
let pastedImageThumb = null;

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
  "Voyager 1": "gemini-2.5-flash",
  "Voyager 1 Flash": "gemini-2.5-flash-lite",
  "Voyager 2 Preview": "gemini-3.1-flash-lite",
  "Voyager 2 Pro": "gemini-3.5-flash",
  "Orchestra 1.1": "gemini-2.5-flash-lite"
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

  aiStreamTargetEl.textContent = aiStreamTargetText.slice(0, aiStreamDisplayedLen);
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
    aiStreamTargetEl.textContent = aiStreamTargetText;
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

          // We draw 3 beautiful, overlapping monochrome wave layers with organic flow
          // Layer 1: Soft backdrop (deep silver)
          drawSiriLikeWave(ctx, w, h, volume, time, 0.95, 0.40, "rgba(255, 255, 255, 0.12)", 1.0);
          
          // Layer 2: Middle layer (bright silver)
          drawSiriLikeWave(ctx, w, h, volume, time * -1.15, 1.45, 0.65, "rgba(255, 255, 255, 0.40)", 1.0);

          // Layer 3: Sharp foreground (crisp white)
          drawSiriLikeWave(ctx, w, h, volume, time * 1.45, 2.1, 0.95, "rgba(255, 255, 255, 0.85)", 1.5);
        }

        function drawSiriLikeWave(ctx, w, h, volume, timeShift, freqScale, ampScale, strokeStyle, lineWidth) {
          ctx.beginPath();
          ctx.lineWidth = lineWidth;
          ctx.strokeStyle = strokeStyle;

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
    autoSpeakEnabled
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
    part.type === "click_pixel" ? "click" :
    part.type === "open_browser" ? "browser" :
    part.type === "deploy_agent" ? "agent" : "read";
  const typeLabel =
    part.type === "execute_command" ? "Command" :
    part.type === "write_file" ? "Write File" :
    part.type === "type_text" ? `Type into "${part.window || "?"}"` :
    part.type === "list_workspace" ? "List Workspace" :
    part.type === "click_pixel" ? "Click Pixel" :
    part.type === "open_browser" ? "Open Browser" :
    part.type === "deploy_agent" ? "Deploy Agent" : "Read File";

  const typeSpan = document.createElement("span");
  typeSpan.className = `action-card-type ${typeClass}`;
  typeSpan.textContent = typeLabel;

  const pathSpan = document.createElement("span");
  pathSpan.className = "action-card-path";
  pathSpan.textContent = 
    part.type === "click_pixel" ? `x=${part.x}, y=${part.y}` :
    part.type === "open_browser" ? part.url :
    part.type === "deploy_agent" ? "Autonomous Background Agent" : (part.path || "");

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
  } else if (part.type === "open_browser") {
    const desc = document.createElement("div");
    desc.className = "action-card-description";
    desc.textContent = `Opening URL:\n"${part.url}"`;
    body.append(desc);
  } else if (part.content && part.type !== "read_file" && part.type !== "click_pixel") {
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
        part.type === "click_pixel" ? "Click" :
        part.type === "open_browser" ? "Open" :
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
      command: part.content.trim()
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
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success", fileContent: res.content };
      toolResult =
        `[TOOL_RESULT] read_file: ${part.path}\n` +
        `--- FILE CONTENT START ---\n${res.content}\n--- FILE CONTENT END ---`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "Read failed" };
      toolResult = `[TOOL_RESULT] read_file FAILED: ${part.path} — ${res?.error || "Read failed"}`;
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
      y: part.y
    });

    if (res && res.ok) {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "success" };
      toolResult = `[TOOL_RESULT] click_pixel at x=${part.x}, y=${part.y} — clicked successfully.`;
    } else {
      cardExecutionStates[cardKey] = { ...cardExecutionStates[cardKey], status: "error", error: res?.error || "Click failed" };
      toolResult = `[TOOL_RESULT] click_pixel at x=${part.x}, y=${part.y} FAILED: ${res?.error || "Click failed"}`;
    }
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

  if (agentMode && messageId) {
    const msg = chatMessages.find(m => m.id === messageId);
    if (msg) {
      const msgParts = parseAIResponse(msg.content);
      const toolParts = msgParts.filter(p => p.type !== "text");
      const allDone = toolParts.every((p, idx) => {
        const key = `${messageId}-${p.type}-${p.path || "command"}-${idx}`;
        const state = cardExecutionStates[key];
        return state && (state.status === "success" || state.status === "error");
      });

      if (allDone) {
        const hasDeployAgent = toolParts.some(p => p.type === "deploy_agent");
        const results = toolParts.map((p, idx) => {
          const key = `${messageId}-${p.type}-${p.path || "command"}-${idx}`;
          return cardExecutionStates[key]?.toolResult;
        }).filter(Boolean);

        if (results.length > 0 && !hasDeployAgent) {
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

  const apiMessages = chatMessages
    .filter((m) => !m.pending && !m.streaming && (m.role === "user" || m.role === "assistant") && m.content?.trim())
    .map((m) => ({ role: m.role, content: m.content }));

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
      mode: currentMode
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

function renderAssistantMessage(message, container) {
  const parts = parseAIResponse(message.content);

  let partIndex = 0;
  for (const part of parts) {
    if (part.type === "text") {
      const p = document.createElement("p");
      p.className = "message-content";
      p.innerHTML = renderMarkdown(part.content);
      container.append(p);
    } else {
      const card = renderActionCard(part, message.id, partIndex);
      container.append(card);
      partIndex++;
    }
  }

  // Auto Mode: kick off any still-pending action cards immediately, without
  // waiting for a click. Runs at most one action per render to avoid races —
  // the next card will fire after the tool result comes back and re-renders.
  if (autoMode && agentMode) {
    let loopPartIndex = 0;
    for (const part of parts) {
      if (part.type === "text") continue;
      if (part.type === "deploy_agent" && !isSummonAgentsAuthorized()) {
        loopPartIndex++;
        continue;
      }
      const cardKey = `${message.id}-${part.type}-${part.path || "command"}-${loopPartIndex}`;
      const state = cardExecutionStates[cardKey];
      if (!state || state.status === "pending") {
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
  const trimmed = content.trim();
  if (!trimmed) {
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
  } else if (attachScreenshot) {
    try {
      screenshotPath = await window.orbit.captureScreen();
    } catch {
      screenshotPath = null;
    }
  }

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

  // Retrieve clean API conversation thread
  const apiMessages = chatMessages
    .filter((m) => !m.pending && !m.streaming && (m.role === "user" || m.role === "assistant") && m.content?.trim())
    .map((m) => ({ role: m.role, content: m.content }));

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
  } finally {
    // ALWAYS re-enable, even if something above threw.
    resetInputState();
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
    screenshotToggleButton.title = "Screen context ON — screenshot attached to each message";
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

if (modelSelectBtn && modelSelectOptions) {
  modelSelectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeModeDropdown();
    const willOpen = !modelSelectOptions.classList.contains("open");
    if (willOpen) {
      modelSelectOptions.classList.add("open");
      if (overlay.dataset.state !== "expanded") {
        setOverlayState("dropdown-open");
      }
    } else {
      closeModelDropdown();
    }
  });

  modelSelectOptions.addEventListener("click", async (e) => {
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
  updateScreenshotToggleUI();
  updatePanelSubtitle();
  toast(attachScreenshot ? "Screen context on" : "Screen context off");
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
  { name: "/wake", desc: "Toggle 'Hey Orbit' wake-word listening (opt-in, uses your mic continuously)" }
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
  return true;
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
    updateScreenshotToggleUI();
    updatePanelSubtitle();
    await persistHistory();
    toast(attachScreenshot ? "Screenshot attached to messages" : "Screenshot detached", { variant: "success" });
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
  } else {
    // Other slash commands (/goal, /schedule, /grill-me) should proceed as LLM messages
    return false;
  }
  return true;
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
      updateAtMenu();
      return;
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedAtIndex = (selectedAtIndex - 1 + filteredAtFiles.length) % filteredAtFiles.length;
      updateAtMenu();
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
      updateSlashMenu();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedSlashIndex = (selectedSlashIndex - 1 + filteredSlashCommands.length) % filteredSlashCommands.length;
      updateSlashMenu();
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
