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

## 1. Authenticate to Vertex (once)

The gateway uses **Application Default Credentials**, so you don't need a
service-account key (handy if your org disables SA keys). Just log in with
gcloud on the box:

```bash
gcloud auth application-default login --no-launch-browser
gcloud auth application-default set-quota-project YOUR_PROJECT
gcloud services enable aiplatform.googleapis.com --project YOUR_PROJECT
```

That login is stored under `~/.config/gcloud/` and `GoogleAuth` finds it
automatically — leave `GOOGLE_APPLICATION_CREDENTIALS` unset.

> Prefer a service-account key (and your org allows it)? Create one with the
> **Vertex AI User** role and point `GOOGLE_APPLICATION_CREDENTIALS` at the JSON
> file instead. Either path works.

## 2. Configure

```bash
cd gateway
cp .env.example .env          # set GCP_PROJECT, GCP_LOCATION, PORT
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

The gateway URL is hardcoded in the app (`GATEWAY_URL` in
`src/orbit-app/app.js`, currently `https://orbit.masher.me`). Customers only
enter their key: Orbit → Settings → **Orbit Cloud** → paste **license key** →
**Activate**. The plan + usage then show in the header.

That's it — they never touch GCP, and you never share a login.

> **Hosting the website + API together on one box?** See `../DEPLOY.md` for a
> copy-paste, beginner-friendly walkthrough (Docker Compose + automatic HTTPS).
> This file is the deeper reference.

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
