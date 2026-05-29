// ─── Orbit Gateway configuration ─────────────────────────────────────────
// EDIT THIS FILE to control who can use the API and on which plan, then
// restart the gateway. This is the only place plans/keys are defined — the
// desktop app cannot change them.

// Plans and their daily message limits. Use Infinity for unlimited.
export const PLANS = {
  free:         { label: "Free",         dailyLimit: 10 },
  liftoff:      { label: "Liftoff",      dailyLimit: 50 },
  orbit:        { label: "Orbit",        dailyLimit: 200 },
  deepspace:    { label: "Deep Space",   dailyLimit: 600 },
  interstellar: { label: "Interstellar", dailyLimit: Infinity }
};

// License key -> plan id. Hand each friend a unique key and set their plan
// here. To change someone's plan, edit this line and restart. To revoke
// access, delete their key.
//
//   Generate a key:  node -e "console.log(require('crypto').randomBytes(18).toString('hex'))"
export const LICENSES = {
  "REPLACE-WITH-A-REAL-KEY": "liftoff"
  // "a1b2c3...": "deepspace",
  // "d4e5f6...": "interstellar",
};

// Voyager display name -> Vertex model id. Mirrors src/shared/models.js so the
// gateway, not the client, decides which real model each tier maps to.
export const MODEL_IDS = {
  "Voyager 1": "gemini-2.5-flash",
  "Voyager 1 Flash": "gemini-2.5-flash-lite",
  "Voyager 2": "gemini-3.1-flash-lite",
  "Voyager 2 Pro": "gemini-3.1-pro",
  "Voyager 2.1 Preview": "gemini-3.5-flash",
  "Orchestra 1.1": "gemini-2.5-flash-lite"
};
export const DEFAULT_MODEL_ID = "gemini-2.5-flash-lite";
