# Cloudflare Zero Trust Tunnels & Docker Networking

## The Core Problem

When `cloudflared` runs **inside Docker**, `localhost` refers to the container's own loopback — not the host machine. So `http://localhost:3001` won't reach the Next.js server running on the host.

## Solution: `host.docker.internal`

In the Cloudflare Zero Trust tunnel config, use:
```
http://host.docker.internal:3001
```

This special Docker DNS name resolves to the host machine's IP from inside any container (works on Docker Desktop for Mac/Windows; on Linux requires `--add-host=host.docker.internal:host-gateway`).

## How to Diagnose

1. Check the cloudflared connector logs for `originService` field:
   ```json
   { "originService": "http://localhost:3001", "Private IP": "172.17.0.4" }
   ```
   If `Private IP` is a `172.x.x.x` address, the connector is in Docker.

2. If you see `502 Bad Gateway`, the tunnel is healthy but can't reach the origin.

3. Change `originService` to `http://host.docker.internal:3001` in the tunnel configuration.

## Next.js Dev Server — `allowedDevOrigins`

When accessing the app through a tunnel (e.g., `tts.s2r2i.com`), Next.js 15.x will block cross-origin requests to `/_next/` assets unless you configure:

```javascript
// next.config.js
...(process.env.ALLOWED_DEV_ORIGINS
  ? { allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS.split(",").map(h => h.trim()) }
  : {})
```

```
# .env
ALLOWED_DEV_ORIGINS=clone.s2r2i.com,tts.s2r2i.com,s2r2i.com
```

**Rules:**
- Values are **hostname only** — no protocol, no trailing slash: `tts.s2r2i.com` ✓, `https://tts.s2r2i.com` ✗
- The option name is `allowedDevOrigins` (not `allowedDevHosts`, which doesn't exist)
- `[]` (empty array) triggers block mode. Use the conditional spread to avoid this.
- This only affects the dev server. In production (`next build`), it's irrelevant.

## AUTH_URL for External Tunnels

NextAuth v5 uses `AUTH_URL` to construct callback URLs. When the app is accessed via a tunnel, set:
```
AUTH_URL=https://tts.s2r2i.com
```

Without this, the OAuth callback URL will point to `localhost` and sign-in will fail.

## Port Visibility

The Next.js dev server inside Docker listens on `HOSTNAME=0.0.0.0` (all interfaces). This is set in both the Dockerfile and docker-compose environment. Without this, the server only accepts connections from `127.0.0.1` inside the container, making it unreachable from outside.

## UFW / Firewall

If the host has UFW enabled and the port isn't exposed:
```bash
sudo ufw allow 3001/tcp
```

Or to allow from specific IP:
```bash
sudo ufw allow from 172.17.0.0/16 to any port 3001
```

## Docker Networking Quick Reference

| From | To | Use |
|---|---|---|
| Container A | Container B (same compose) | Service name: `http://frontend:3001` |
| Container | Host machine | `http://host.docker.internal:3001` |
| Host | Container | `http://localhost:<host_port>` |
| External | Host | Public IP or domain |
| Cloudflared (in Docker) | Host service | `http://host.docker.internal:<port>` |
