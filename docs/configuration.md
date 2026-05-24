# Configuration

Cued should run without local environment setup. A normal install gets its paths
from the app bundle, stores data under `~/.cued`, stores integration secrets in
Keychain, and uses source defaults for daemon behavior.

## What `.env.example` Is

Node entrypoints load repo-root `.env` files through dotenv before reading Cued
configuration. `.env.example` is still a credential reference, not a general app
configuration registry.

Keep `.env.example` limited to values that are secret-bearing or point at
secret-bearing credential files:

- `CUED_DB_KEY`, only for bypassing the normal Keychain database key path.
- Gmail OAuth client JSON paths, because those files contain `client_secret`.
- release signing/notary credential handles used by packaging.

Do not add daemon scheduling knobs, worker cursors, fixture flags, helper binary
paths, release metadata, or benchmark controls to `.env.example`.

## Runtime Configuration Owners

The runtime has a few existing configuration owners. Reuse these before adding a
new environment variable.

| Need | Owner |
| --- | --- |
| Normal app paths | `src/core/config.ts` plus the app bundle launcher |
| Local data directory | `src/core/config.ts`; isolated runs pass `--config path/to/config.json` |
| Database encryption | Keychain by default, `CUED_DB_KEY` only as an override |
| Daemon scheduling and projection defaults | `src/core/config.ts` |
| Platform sync limits | `src/core/config.ts` |
| Integration credentials and tokens | Keychain |
| User hooks | `~/.cued/hooks.toml` |
| Packaged app runtime path overrides | `~/.cued/config.json` |
| Packaged app credential env overrides | `~/.cued/daemon.env` |
| Worker cursors and sync proofs | structured stdin invocation from the parent daemon |
| Build, release, smoke, and benchmark settings | the script that consumes them |

## Runtime `config.json`

The default runtime data directory is `~/.cued`. For isolated local runs, write
a small JSON config and pass it as a CLI argument:

```json
{
  "home": "/tmp/cued-home",
  "dbPath": "/tmp/cued-home/local.db"
}
```

```bash
pnpm exec tsx src/cli.ts --config /tmp/cued-home/config.json status
```

The macOS host also reads this config shape and forwards the same config path
when it launches the bundled daemon.

## `~/.cued/daemon.env`

The macOS host reads `~/.cued/daemon.env` before launching the daemon. This file
is the packaged app override path for rare secret-bearing values that must enter
the daemon process environment. It accepts `KEY=value` lines for the explicit
credential allowlist in `RuntimeSupport.swift`.

Use it sparingly. It is appropriate for a local credential path or temporary
launch override that cannot live in the database or Keychain. It is not a
replacement for a checked-in defaults file.

Example:

```sh
CUED_GOOGLE_OAUTH_CLIENT_FILE=/Users/me/.cued/google-oauth-client.json
```

## Adding New Configuration

Before adding a new env var, answer these in order:

1. Can the value just be a source default in the current owner?
2. If it is a user-facing preference, should it be an app setting or CLI command
   instead of a launch-time env var?
3. If it is a secret, can it live in Keychain rather than env?
4. If it is worker IPC, can the parent daemon inject it without documenting it
   as user configuration?
5. If it is script-only, can it be documented next to that script instead of in
   `.env.example`?

For local development, prefer editing `src/core/config.ts`, using `--config` for
isolated runtime paths, or using a targeted script invocation. Environment
variables are still useful for secrets and credential file paths, but they
should not become the public configuration surface for every tweakable constant.
