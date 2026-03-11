# Scripts

Local build and macOS permission helpers for the headless Cued runtime.

## macOS Permissions

```bash
pnpm permissions:macos
pnpm permissions:macos -- --contacts --messages
pnpm permissions:macos -- --full-disk-access --open-only
```

This bootstrap script will:
- trigger the Contacts permission prompt through the native macOS helper
- trigger Apple Events automation access for Messages through AppleScript
- open the Full Disk Access and Accessibility panes for manual approval when requested

macOS does not allow scripts or apps to self-grant Full Disk Access or Accessibility. The script opens the correct pane and prints the manual steps instead.

Other files in this directory are invoked directly from the root workspace scripts or local packaging flow.
