# How to put Orbit online (website + API)

Plain-English, copy-paste steps. By the end you'll have:

- **Your website** at `https://orbit.masher.me`
- **The API** (what the app talks to) at `https://orbit.masher.me/v1/...`
- Both running on **one** server, with HTTPS set up automatically.

You give each friend a **license key**. The app already knows to talk to
`orbit.masher.me` — they just paste the key. Your Google Cloud login is never
shared.

You only do steps 1–6 once. After that, adding a friend is one line (step 7).

---

## Step 1 — Get a server

Rent a small Linux server ("VPS") from anywhere (Hetzner, DigitalOcean, AWS
Lightsail, etc.). Pick **Ubuntu 22.04 or 24.04**. Note its **IP address**
(looks like `203.0.113.45`).

> A tiny/cheap server is fine — the API just forwards requests to Google.

## Step 2 — Point your domain at it

In wherever you manage `masher.me` (your DNS), add a record:

| Type | Name | Value |
|------|------|-------|
| A | `orbit` | your server's IP from step 1 |

That makes `orbit.masher.me` point to your server. (Wait a few minutes for it
to take effect.)

## Step 3 — Log into the server and install Docker

Connect to the server:

```bash
ssh root@YOUR_SERVER_IP
```

Install Docker (one command):

```bash
curl -fsSL https://get.docker.com | sh
```

## Step 4 — Get the Orbit code onto the server

```bash
git clone YOUR_REPO_URL orbit
cd orbit/deploy
```

(Replace `YOUR_REPO_URL` with wherever this project lives on GitHub.)

## Step 5 — Add your Google Cloud key

The server needs permission to use Vertex AI. You make a "service account key"
once. On your **own computer** (where `gcloud` is set up), run:

```bash
gcloud iam service-accounts create orbit-gateway
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member "serviceAccount:orbit-gateway@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role roles/aiplatform.user
gcloud iam service-accounts keys create orbit-sa-key.json \
  --iam-account orbit-gateway@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

This makes a file `orbit-sa-key.json`. **Copy it to the server** into
`orbit/deploy/data/`:

```bash
# on the server:
mkdir -p ~/orbit/deploy/data
# then, from your computer, upload the file (run this on your computer):
scp orbit-sa-key.json root@YOUR_SERVER_IP:~/orbit/deploy/data/
```

> This key only allows using the AI — it is **not** your personal login and
> can't touch the rest of your Google account.

## Step 6 — Fill in two settings and start it

Back on the **server**, in `orbit/deploy`:

```bash
cp gateway.env.example gateway.env
nano gateway.env
```

Set `GCP_PROJECT` to your Google Cloud project id, save (Ctrl+O, Enter) and
exit (Ctrl+X). Then start everything:

```bash
docker compose up -d --build
```

Wait ~30 seconds. Check it works:

```bash
curl https://orbit.masher.me/v1/usage -H "Authorization: Bearer test"
```

If you see `{"error":"invalid license key"}` — **it's working!** (That key isn't
real yet; that's the next step.) Visiting `https://orbit.masher.me` in a browser
should show your website.

---

## Step 7 — Give a friend access (do this per friend)

1. Make a random key on the server:

   ```bash
   openssl rand -hex 18
   ```
   Copy the long string it prints.

2. Open the plans file:

   ```bash
   nano ~/orbit/gateway/config.js
   ```

   In the `LICENSES` section, add a line with the key and the plan you're
   selling them (`liftoff`, `orbit`, `deepspace`, or `interstellar`):

   ```js
   export const LICENSES = {
     "paste-the-key-here": "deepspace",
   };
   ```
   Save and exit (Ctrl+O, Enter, Ctrl+X).

3. Apply it:

   ```bash
   cd ~/orbit/deploy && docker compose restart gateway
   ```

4. Send your friend that key. In their Orbit app they go to
   **Settings → Orbit Cloud**, paste the key, click **Activate** — done. They're
   on the plan you chose, with the daily limit for that plan.

**To change someone's plan or cut them off:** edit that line in `config.js`
(change the plan, or delete the line), then `docker compose restart gateway`.

---

## Everyday commands

| I want to… | Run this (in `~/orbit/deploy`) |
|---|---|
| See if it's running | `docker compose ps` |
| Read the logs | `docker compose logs -f gateway` |
| Apply a plan/key change | `docker compose restart gateway` |
| Update the website/code | `cd ~/orbit && git pull && cd deploy && docker compose up -d --build` |
| Stop everything | `docker compose down` |

## The plans (and their daily limits)

These live in `gateway/config.js` and match your website's pricing:

| Plan | Daily messages |
|---|---|
| Liftoff | 50 |
| Orbit | 200 |
| Deep Space | 600 |
| Interstellar | unlimited |

Change a number there if you want; restart the gateway to apply.

---

### Why this is safe to sell

- Your Google Cloud key sits **only** on your server, never in the app.
- Friends get a license key that **only** works against your server — it gives
  them no access to your cloud account.
- The daily limit is counted **on your server**, so they can't cheat it.
- Want to revoke someone? Delete their key, restart. Instant.
