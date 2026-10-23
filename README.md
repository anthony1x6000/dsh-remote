# dsh-remote

[![ci](https://github.com/anthony1x6000/dsh-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/anthony1x6000/dsh-remote/actions/workflows/ci.yml)

Enable remote network access for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh web`) by binding the webserver to `0.0.0.0` instead of local loopback (`127.0.0.1`).

## Install

Install the bundle into your `web` profile (pnpm only — no profile hand-editing). It must be a profile whose bundles include the `webserver` row (i.e. `web`): on a base-only profile the install fails loud with `entry "webserver" not found`.

```sh
dsh plugin --profile web add "github:anthony1x6000/dsh-remote#main"
```

Verify the layer without booting:

```sh
dsh --profile web --dump-config | grep -B 1 -A 4 webserver
```

Then restart `dsh web` for the new bundle layer to take effect (bundle installs need a restart; repository plugins don't).

To uninstall: `dsh plugin --profile web remove dsh-remote` (then restart). Note `remove` prunes the bundle layer but never touches your own patch file.

Then start the web interface:

```sh
dsh web
```

`dsh web` will automatically bind to `0.0.0.0:3080`, discover your non-internal IPv4 LAN addresses, and print the LAN access URL (including the authenticated session token):
```
dsh web: http://127.0.0.1:3080?token=... (LAN: http://192.168.x.x:3080?token=...)
```

## Remote Model and API-Key Editing

DSH keeps its settings and credential surfaces loopback-only: a served page off loopback marks itself non-privileged, creates the settings mirror in memory mode, and never reads or writes the Host document. That is why a plain `0.0.0.0` bind gives remote browsers chat and sessions but leaves the Models page read-only and the API-key forms disabled.

This bundle closes that gap on an all-interfaces bind by injecting the same transport global the desktop shell uses (`__DSH_TRANSPORT__ = { ownsHost: true }`) into the served page. A LAN browser then edits models, providers, and API keys exactly as the host machine's browser does. A loopback bind is untouched, so the local GUI keeps DSH's own boundary.

Admission is unchanged: the `/api` Host fence still refuses authorities it was not told about, and the launch token plus signed session cookie still authenticate every browser. Anyone holding a working remote URL is therefore an operator who can repoint providers and overwrite keys — treat the printed LAN URL as a root credential. Credential **reads** stay redacted, so stored key values never cross the wire.

## Temporary / Ad-hoc Usage

If you prefer not to modify `~/.dsh/profiles/web/cordis.patch.yml`, you can boot with the `--patch` flag directly:

```sh
dsh web --patch <path-to>/cordis.patch.yml
```

## Files

| File | Description |
|---|---|
| `package.json` | Bundle manifest (`dsh.bundle.patch`) and the plugin entry point |
| `cordis.patch.yml` | Bundle layer: the `webserver` bind override plus the `remote-operator` host row |
| `lib/index.js` | Host plugin: injects the operator transport global on an all-interfaces bind |
| `selfcheck.ts` | Verification test for the manifest, patch, and injection behavior |

## Verification

To verify that the patch applies cleanly:
```sh
node --experimental-strip-types selfcheck.ts
dsh web --dump-config | grep -A 8 "id: webserver"
```
