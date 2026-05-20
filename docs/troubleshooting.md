# Troubleshooting

This page covers practical recovery steps for local setup issues that need more detail than the install checklist.

## WhatsApp QR or login hangs

WhatsApp linking can currently hang after the QR code is shown or scanned. The failure has been seen across WhatsApp device-linking surfaces, so treat it as a known WhatsApp helper/auth issue rather than a user-specific setup mistake. The deeper product fix is deferred; for now, collect diagnostics, clear stale state, and retry from a clean helper session.

### What to collect

Before resetting anything, capture enough state to compare the helper, app bundle, and daemon:

```bash
cued status
cued doctor
cued integrations status
cued logs
```

Also record:

- installed app path: `/Applications/Cued.app` or `~/Applications/Cued.app`
- Cued version from the app or `cued status`
- WhatsApp helper path and helper version from `cued doctor`
- whether the QR code appeared, scanned, or stayed pending
- any recent lines in `~/.cued/logs/daemon.log` mentioning `whatsapp`, `qr`, `pair`, `helper`, or `accountJid`

Do not treat a transient QR scan as a successful connection. WhatsApp should only be considered connected when the helper reports durable account state, including a non-empty `accountJid`, and `cued integrations status` shows the integration as sync-capable.

### Recovery steps

Try these in order:

1. Quit and reopen `Cued.app`, then retry WhatsApp linking.
2. Stop any stuck helper process from Activity Monitor or with `pkill cued-whatsapp-helper`, then retry.
3. Remove the stale WhatsApp integration from the app UI if available, or from the CLI:

```bash
cued integrations remove whatsapp default
cued integrations connect whatsapp default
```

4. Restart the daemon/app and verify status again:

```bash
cued status
cued integrations status
```

5. If developing from source, rebuild the helper and retry with the source CLI:

```bash
GOWORK=off go build -C native/helpers/whatsapp-go -o .build/cued-whatsapp-helper
pnpm dev -- integrations connect whatsapp default
```

6. If the packaged app may have an old helper, rebuild and reinstall the app bundle:

```bash
pnpm build:app:macos
pnpm dev -- install
```

After any reset, rerun `cued doctor` and `cued integrations status` so the next report includes both recovery actions and current helper state.

### Development notes

For source builds, Cued discovers the development helper at `native/helpers/whatsapp-go/.build/cued-whatsapp-helper` unless `CUED_WHATSAPP_HELPER_BINARY` points somewhere else. If a hang only reproduces in the packaged app, compare the helper path and version from `cued doctor` against the source helper you just built.

When filing a follow-up issue or PR, include the commands above, the helper version/path, and whether the status ever reached an `accountJid`. Keep logs limited to status/error lines and avoid sharing message content.
