// ─── Orbit Gateway ─────────────────────────────────────────────────────────
// A thin proxy that sits between the Orbit desktop app and Google Vertex AI.
//
//   app ──(license key)──► gateway ──(GCP service-account creds)──► Vertex AI
//
// The gateway holds the GCP credentials, so they NEVER ship to a customer. It
// authenticates each request by a license key, looks up the key's plan,
// enforces a per-day message limit, then forwards the request to Vertex and
// streams the response straight back. Plans/keys live in config.js.
import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { PLANS, LICENSES, MODEL_IDS, DEFAULT_MODEL_ID } from "./config.js";

const PORT = Number(process.env.PORT) || 8080;
const PROJECT = process.env.GCP_PROJECT;
const LOCATION = process.env.GCP_LOCATION || "us-central1";
const USAGE_FILE = process.env.USAGE_FILE || path.join(process.cwd(), "usage.json");

if (!PROJECT) {
  console.error("FATAL: GCP_PROJECT env var is required.");
  process.exit(1);
}

// Vertex auth via Application Default Credentials. GoogleAuth resolves these in
// order: GOOGLE_APPLICATION_CREDENTIALS (a key file, if set), then a `gcloud auth
// application-default login` token, then the runtime service account. So a
// plain gcloud login on the box works with no key file.
const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

// ─── Usage tracking (per license key, per UTC day) ──────────────────────────
function today() { return new Date().toISOString().slice(0, 10); }
let usage = {};
try { usage = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")); } catch { usage = {}; }
function saveUsage() {
  try { fs.writeFileSync(USAGE_FILE, JSON.stringify(usage)); }
  catch (e) { console.warn("usage save failed:", e.message); }
}
function getUsed(key) {
  const rec = usage[key];
  return rec && rec.date === today() ? rec.count : 0;
}
function bump(key) {
  const d = today();
  if (!usage[key] || usage[key].date !== d) usage[key] = { date: d, count: 0 };
  usage[key].count += 1;
  saveUsage();
}

// ─── System-instruction context caching ─────────────────────────────────────
// The Orbit system prompt is large (multiple KB) and stable within a user's
// session. We register it once as a Vertex cachedContents resource and then
// reference it by name on later turns, so its tokens bill at the cheaper cached
// rate instead of being re-sent in full every request. Keyed by a hash of the
// prompt text + model, so each user's prompt naturally gets its own cache and
// reuses it across their turns. Every failure path leaves the request untouched
// (inline systemInstruction), so caching can never break a generate call.
const CACHE_TTL_SECONDS = 1800;          // server-side TTL: 30 min
const CACHE_REUSE_MS = 25 * 60 * 1000;   // stop reusing ~5 min before TTL
const MIN_CACHEABLE_CHARS = 8000;        // ~2k tokens; below this a round-trip isn't worth it
const sysCaches = new Map();             // key -> { name, expiresAt }
const cacheUnsupported = new Set();      // modelIds that rejected caching (don't retry)

function systemTextFromBody(body) {
  const parts = body?.systemInstruction?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
}

async function getOrCreateSystemCache({ host, modelId, systemText, token }) {
  if (cacheUnsupported.has(modelId)) return null;
  const now = Date.now();
  const hash = crypto.createHash("sha256").update(`${modelId}\n${systemText}`).digest("hex");
  const key = `${modelId}:${hash}`;
  const hit = sysCaches.get(key);
  if (hit && hit.expiresAt > now) return hit.name;
  for (const [k, v] of sysCaches) { if (v.expiresAt <= now) sysCaches.delete(k); }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(
      `https://${host}/v1/projects/${PROJECT}/locations/${LOCATION}/cachedContents`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${modelId}`,
          systemInstruction: { parts: [{ text: systemText }] },
          ttl: `${CACHE_TTL_SECONDS}s`
        }),
        signal: controller.signal
      }
    );
    if (!res.ok) {
      if (res.status === 400 || res.status === 404) cacheUnsupported.add(modelId);
      return null;
    }
    const data = await res.json();
    if (!data?.name) return null;
    sysCaches.set(key, { name: data.name, expiresAt: now + CACHE_REUSE_MS });
    return data.name;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function planFor(key) {
  const id = LICENSES[key];
  if (!id || !PLANS[id]) return null;
  return { id, ...PLANS[id] };
}
function keyFrom(req) {
  return (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

const app = express();
app.use(cors());                       // allow the file:// app origin
app.use(express.json({ limit: "25mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, project: PROJECT, location: LOCATION }));

// Returns the caller's plan + today's usage. The app shows this; it cannot change it.
app.get("/v1/usage", (req, res) => {
  const plan = planFor(keyFrom(req));
  if (!plan) return res.status(401).json({ error: "invalid license key" });
  res.json({
    plan: plan.id,
    label: plan.label,
    dailyLimit: plan.dailyLimit === Infinity ? -1 : plan.dailyLimit,
    used: getUsed(keyFrom(req))
  });
});

// Proxy a generateContent / streamGenerateContent request to Vertex. The app
// sends the fully-built Vertex request body; the gateway only adds auth, picks
// the real model id, and enforces the plan limit.
app.post("/v1/generate", async (req, res) => {
  const key = keyFrom(req);
  const plan = planFor(key);
  if (!plan) return res.status(401).json({ error: "invalid license key" });

  const used = getUsed(key);
  if (plan.dailyLimit !== Infinity && used >= plan.dailyLimit) {
    return res.status(429).json({
      error: "daily limit reached", plan: plan.label, used, dailyLimit: plan.dailyLimit
    });
  }

  const modelName = String(req.query.model || "");
  const stream = String(req.query.stream || "0") === "1";
  const modelId = MODEL_IDS[modelName] || DEFAULT_MODEL_ID;

  let token;
  try {
    const client = await auth.getClient();
    const t = await client.getAccessToken();
    token = typeof t === "string" ? t : t?.token;
    if (!token) throw new Error("empty access token");
  } catch (e) {
    return res.status(500).json({ error: "gateway auth failed: " + e.message });
  }

  const host = LOCATION === "global" ? "aiplatform.googleapis.com" : `${LOCATION}-aiplatform.googleapis.com`;
  const endpoint = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const url = `https://${host}/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${modelId}:${endpoint}`;

  // Serve the (large, mostly-stable) system prompt from a context cache when we
  // can. On a hit we swap the inline systemInstruction for a cachedContent
  // reference, which Vertex requires to be sent WITHOUT a systemInstruction.
  const body = req.body || {};
  const systemText = systemTextFromBody(body);
  if (systemText.length >= MIN_CACHEABLE_CHARS) {
    const cacheName = await getOrCreateSystemCache({ host, modelId, systemText, token });
    if (cacheName) {
      body.cachedContent = cacheName;
      delete body.systemInstruction;
    }
  }

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return res.status(502).json({ error: "vertex request failed: " + e.message });
  }

  // Only count the request once Vertex has accepted it.
  if (upstream.ok) bump(key);

  res.status(upstream.status);
  const ct = upstream.headers.get("content-type");
  if (ct) res.set("content-type", ct);

  if (!upstream.body) {
    return res.send(await upstream.text());
  }
  // Pipe the SSE / JSON body straight through to the app.
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
    /* client disconnected or upstream broke mid-stream */
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Orbit gateway listening on :${PORT}  (project=${PROJECT}, location=${LOCATION})`);
  console.log(`Licensed keys: ${Object.keys(LICENSES).length}`);
});
