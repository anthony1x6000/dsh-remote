# dsh-remote

[![ci](https://github.com/anthony1x6000/dsh-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/anthony1x6000/dsh-remote/actions/workflows/ci.yml)

Serve [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh web`) over [Tailscale](https://tailscale.com), so your tailnet can reach the GUI — with model and API-key editing intact.

## Install

Install the bundle into your `web` profile (pnpm only — no profile hand-editing). It must be a profile whose bundles include the `connection` and `webserver` rows (i.e. `web`): on a base-only profile the install fails loud.

```sh
dsh plugin --profile web add "github:anthony1x6000/dsh-remote#main"
```

Verify the layer without booting:

```sh
dsh --profile web --dump-config | grep -A 2 'id: connection'
```

Then restart `dsh web` for the new bundle layer to take effect (bundle installs need a restart; repository plugins don't).

To uninstall: `dsh plugin --profile web remove dsh-remote` (then restart). Note `remove` prunes the bundle layer but never touches your own patch file.

Bring Tailscale up **before** starting the server: the plugin samples the interfaces once at boot. Then:

```sh
dsh web
```

DSH still binds its loopback listener, and the bundle prints a tokenized tailnet URL for each Tailscale address:

```
dsh web: http://127.0.0.1:3080?token=...
dsh-remote: http://100.x.y.z:3080?token=...
```

Open the `dsh-remote` line from any tailnet device.

## How It Works

DSH binds one concrete address and **rejects wildcard listens**: `0.0.0.0` is a refused configuration, not an oversight. So this bundle does not rewrite the `webserver` row. It forwards each Tailscale IPv4 address at the same port to DSH's loopback listener over raw TCP — HTTP, WebSocket upgrades, and TLS pass through unchanged, and the local GUI keeps working on `127.0.0.1`.

Two obligations follow from that:

- **Fence authorities** — the `/api` Host fence accepts the webserver's own bind address only, so each forwarded address is added to Connection's `trustedHosts`. Without it every tailnet API call would answer 403.
- **Operator transport** — DSH keeps its settings and credential surfaces loopback-only: a page off loopback marks itself non-privileged, creates the settings mirror in memory mode, and never touches the Host document. A tailnet browser would therefore see read-only models and disabled API-key forms. The bundle injects the same transport global the desktop shell uses (`__DSH_TRANSPORT__ = { ownsHost: true }`), which restores host-persisted settings and credential writes.

## Security

Admission is unchanged: the launch token and signed session cookie still authenticate every browser, and credential **reads** stay redacted, so stored key values never cross the wire. But a tailnet browser is treated as the operator: anyone holding a working URL can repoint providers and overwrite keys. Treat the printed `dsh-remote` URL as a root credential and keep the tailnet ACL for port 3080 restricted.

The forwarder relays to loopback, so DSH sees every connection as coming from the local machine; per-client source addresses are not preserved.

## Temporary / Ad-hoc Usage

If you prefer not to modify `~/.dsh/profiles/web/cordis.patch.yml`, you can boot with the `--patch` flag directly:

```sh
dsh web --patch <path-to>/cordis.patch.yml
```

## Files

| File | Description |
|---|---|
| `package.json` | Bundle manifest (`dsh.bundle.patch`) and the plugin entry point |
| `cordis.patch.yml` | Bundle layer: the `connection` trust authorities plus the `remote-operator` host row |
| `lib/index.js` | Host plugin: tailnet TCP forwarders, fence authorities, operator transport global |
| `selfcheck.ts` | Verification test for the manifest, patch, injection table, and forwarder relay |

## Verification

```sh
node --experimental-strip-types selfcheck.ts
ss -tlnp | grep 3080        # one loopback listener by DSH, one per tailnet address
```

## Troubleshooting

- **No `dsh-remote:` URL printed** — the interface scan found no Tailscale IPv4. Confirm `tailscale up` and `ip -4 addr show tailscale0`, then restart `dsh web`.
- **Tailnet requests answer 403** — something replaced the `connection` row's `trustedHosts` in a later profile layer; it must keep spreading `ctx.remoteBind.authorities`.
- **Port already in use on the tailnet address** — another process owns that address/port; the plugin logs the failed authority and keeps serving the rest.
