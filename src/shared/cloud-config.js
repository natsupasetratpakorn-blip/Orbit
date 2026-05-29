// ─── Orbit Cloud config (shared) ─────────────────────────────────────────────
// The gateway (your VPS) holds the GCP creds and enforces the plan limit. Both
// the full app and the floating overlay route AI calls through it; the main
// process owns the license key so the two windows behave identically. Change
// the gateway URL here only.
export const GATEWAY_URL = "https://orbit.masher.me";
