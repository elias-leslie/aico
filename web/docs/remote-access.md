# Remote Access

A-Term answers on loopback, plus one public hostname reached through a Cloudflare tunnel. Nothing else works.

## What works

| Where you open it | How it gets there |
|---|---|
| `http://localhost:3002` or `http://127.0.0.1:3002` on the host | Direct |
| `https://<public host>` from anywhere | Cloudflare tunnel to the Next frontend on `localhost:3002` |

Both layers check the `Host` header:

- The Next frontend (`:3002`) answers only `localhost`, `127.0.0.1` and the public host. Anything else gets `403 host_not_allowed`.
- The backend (`:8002`) answers only `localhost`, `127.0.0.1` and `[::1]`. Next's `/api` and `/ws` rewrites reach it with a loopback `Host`, so the browser never talks to `:8002` directly.

## Not supported

The Host guard refuses every other route in, so these no longer work:

- Opening A-Term by LAN IP, Tailscale IP or MagicDNS name (`http://192.168.x.x:3002`, `http://100.x.x.x:3002`, `http://my-machine:3002`).
- A reverse proxy such as Caddy or nginx that forwards its own hostname.
- Any custom domain other than the configured public host.
- Pointing anything at the backend port `:8002` from off the box.

## Cloudflare tunnel

The public host is `hosts.browser_frontend` in `project.identity.json` (`terminal.summitflow.dev` here). The frontend bakes it in at build (`pnpm prepare:branding` writes `lib/generated/project-branding.generated.ts`), so after changing it, regenerate, rebuild and restart both services. The backend adds `https://<public host>` to its allowed origins by default.

Point the tunnel's ingress for that hostname at the frontend:

```yaml
ingress:
  - hostname: terminal.summitflow.dev
    service: http://localhost:3002
  - service: http_status:404
```

Don't route the tunnel to `:8002`, and don't add a second hostname.

A-Term gives a shell on the host. Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) in front of the public host, or turn on built-in auth (`A_TERM_AUTH_MODE=password` or `proxy`).

## Settings that matter

- `A_TERM_BIND_HOST` stays `127.0.0.1`. A-Term refuses to start on a non-loopback bind with `A_TERM_AUTH_MODE=none`.
- `A_TERM_ALLOWED_ORIGINS` (JSON array) is the one origin list for CORS, the terminal WebSocket and writes. The default already covers loopback on `:3002` and the public host. Never use `["*"]`.
