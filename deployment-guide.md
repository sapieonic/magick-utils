# MagickUtils — EC2 Deployment Guide

This guide covers deploying the **MagickUtils** analytics app (a Next.js 16 server) on a single EC2 instance using Docker for the application and Nginx on the host as a reverse proxy with SSL. It is bound to **`analytics.magickvoice.com`**.

Unlike `magic-voice-core`, MagickUtils has **no local database or cache containers**: MongoDB is hosted on Atlas, and the platform API (`magick-master`) and the LLM provider are external. The deployment is therefore a single app container + Nginx + SSL.

## Architecture

```
Internet (HTTPS)
    │
    └── analytics.magickvoice.com
            │
            ▼
        ┌─────────────────────────────────────────────────┐
        │  EC2 Instance                                   │
        │                                                 │
        │  Nginx (host)                                   │
        │    analytics.magickvoice.com :443               │
        │      └── /  → proxy 127.0.0.1:3008              │
        │                                                 │
        │  Docker                                         │
        │    └── app  → 127.0.0.1:3008 → :3000 (localhost) │
        └─────────────────────────────────────────────────┘
                          │  outbound (HTTPS)
                          ├──► magick-master  (appi.magickvoice.com)  — auth + campaign data
                          ├──► MongoDB Atlas                          — cached batches/records/aggregates
                          └──► LLM provider (e.g. NVIDIA NIM)         — AI insights + chat
```

| Domain | Purpose |
|--------|---------|
| `analytics.magickvoice.com` | MagickUtils analytics app — Nginx reverse-proxies to the Next.js server |

The app authenticates users against `magick-master` (Firebase id_token → session cookie), reads campaign data through it, caches/normalizes it in MongoDB, and uses the LLM for AI insights and chat.

## Prerequisites

- **EC2 instance**: t3.small or larger (2 vCPU, 2 GB RAM minimum; 4 GB recommended for builds)
- **OS**: Ubuntu 22.04 LTS
- **Storage**: 20 GB+ EBS volume
- **Security group**: Open ports 22 (SSH), 80 (HTTP), 443 (HTTPS)
- **DNS**: One A record pointing to your EC2 public IP:
  - `analytics.magickvoice.com → <SERVER_IP>`
- **MongoDB Atlas**: a cluster + database user, with the EC2 public IP added to **Network Access** (IP allowlist)
- **magick-master** reachable at its base URL (e.g. `https://appi.magickvoice.com`)
- **Firebase web config** (apiKey / authDomain / projectId / appId) for the login screen
- **LLM credentials**: an OpenAI-compatible endpoint + key (e.g. NVIDIA NIM, OpenRouter, Moonshot) or an Anthropic key

## 1. Install Dependencies

SSH into your EC2 instance and run:

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Install Docker Compose plugin
sudo apt install -y docker-compose-plugin

# Install Nginx
sudo apt install -y nginx

# Install Certbot for SSL
sudo apt install -y certbot python3-certbot-nginx

# Log out and back in for the docker group to take effect
exit
```

After logging back in, verify:

```bash
docker --version
docker compose version
nginx -v
```

## 2. Clone the Repository

```bash
cd /opt
sudo mkdir magick-utils && sudo chown $USER:$USER magick-utils
git clone <your-repo-url> magick-utils
cd magick-utils
```

## 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with production values. **Mind the two classes of variable** (the app reads server-only vars at runtime, but `NEXT_PUBLIC_*` are compiled into the browser bundle at build time):

```bash
# --- Server-only (runtime) ---

# Whitelabel brand pack to render (brands/<id>/). Default: magickvoice.
# Resolved at runtime, so the same image whitelabels per deployment — no rebuild.
BRAND=magickvoice

# Platform API — auth + live campaign data
MAGICK_MASTER_BASE_URL=https://appi.magickvoice.com

# Session cookie secret (>= 32 chars). Generate a strong one:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
SESSION_SECRET=<32+ char secret>

# MongoDB Atlas — allowlist this server's IP in Atlas → Network Access
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster.example.mongodb.net/?appName=MagickUtils
MONGODB_DB=magickutils

# LLM (AI insights + chat). openai-compatible covers NVIDIA NIM / OpenRouter / Moonshot / vLLM.
#   • LLM_BASE_URL must be the API ROOT — the SDK appends "/chat/completions"
#   • LLM_API_KEY is the RAW key, with NO "Bearer " prefix
LLM_PROVIDER=openai-compatible
LLM_MODEL=moonshotai/kimi-k2-instruct
LLM_BASE_URL=https://integrate.api.nvidia.com/v1
LLM_API_KEY=nvapi-...

# --- Build-time (baked into the client bundle) ---
# Firebase web config used by the login screen to obtain an id_token.
NEXT_PUBLIC_FIREBASE_API_KEY=AIza...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=magickvoice-prd.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=magickvoice-prd
NEXT_PUBLIC_FIREBASE_APP_ID=1:...:web:...
```

> **Why the split matters:** `next build` inlines `NEXT_PUBLIC_*` into the JavaScript served to the browser. If they're missing at build time, the login screen can't initialise Firebase even if the values are present at runtime. The Docker build reads them as build args (see step 4). All other values are read by the server at runtime and can be rotated by restarting the container — no rebuild needed.

> **`.env` is gitignored and excluded from the image** (`.dockerignore`). Secrets live only on the host and are injected at runtime; only the `NEXT_PUBLIC_*` values are compiled in.

## 4. Build and Start the App

Docker Compose auto-loads `.env` from the project directory for both build-arg substitution (the `NEXT_PUBLIC_*` values) and the container's runtime environment:

```bash
cd /opt/magick-utils
docker compose --env-file .env up -d --build
```

This builds the multi-stage image (`node:24-alpine`, Next.js standalone output) and starts:

- `app` — the Next.js server published on `127.0.0.1:3008` (localhost only; the container listens on 3000 internally)

Verify it's up:

```bash
docker compose ps
curl -s http://127.0.0.1:3008/api/health
# Expected: {"ok":true,"backend":true,"llm":true}
#   backend:true  → MAGICK_MASTER_BASE_URL + SESSION_SECRET are set
#   llm:true       → LLM_* are set
```

> Prefer plain Docker? `docker build -t magick-utils --build-arg NEXT_PUBLIC_FIREBASE_API_KEY=... [other NEXT_PUBLIC_* args] .` then `docker run -d -p 127.0.0.1:3008:3000 --env-file .env --restart unless-stopped magick-utils`. Add `-v "$PWD/brands:/app/brands:ro"` to mount brand packs (see below).

### Whitelabeling (brand packs)

The UI is whitelabeled by the `BRAND` env var, which selects a pack under
`brands/<id>/` (`brand.config.json` + `logo.png`). It's resolved at **runtime**,
so one image serves any brand — set `BRAND` per deployment, no rebuild. Every
brand committed to the repo is baked into the image, and compose also bind-mounts
the host `brands/` dir (read-only) over it.

To add or change a brand **without rebuilding**:

```bash
cp -r brands/magickvoice brands/acme    # then edit brands/acme/brand.config.json + logo.png
echo "BRAND=acme" >> .env               # (or edit the existing BRAND line)
docker compose --env-file .env up -d    # restart only — no --build needed
```

An unknown/empty `BRAND` fails closed to the default MagickVoice look rather than
erroring. See `brands/README.md` for the config schema.

## 5. Configure Nginx

Create a server block that reverse-proxies `analytics.magickvoice.com` to the app on `127.0.0.1:3008`:

```bash
sudo tee /etc/nginx/sites-available/analytics > /dev/null <<'NGINX'
server {
    listen 80;
    server_name analytics.magickvoice.com;

    # Allow large CSV exports to stream through.
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3008;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Streamed responses (LLM chat SSE, CSV export) — don't buffer.
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
NGINX

# Enable the site
sudo ln -sf /etc/nginx/sites-available/analytics /etc/nginx/sites-enabled/

# Test and reload
sudo nginx -t
sudo systemctl reload nginx
```

At this point `http://analytics.magickvoice.com` proxies to the app.

## 6. Enable SSL with Let's Encrypt

```bash
sudo certbot --nginx -d analytics.magickvoice.com
```

Certbot will obtain the certificate, add `listen 443 ssl` + the HTTP→HTTPS redirect to the server block, reload Nginx, and set up auto-renewal via a systemd timer.

Verify auto-renewal:

```bash
sudo certbot renew --dry-run
```

## 7. Verify the Deployment

```bash
# App health (through the proxy)
curl -s https://analytics.magickvoice.com/api/health
# Expected: {"ok":true,"backend":true,"llm":true}

# HTTP redirects to HTTPS
curl -I http://analytics.magickvoice.com   # expect 301 → https://
```

Then open `https://analytics.magickvoice.com` in a browser: the login screen should appear, accept a tenant login, and the dashboard / campaigns / analytics screens should load live data.

## Updating the Deployment

```bash
cd /opt/magick-utils

# Pull latest code
git pull origin main

# Rebuild and restart (rebuild is required if NEXT_PUBLIC_* or app code changed)
docker compose --env-file .env up -d --build
```

> Rotating a **server-only** secret (Mongo, LLM, magick-master, session) only needs a restart — no rebuild:
> ```bash
> docker compose --env-file .env up -d
> ```
> Changing a **`NEXT_PUBLIC_*`** value requires `--build` (it's compiled into the bundle).

### Nginx config update

If you change the server block:

```bash
sudo nano /etc/nginx/sites-available/analytics
sudo nginx -t && sudo systemctl reload nginx
```

> Certbot writes the SSL directives into this file. If you replace the file wholesale, re-run `sudo certbot --nginx -d analytics.magickvoice.com` to restore them.

## Monitoring

### Logs

```bash
# App logs
docker compose logs -f app

# Nginx access/error logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### Status

```bash
docker compose ps          # container + health status (HEALTHCHECK hits /api/health)
docker stats               # resource usage
sudo systemctl status nginx
```

The image declares a `HEALTHCHECK` against `/api/health`, so `docker compose ps` shows `healthy`/`unhealthy` directly.

## Troubleshooting

### `/api/health` shows `backend:false` or `llm:false`

The corresponding env group isn't fully set in the container.
- `backend:false` → `MAGICK_MASTER_BASE_URL` and/or `SESSION_SECRET` missing. Check: `docker compose exec app printenv MAGICK_MASTER_BASE_URL SESSION_SECRET`.
- `llm:false` → `LLM_MODEL` / `LLM_API_KEY` missing.

### AI Insights / chat fail with `llm_failed` and `404 page not found`

`LLM_BASE_URL` includes the route path. It must be the **API root** — the SDK appends `/chat/completions` itself. Use `https://host/v1`, not `https://host/v1/chat/completions`.

### AI Insights / chat fail with `401`

`LLM_API_KEY` includes a `Bearer ` prefix (or quotes). Use the **raw** key only — the SDK adds the `Authorization: Bearer` header.

### Login screen does nothing / "Firebase is not configured"

The `NEXT_PUBLIC_FIREBASE_*` values weren't present at **build** time, so they aren't in the client bundle. Set them in `.env` and rebuild: `docker compose --env-file .env up -d --build`. (Setting them only at runtime has no effect — they're compiled in.)

### MongoDB connection errors / timeouts

- Add the EC2 **public IP** to MongoDB Atlas → Network Access. Atlas blocks unlisted IPs.
- Verify the URI/credentials: `docker compose exec app printenv MONGODB_URI`.
- Atlas SRV resolution needs outbound DNS/TCP 27017 from the instance.

### 502 Bad Gateway from Nginx

The app container isn't reachable on `127.0.0.1:3008`.
- `docker compose ps` — is `app` running and `healthy`?
- `curl http://127.0.0.1:3008/api/health` — does it respond directly?
- `docker compose logs app --tail=50` — startup errors?

### Container keeps restarting

```bash
docker compose logs app --tail=80
```
Common causes: an invalid env value, the build failing to find `.next/standalone` (ensure `output: "standalone"` is in `next.config.ts`), or the host being out of memory during build (use a 4 GB instance or build the image elsewhere and `docker compose pull`).

### Browser shows the old / wrong favicon

The favicon is served at runtime from the active brand's logo (`/logo`, wired via
`metadata.icons`), so it follows `BRAND`. Browsers cache favicons aggressively —
hard-refresh (Cmd/Ctrl+Shift+R) or open a new tab. If it's showing the default
MagickVoice mark for a whitelabel, confirm `BRAND` is set and `brands/<id>/logo.png`
exists (a missing brand logo falls back to the default).

### Certbot fails to obtain a certificate

Ensure the DNS A record is propagated (`dig +short analytics.magickvoice.com`), port 80 is open in the security group, and Nginx is running. Certbot uses the HTTP-01 challenge over port 80.
