// Local Whisper transcription in the renderer using @huggingface/transformers.
// Runs fully offline after the model is downloaded once.

import { pipeline, env } from "@huggingface/transformers";

// ─── Persistent model cache (IndexedDB) ──────────────────────────────────
// The overlay/app run from a file:// origin. In that context the Cache Storage
// API (`window.caches`) that transformers.js uses for `env.useBrowserCache` is
// unavailable (file:// is not a secure context), so the ~200 MB Whisper model
// silently re-downloaded on every page load — and switching between the overlay
// and the standalone app reloads the page, so it re-downloaded each switch.
//
// IndexedDB IS available on file:// and persists across reloads and restarts,
// so we route transformers' model cache through it via the custom-cache hook.
// The contract (from transformers.js hub.js) is an object implementing
// `match(key) -> Response | undefined` and `put(key, Response)`.
const IDB_NAME = "orbit-whisper-cache";
const IDB_STORE = "files";

let _cacheDbPromise = null;
function openCacheDB() {
  if (_cacheDbPromise) return _cacheDbPromise;
  _cacheDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    _cacheDbPromise = null; // allow retry on a later call
    throw err;
  });
  return _cacheDbPromise;
}

function idbRequest(store, mode, fn) {
  return openCacheDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, mode);
    const req = fn(tx.objectStore(IDB_STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

const indexedDbModelCache = {
  async match(key) {
    try {
      const rec = await idbRequest(IDB_STORE, "readonly", (s) => s.get(key));
      if (!rec) return undefined;
      return new Response(rec.body, { status: 200, headers: rec.headers || {} });
    } catch (e) {
      console.warn("[Whisper] cache match failed:", e?.message);
      return undefined;
    }
  },
  async put(key, response) {
    try {
      const body = await response.arrayBuffer();
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      await idbRequest(IDB_STORE, "readwrite", (s) => s.put({ body, headers }, key));
    } catch (e) {
      // Don't let a cache write failure (e.g. quota) break transcription.
      console.warn("[Whisper] cache put failed:", e?.message);
    }
  }
};

// Disable local model lookups (we want to fetch from the HF hub, not look for
// /models on disk). Route caching through IndexedDB instead of the Cache API
// so the model is downloaded exactly once and reused across reloads.
env.allowLocalModels = false;
env.useBrowserCache = false;
if (typeof indexedDB !== "undefined") {
  env.useCustomCache = true;
  env.customCache = indexedDbModelCache;
} else {
  // No IndexedDB (shouldn't happen in Electron) — fall back to the Cache API.
  env.useBrowserCache = true;
}

// Model choice. whisper-base.en is English-only (74M params, ~290 MB FP32 /
// far less with q4). Excellent for everyday dictation, very low memory and
// VRAM footprint, basically instant transcription on a 5060 Ti.
// Bump to "onnx-community/whisper-small.en" (~240M) for harder audio,
// or "onnx-community/whisper-large-v3-turbo" for max accuracy at higher cost.
const MODEL_ENGLISH = "onnx-community/whisper-base.en";

// Try GPU first, fall back to WASM if WebGPU is unavailable.
async function detectDevice() {
  try {
    if (typeof navigator !== "undefined" && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        console.log("[Whisper] WebGPU adapter found — running on GPU.");
        // q4 = 4-bit quantization. ~4x smaller than fp16 with effectively zero
        // accuracy loss for speech. Cuts whisper-large-v3-turbo from ~1.6 GB
        // to ~400 MB resident. Bump back to "fp16" if you ever want max
        // accuracy at the cost of RAM/VRAM.
        return { device: "webgpu", dtype: "q4" };
      }
    }
  } catch (e) {
    console.warn("[Whisper] WebGPU detection failed:", e?.message);
  }
  console.log("[Whisper] No WebGPU available, falling back to WASM/CPU.");
  return { device: "wasm", dtype: "q8" };
}

let transcriberPromises = {};

function getTranscriber(modelName, onProgress) {
  if (!transcriberPromises[modelName]) {
    transcriberPromises[modelName] = (async () => {
      let { device, dtype } = await detectDevice();
      try {
        return await pipeline("automatic-speech-recognition", modelName, {
          device,
          dtype,
          progress_callback: (p) => {
            // p has: { status, file, progress, loaded, total } during download
            if (onProgress) onProgress(p);
          }
        });
      } catch (gpuErr) {
        if (device === "webgpu") {
          console.warn("[Whisper] WebGPU pipeline initialization failed. Falling back to WASM/CPU...", gpuErr);
          device = "wasm";
          dtype = "q8";
          return await pipeline("automatic-speech-recognition", modelName, {
            device,
            dtype,
            progress_callback: (p) => {
              if (onProgress) onProgress(p);
            }
          });
        }
        throw gpuErr;
      }
    })().catch((err) => {
      // Reset so a retry can re-init instead of permanently failing.
      delete transcriberPromises[modelName];
      throw err;
    });
  }
  return transcriberPromises[modelName];
}

// Decode the recorded audio Blob into a Float32Array of 16 kHz mono PCM,
// which is exactly what Whisper expects.
async function blobToPcm16k(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  // Force the AudioContext to resample to 16 kHz so we don't have to do it ourselves.
  const audioCtx = new AudioContext({ sampleRate: 16000 });
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    // Mix down to mono if needed.
    if (audioBuffer.numberOfChannels === 1) {
      return audioBuffer.getChannelData(0);
    }
    const len = audioBuffer.length;
    const mono = new Float32Array(len);
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch += 1) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < len; i += 1) mono[i] += data[i];
    }
    for (let i = 0; i < len; i += 1) mono[i] /= audioBuffer.numberOfChannels;
    return mono;
  } finally {
    audioCtx.close();
  }
}

// Root-mean-square loudness of a Float32Array PCM buffer. Used as a quick
// energy gate — Whisper hallucinates "Thank you" / "Thanks for watching" / etc.
// from silence, so we skip transcription entirely on very quiet clips.
function computeRMS(samples) {
  if (!samples || samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / samples.length);
}

// Known Whisper hallucinations on silence / music / breathing. Lowercased,
// punctuation/whitespace stripped for comparison.
const WHISPER_HALLUCINATIONS = new Set([
  "thank you",
  "thanks for watching",
  "thanks for watching!",
  "thank you for watching",
  "thanks",
  "bye",
  "goodbye",
  "you",
  ".",
  "...",
  "music",
  "[music]",
  "(music)",
  "subtitles by the amara org community",
  "transcription by castingwords",
  "see you next time",
  "i'll see you next time",
  "see you in the next video"
]);

function isLikelyHallucination(text) {
  const stripped = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  return WHISPER_HALLUCINATIONS.has(stripped);
}

// Empirically chosen. Below ~0.008 RMS is room tone / breathing on most
// consumer mics. Bump down to 0.004 if quiet speakers are getting cut off.
const SILENCE_RMS_THRESHOLD = 0.008;

export async function transcribeWithWhisper(blob, { onProgress } = {}) {
  const transcriber = await getTranscriber(MODEL_ENGLISH, onProgress);
  const audio = await blobToPcm16k(blob);

  // Gate 1: energy threshold. Skip transcription on near-silent audio so
  // Whisper doesn't get the chance to hallucinate from nothing.
  const rms = computeRMS(audio);
  if (rms < SILENCE_RMS_THRESHOLD) {
    return "";
  }

  // Some empirical defaults: chunk_length 30s matches Whisper's training window.
  const options = {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false
  };

  const result = await transcriber(audio, options);

  let text = "";
  if (Array.isArray(result)) {
    text = result.map((r) => r.text).join(" ").trim();
  } else {
    text = (result?.text || "").trim();
  }

  // Gate 2: hallucination blocklist. Even with audible audio, Whisper sometimes
  // outputs one of its favorite phantom phrases.
  if (isLikelyHallucination(text)) {
    return "";
  }

  return text;
}

// Eager warmup: kicks off the model download/load without waiting for the
// first transcribe. Call from app.js after the overlay loads so the first
// voice clip doesn't pay the cold-start cost.
export function warmupWhisper(onProgress) {
  getTranscriber(MODEL_ENGLISH, onProgress).catch(() => { /* surfaced on first real call */ });
}
