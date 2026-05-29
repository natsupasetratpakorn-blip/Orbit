# Orbit Gateway

A small proxy that lets you **sell Orbit access without ever handing out your
GCP login**. It sits on your VPS between the desktop app and Vertex AI:

```
  customer's app ──(license key)──► gateway (your VPS) ──(GCP creds)──► Vertex AI
                                       │
                                       └─ key → plan → daily limit, then forward
```

- **Your GCP credentials never leave the VPS.** Customers get a *license key*,
  which only works against this gateway — it grants no access to your cloud.
- **Plans + limits are hard-coded here** (`config.js`). Customers cannot pick or
  change their plan in the app; they "contact M4sh3r" and you edit one line.
- **Rate limiting is server-side**, so it can't be bypassed by editing the
  app's local storage.

## What runs where

| | Holds GCP creds? | Picks the plan? | Counts usage? |
|---|---|---|---|
| Desktop app | ❌ no | ❌ no | shows only |
| **Gateway (this)** | ✅ yes | ✅ `config.js` | ✅ `usage.json` |

## 1. Create a service account (once)

In your GCP project, make a service account with the **Vertex AI User** role and
download its JSON key:

```bash
gcloud iam service-accounts create orbit-gateway --display-name "Orbit Gateway"
gcloud projects add-iam-policy-binding YOUR_PROJECT \
  --member "serviceAccount:orbit-gateway@YOUR_PROJECT.iam.gserviceaccount.com" \
  --role roles/aiplatform.user
gcloud iam service-accounts keys create orbit-sa-key.json \
  --iam-account orbit-gateway@YOUR_PROJECT.iam.gserviceaccount.com
```

This key is the **only** secret on the box, and it's scoped to Vertex only — it
is *not* your personal gcloud login.

## 2. Configure

```bash
cd gateway
cp .env.example .env          # set GCP_PROJECT, GCP_LOCATION, key path, PORT
npm install
```

Edit `config.js` — add a license key per customer and set their plan:

```js
export const LICENSES = {
  "a1b2c3d4e5f6...": "deepspace",   // give this key to your friend
};
```

Generate keys with:
```bash
node -e "console.log(require('crypto').randomBytes(18).toString('hex'))"
```

## 3. Run

```bash
npm start
# Orbit gateway listening on :8080 (project=..., location=...)
```

Keep it alive with a process manager. Minimal `systemd` unit:

```ini
# /etc/systemd/system/orbit-gateway.service
[Service]
WorkingDirectory=/opt/orbit/gateway
EnvironmentFile=/opt/orbit/gateway/.env
ExecStart=/usr/bin/node server.js
Restart=always
User=orbit
[Install]
WantedBy=multi-user.target
```

**Put TLS in front** (nginx/Caddy) so the license key isn't sent in cleartext.
A one-line Caddy config:

```
orbit.yourdomain.com {
    reverse_proxy localhost:8080
}
```

## 4. Point the app at it

In each customer's Orbit → Settings → **Orbit Cloud**:

- **Server URL:** `https://orbit.yourdomain.com`
- **License key:** their key from `config.js`
- Click **Activate / Refresh plan** → the plan + usage appear in the header.

That's it — they never touch GCP, and you never share a login.

## Changing / revoking a plan

Edit `config.js` and restart (`systemctl restart orbit-gateway`). To revoke,
delete the key. The customer's app reflects it on next launch or **Refresh**.

## Endpoints

```
GET  /health                       -> { ok, project, location }
GET  /v1/usage                     (Bearer key) -> { plan, label, dailyLimit, used }
POST /v1/generate?model=..&stream=1 (Bearer key) -> proxied Vertex SSE/JSON
```

## How the app uses it

When **Server URL** is set, `sendToModel` (`src/shared/ai-service.js`) sends the
fully-built Vertex request body to `POST /v1/generate` with the license key as
the Bearer token instead of calling Vertex directly. The gateway authenticates,
checks the plan limit, adds the real GCP token, picks the model id from
`config.js`, and pipes Vertex's streaming response straight back. With no Server
URL the app falls back to direct gcloud auth (your dev machine).

## Notes

- `usage.json` persists per-key daily counts across restarts; it resets per UTC
  day. Back it up if you care about exact counts.
- The model mapping in `config.js` decides which real Gemini model each Voyager
  tier uses — change it without touching the app.
- Voice transcription is unaffected; it still runs on-device in the app.
