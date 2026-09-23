# dsh-remote

Enable remote network access for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh web`) by binding the webserver to `0.0.0.0` instead of local loopback (`127.0.0.1`).

## Install

Run this one-liner to install the overlay patch into your `dsh` web profile:

```sh
node -e '
const fs = require("fs"), path = require("path");
const p = path.join(process.env.HOME, ".dsh/profiles/web/cordis.patch.yml");
fs.mkdirSync(path.dirname(p), { recursive: true });
let c = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
const patch = "- id: webserver\n  config:\n    host: '\''0.0.0.0'\''\n    port: !!js ctx.webStartup.port ?? 3080\n    compression: gzip\n    compressionLevel: 1\n    compressionThresholdBytes: 1024\n";
if (!c.includes("id: webserver")) {
  c = c.replace(/^\[\]\s*$/m, "");
  c = (c.trim() ? c.trim() + "\n" : "") + patch;
  fs.writeFileSync(p, c);
}
'
```

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
| `cordis.patch.yml` | Cordis loader patch overlay configuring `@deepseek-ai/dsh-host-webserver` with `host: 0.0.0.0` |
| `selfcheck.ts` | Verification test for the patch definition |

## Verification

To verify that the patch applies cleanly:
```sh
node --experimental-strip-types selfcheck.ts
dsh web --dump-config | grep -A 8 "id: webserver"
```
