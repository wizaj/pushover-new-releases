# pushover-new-releases

> Forward [NewReleases.io](https://newreleases.io) webhooks to [Pushover](https://pushover.net) so you get a push on your phone the instant a tracked project ships a new release.

Tiny Node.js service. No database. Verifies HMAC signatures correctly (unlike the signature snippet you'll find copy-pasted around the internet). Drop-in systemd + nginx configs included.

```
┌─────────────────┐   webhook POST   ┌──────────────────┐   POST   ┌──────────┐
│ NewReleases.io  │ ───────────────▶ │  this service    │ ───────▶ │ Pushover │
│ (tracks a repo) │                  │  (port 3456)     │          │   API    │
└─────────────────┘                  └──────────────────┘          └──────────┘
```

---

## Features

- ✅ **Correct HMAC-SHA256 signature verification** — hex-decodes the header before comparing, handles upper/lowercase hex, length-guarded `timingSafeEqual`, matches the [NewReleases Go reference impl](https://newreleases.io/webhooks) byte-for-byte.
- 📬 Pretty push notifications with title, version, release-note excerpt, and a tap-through link to the GitHub release page.
- 🤫 Pre-releases delivered at Pushover priority `-1` (silent) so they don't wake you at 3 a.m.
- 🩺 `/health` endpoint for uptime monitoring.
- 🔍 Optional `DEBUG_SIG=1` to log computed-vs-received signatures when verification fails.
- 🐧 Ships with systemd unit + nginx reverse-proxy example.

---

## Quick start

### Prerequisites

- Node.js 18+
- A [Pushover](https://pushover.net) account — grab your **user key** and create an **application token**
- A [NewReleases.io](https://newreleases.io) account

### Install

```bash
git clone https://github.com/wizaj/pushover-new-releases.git
cd pushover-new-releases
npm install
cp .env.example .env
# edit .env with your credentials
node server.js
```

Server listens on `http://localhost:3456` by default.

### Create the webhook in NewReleases

1. Go to **Settings → Webhooks → Add Webhook**.
2. Set the URL to your public endpoint, e.g. `https://webhook.example.com/webhook/newreleases`.
3. Copy the **signing secret** (click the "Key" button next to the webhook).
4. Paste it into `.env` as `NEWRELEASES_SECRET`, restart the service.
5. On a project's page, click **Track** and enable the webhook under notification settings.

Hit the **Test** button on the webhook to confirm you get a 🚀 push.

---

## Configuration

All config is via environment variables (loaded from `.env` via `dotenv` or provided by systemd / your process supervisor).

| Variable             | Required | Default | Description                                                              |
|----------------------|:--------:|---------|--------------------------------------------------------------------------|
| `PUSHOVER_USER`      |    ✅    | —       | Your Pushover user key.                                                  |
| `PUSHOVER_TOKEN`     |    ✅    | —       | Your Pushover application API token.                                     |
| `NEWRELEASES_SECRET` |    ⭐    | —       | Webhook signing secret from NewReleases. If unset, signature check is **skipped** — **set this in production.** |
| `PORT`               |          | `3456`  | TCP port to listen on.                                                   |
| `DEBUG_SIG`          |          | off     | Set to `1` to log signature-verification diagnostics.                    |

---

## How it works

### Request path

`POST /webhook/newreleases` — NewReleases posts JSON here. The service:

1. Captures the raw request body before JSON parsing (needed for signature verification).
2. Computes `HMAC-SHA256(secret, timestamp + "." + rawBody)`.
3. Hex-decodes `X-NewReleases-Signature` and compares against the computed digest with `crypto.timingSafeEqual`.
4. On success, forwards a formatted notification to Pushover and returns `200`.
5. On invalid signature, returns `401`. On Pushover failures, `500`. NewReleases will retry non-2xx responses.

### Pushover formatting

| Field      | Value                                                      |
|------------|------------------------------------------------------------|
| Title      | `🚀 {project} {version}`                                   |
| Message    | First 500 chars of the release note (HTML stripped), or a default string. |
| URL        | `https://github.com/{project}/releases/tag/{version}` (for GitHub projects) |
| URL title  | `View Release`                                             |
| Priority   | `0` (normal), or `-1` (silent) for pre-releases            |

---

## Production deployment (systemd + nginx)

### 1. Install

```bash
sudo useradd --system --home /opt/pushover-new-releases --shell /usr/sbin/nologin pushover
sudo git clone https://github.com/wizaj/pushover-new-releases.git /opt/pushover-new-releases
cd /opt/pushover-new-releases
sudo -u pushover npm install --omit=dev
sudo -u pushover cp .env.example .env
sudo -u pushover ${EDITOR:-nano} .env
sudo chown -R pushover:pushover /opt/pushover-new-releases
```

### 2. systemd

A hardened unit file ships in the repo ([`newreleases-pushover.service`](./newreleases-pushover.service)). Install and enable:

```bash
sudo cp newreleases-pushover.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now newreleases-pushover
sudo systemctl status newreleases-pushover
```

### 3. nginx reverse proxy

Example config in [`nginx.conf`](./nginx.conf). Adjust `server_name`, then:

```bash
sudo cp nginx.conf /etc/nginx/sites-available/pushover-new-releases
sudo ln -s /etc/nginx/sites-available/pushover-new-releases /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Issue a cert and enable HTTPS (NewReleases validates certs before delivering webhooks):

```bash
sudo certbot --nginx -d webhook.example.com
```

### Alternatives

- **Cloudflare Tunnel** — expose a local instance without port-forwarding: `cloudflared tunnel --url http://localhost:3456`.
- **Docker** — trivial to containerize; PRs welcome.

---

## Testing locally

Simulate a signed webhook from your shell:

```bash
SECRET="your_signing_secret"
TS=$(date +%s)
BODY='{"provider":"github","project":"nodejs/node","version":"v22.0.0","note":{"message":"<p>Release notes</p>"}}'
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -i -X POST http://localhost:3456/webhook/newreleases \
  -H "Content-Type: application/json" \
  -H "X-NewReleases-Timestamp: $TS" \
  -H "X-NewReleases-Signature: $SIG" \
  --data-raw "$BODY"
```

Expect `HTTP/1.1 200 OK`. Flip a byte in `SIG` and you'll get `401 Invalid signature`.

---

## Security notes

- The signing secret is **the only thing** protecting your endpoint from forged Pushover spam. Treat it like a password.
- The service **skips** signature verification when `NEWRELEASES_SECRET` is unset — convenient for local development, dangerous in production. Always set it when exposed to the internet.
- `.env` is git-ignored. Don't commit secrets.
- Run under a dedicated unprivileged user (the provided systemd unit uses `User=pushover` + `ProtectSystem=strict`).

### Why did I write a whole thing about signature verification?

Because the signature-check code I wrote first (and that lots of Node snippets online do) had a subtle bug: it compared hex strings byte-for-byte as utf8 buffers instead of hex-decoding them first. This silently broke on uppercase/lowercase differences and left the service 401-ing every real webhook. The current implementation matches the [NewReleases Go reference](https://newreleases.io/webhooks) semantics exactly — see [`server.js`](./server.js).

---

## License

[MIT](./LICENSE) © Wiza Jalakasi
