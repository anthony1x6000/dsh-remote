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

## Temporary / Ad-hoc Usage

If you prefer not to modify `~/.dsh/profiles/web/cordis.patch.yml`, you can boot with the `--patch` flag directly:

```sh
dsh web --patch <path-to>/cordis.patch.yml
```

## Files

| File | Description |
|---|---|
| `package.json` | Bundle manifest (`dsh.bundle.patch`); no code, no dependencies |
| `cordis.patch.yml` | Bundle layer: `@deepseek-ai/dsh-host-webserver` row with `host: 0.0.0.0` |
| `selfcheck.ts` | Verification test for the manifest and patch definition |

## Verification

To verify that the patch applies cleanly:
```sh
node --experimental-strip-types selfcheck.ts
dsh web --dump-config | grep -A 8 "id: webserver"
```
