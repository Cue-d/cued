# Scripts

Utility scripts for one-off data sync/testing workflows.

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

## Twitter Commands

```bash
pnpm twitter:save-cookies
pnpm twitter:scrape-contacts
pnpm twitter:sync-contacts
pnpm twitter:test-messages
pnpm twitter:trigger-actions
```
