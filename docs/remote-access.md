# Remote Access

The web app answers on loopback, plus one public hostname reached through a Cloudflare tunnel. Nothing else works.

## What works

| Where you open it | How it gets there |
|---|---|
| `http://localhost:3002` or `http://127.0.0.1:3002` on the host | Direct |
| `https://<public host>` from anywhere | Cloudflare tunnel to `aico-web` on `localhost:3002` |

One server, `aico-web` on `127.0.0.1:3002`, serves the page, `/api`, `/ws` and `/health`. It checks every request's `Host` header and answers only `localhost`, `127.0.0.1` and the public host; anything else gets `403`. Writes and terminal sockets must also carry an `Origin` the server trusts.

## Not supported

The Host guard refuses every other route in, so these do not work:

- Opening the web app by LAN IP, Tailscale IP or MagicDNS name (`http://192.168.x.x:3002`, `http://100.x.x.x:3002`, `http://my-machine:3002`).
- A reverse proxy such as Caddy or nginx that forwards its own hostname.
- Any custom domain other than the configured public host.

## Cloudflare tunnel

The public host is `hosts.browser_frontend` in `project.identity.json` (`aico.summitflow.dev` here). The page bakes it in at build (`npm run build` regenerates `web/frontend/lib/generated/project-branding.generated.ts`) and the server reads it at start, so after changing it, rebuild and restart `aico-web`. The server adds `https://<public host>` to its trusted origins by default.

Point the tunnel's ingress for that hostname at the server:

```yaml
ingress:
  - hostname: aico.summitflow.dev
    service: http://localhost:3002
  - service: http_status:404
```

Don't add a second hostname.

The web app gives a shell on the host and has no login of its own. Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) (or another identity-aware gateway) in front of the public host. The manifest is fetched with credentials, so an installed app keeps working behind Access.

## Settings that matter

- The server binds loopback only (`AICO_WEB_HOST`, default `127.0.0.1`) and refuses to start on any other address.
- `AICO_WEB_ALLOWED_ORIGINS` (comma-separated) replaces the trusted origin list for the terminal WebSocket and writes. The default already covers loopback on `:3002` and the public host.
