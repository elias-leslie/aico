# Remote Access

By default, A-Term listens on `localhost` — accessible only from the machine running it. This guide assumes A-Term is running natively on the host so remote users connect to the same tmux/user session.

## Quick Comparison

| Approach | Access Scope | HTTPS | Setup Effort | Best For |
|----------|-------------|-------|-------------|----------|
| [Tailscale](#tailscale) | Your devices anywhere | Automatic | ~5 min | Personal use, accessing from phone/tablet |
| [Cloudflare Tunnel](#cloudflare-tunnel) | Anyone with the URL | Automatic | ~15 min | Sharing with others, public access with auth |
| [Caddy reverse proxy](#caddy-reverse-proxy) | Local network | Automatic (self-signed or ACME) | ~10 min | Home/office LAN, custom domain |

All three approaches sit in front of A-Term and proxy traffic to it. For anything beyond localhost, configure browser auth first with either `A_TERM_AUTH_MODE=password` or `A_TERM_AUTH_MODE=proxy`.

## Prerequisites

A-Term should already be running:
- Backend on port **8002**
- Frontend on port **3002**

For all approaches, update `CORS_ORIGINS` in your environment to include the origin you'll access A-Term from and make sure auth is enabled before exposing a non-loopback bind:

```bash
# In ~/.env.local
CORS_ORIGINS=["http://localhost:3002","https://a-term.your-domain.com"]
A_TERM_AUTH_MODE=password
A_TERM_AUTH_PASSWORD=change-me
A_TERM_AUTH_SECRET=replace-with-a-long-random-string
```

---

## Tailscale

[Tailscale](https://tailscale.com) creates a private mesh network across your devices. Every device gets a stable IP and optional MagicDNS hostname. No port forwarding, no firewall rules, no public exposure.

### Setup

1. **Install Tailscale** on the machine running A-Term and on any device you want to access it from:

   ```bash
   # Debian/Ubuntu
   curl -fsSL https://tailscale.com/install.sh | sh

   # macOS
   brew install tailscale
   ```

2. **Authenticate:**

   ```bash
   sudo tailscale up
   ```

3. **Find your Tailscale IP:**

   ```bash
   tailscale ip -4
   # Example: 100.64.1.42
   ```

4. **Access A-Term** from any device on your Tailnet:

   ```
   http://100.64.1.42:3002
   ```

### Optional: MagicDNS

Enable [MagicDNS](https://tailscale.com/kb/1081/magicdns) in the Tailscale admin console to use hostnames instead of IPs:

```
http://your-machine-name:3002
```

### Optional: Tailscale Serve (HTTPS)

[Tailscale Serve](https://tailscale.com/kb/1312/serve) provides automatic HTTPS with valid certificates on your Tailnet:

```bash
# Serve the frontend
tailscale serve --bg https+insecure://localhost:3002

# Serve the backend API on a different port
tailscale serve --bg --set-path /api https+insecure://localhost:8002/api
```

Access at `https://your-machine-name.your-tailnet.ts.net`.

### Optional: Tailscale Funnel (public access)

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) exposes your Tailscale Serve endpoint to the public internet:

```bash
tailscale funnel 443 on
```

> **Note:** Funnel makes A-Term accessible to anyone with the URL. Use with caution — A-Term provides shell access to the host machine.

---

## Cloudflare Tunnel

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) creates an outbound-only connection from your machine to Cloudflare's network. No open ports, automatic HTTPS, and optional access policies (SSO, email OTP, etc.).

**Requires:** A domain managed by Cloudflare (free tier works).

### Setup

1. **Install cloudflared:**

   ```bash
   # Debian/Ubuntu
   curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
   echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
   sudo apt update && sudo apt install cloudflared

   # macOS
   brew install cloudflared
   ```

2. **Authenticate with Cloudflare:**

   ```bash
   cloudflared tunnel login
   ```

3. **Create a tunnel:**

   ```bash
   cloudflared tunnel create a-term
   ```

4. **Configure the tunnel.** Create `~/.cloudflared/config.yml`:

   ```yaml
   tunnel: a-term
   credentials-file: /home/YOUR_USER/.cloudflared/TUNNEL_ID.json

   ingress:
     # Frontend
     - hostname: a-term.your-domain.com
       service: http://localhost:3002

     # Backend API (optional — only needed if frontend and API
     # are on separate subdomains in your setup)
     - hostname: a-term-api.your-domain.com
       service: http://localhost:8002

     # Catch-all (required by cloudflared)
     - service: http_status:404
   ```

5. **Create DNS records:**

   ```bash
   cloudflared tunnel route dns a-term a-term.your-domain.com
   cloudflared tunnel route dns a-term a-term-api.your-domain.com
   ```

6. **Start the tunnel:**

   ```bash
   cloudflared tunnel run a-term
   ```

7. **Access A-Term** at `https://a-term.your-domain.com`.

### Run as a service

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

### Add access control (recommended)

Since A-Term provides shell access, you should add authentication via [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/):

1. Go to **Cloudflare Zero Trust** dashboard → **Access** → **Applications**
2. Add a self-hosted application for `a-term.your-domain.com`
3. Create a policy (e.g., allow only your email via one-time PIN)

This adds an authentication layer before anyone can reach A-Term.

---

## Caddy Reverse Proxy

[Caddy](https://caddyserver.com) is a web server that automatically provisions HTTPS certificates. Useful for LAN access with HTTPS (required by some browser APIs) or as a reverse proxy in front of A-Term.

### Setup

1. **Install Caddy:**

   ```bash
   # Debian/Ubuntu
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install caddy

   # macOS
   brew install caddy
   ```

2. **Create a Caddyfile.** Where you place it depends on your setup — `/etc/caddy/Caddyfile` for system-wide, or any directory for local use.

### Option A: LAN with self-signed HTTPS

For accessing A-Term from other devices on your local network using the host machine's LAN IP:

```caddyfile
# Replace with your machine's LAN IP
https://192.168.1.100:3443 {
    tls internal

    reverse_proxy localhost:3002
}

https://192.168.1.100:8443 {
    tls internal

    reverse_proxy localhost:8002
}
```

```bash
# Trust the Caddy root CA on this machine (for browsers to accept the cert)
sudo caddy trust

# Start
sudo caddy start --config /etc/caddy/Caddyfile
```

Access at `https://192.168.1.100:3443`. Other devices on the network will see a certificate warning unless you install Caddy's root CA on them.

### Option B: Custom domain with automatic HTTPS

If you have a domain pointing to your machine (via DNS, split-horizon DNS, or a local DNS server):

```caddyfile
a-term.your-domain.com {
    reverse_proxy localhost:3002
}

a-term-api.your-domain.com {
    reverse_proxy localhost:8002
}
```

Caddy automatically obtains and renews Let's Encrypt certificates when the domain resolves to the machine.

```bash
sudo caddy start --config /etc/caddy/Caddyfile
```

### Option C: Single domain with path-based routing

```caddyfile
a-term.your-domain.com {
    handle /api/* {
        reverse_proxy localhost:8002
    }

    handle /ws/* {
        reverse_proxy localhost:8002
    }

    handle /health {
        reverse_proxy localhost:8002
    }

    handle {
        reverse_proxy localhost:3002
    }
}
```

### Run as a service

```bash
sudo systemctl enable --now caddy
```

---

## Security Considerations

A-Term gives browser-based access to a shell on the host machine. Keep these points in mind when exposing it beyond localhost:

- **Authentication** — Public deployments should use built-in password auth (`A_TERM_AUTH_MODE=password`) or proxy auth (`A_TERM_AUTH_MODE=proxy`) in front of an identity-aware gateway such as Cloudflare Access.
- **Network scope** — Tailscale limits access to your Tailnet by default. Cloudflare Tunnel with Access policies restricts by identity. Caddy on LAN is only as secure as your network.
- **CORS** — Always set `CORS_ORIGINS` to the specific origins you use. Don't use `["*"]` in production.
- **WebSocket** — All three approaches support WebSocket proxying, which A-Term requires for real-time a-term I/O.
- **tmux sessions** — A-Term sessions are backed by tmux on the host. Anyone with access to A-Term can interact with these sessions.
