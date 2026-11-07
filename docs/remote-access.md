# Remote Access

The web app answers on loopback, plus public hostnames reached through Aico's own Cloudflare tunnel, which has a connector on each machine that runs Aico. Nothing else works.

## What works

| Where you open it | How it gets there |
|---|---|
| `http://localhost:3002` or `http://127.0.0.1:3002` on the host | Direct |
| `https://<public host>` from anywhere | Cloudflare tunnel to `aico-web` on `localhost:3002` of whichever machine's connector Cloudflare picks |

One server, `aico-web` on `127.0.0.1:3002`, serves the page, `/api`, `/ws` and `/health`. It checks every request's `Host` header and answers only `localhost`, `127.0.0.1` and the public host; anything else gets `403`. Writes and terminal sockets must also carry an `Origin` the server trusts.

## Not supported

The Host guard refuses every other route in, so these do not work:

- Opening the web app by LAN IP, Tailscale IP or MagicDNS name (`http://192.168.x.x:3002`, `http://100.x.x.x:3002`, `http://my-machine:3002`).
- A reverse proxy such as Caddy or nginx that forwards its own hostname.
- Any custom domain other than the configured public host.

## Cloudflare tunnel

The public host is `hosts.browser_frontend` in `project.identity.json` (`aico.summitflow.dev` here). The page bakes it in at build (`npm run build` regenerates `packages/web-frontend/lib/generated/project-branding.generated.ts`) and the server reads it at start, so after changing it, rebuild and restart `aico-web`. The server adds `https://<public host>` to its trusted origins by default.

Point the tunnel's ingress for that hostname at the server:

```yaml
ingress:
  - hostname: aico.summitflow.dev
    service: http://localhost:3002
  - service: http_status:404
```

A second hostname is fine when it has its own ingress rule the same way and its own Cloudflare Access application. The phone app uses `app.summitflow.dev` (`AICO_PHONE_HOSTS`); the server accepts that host for the phone API only, not the full page. Any other hostname still gets `403` from the Host guard.

### Two connectors, one tunnel

Aico has its own remote-managed tunnel, separate from the workstation's main tunnel, and runs the same tunnel on every machine that serves Aico: `cloudflared-aico.service` on the workstation and on the gem container (CT 190), both started from the same token file (`/etc/cloudflared/aico-token`, root-only, never in the repo). Cloudflare spreads requests across the live connectors and drops a dead one, so either machine alone keeps the public host answering. Each machine serves its own synced copy of the data and the same build.

To add a machine, run another connector of this tunnel with the same token. Do not build a replica of the main tunnel on it: a hostname's DNS points at one tunnel, so the second machine has to join that tunnel, not carry a copy of its config.

The web app gives a shell on the host and has no login of its own. Put [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) (or another identity-aware gateway) in front of the public host. The manifest is fetched with credentials, so an installed app keeps working behind Access.

## Settings that matter

- The server binds loopback only (`AICO_WEB_HOST`, default `127.0.0.1`) and refuses to start on any other address.
- `AICO_WEB_ALLOWED_ORIGINS` (comma-separated) replaces the trusted origin list for the terminal WebSocket and writes. The default already covers loopback on `:3002` and the public host.
