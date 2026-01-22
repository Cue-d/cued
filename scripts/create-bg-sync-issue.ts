#!/usr/bin/env npx tsx
/**
 * Create the Electron Background Sync Linear issue
 * Run: cd scripts && npx tsx create-bg-sync-issue.ts
 */

import { executeClaudeForJSON } from "./lib/claude.js";

const title = "Electron Background Sync & Always-On Mode";
const description = `## Overview

Enable continuous iMessage sync via system tray, auto-launch on login, and sleep prevention. Users should be able to run PRM as a "set and forget" background app that always captures their messages.

Currently the Electron app:
- Has no tray icon
- Quits when window closes
- Pauses sync when Mac sleeps
- Must be manually launched each time

After this feature:
- Tray icon with quick actions (show/hide, sync now, quit)
- Hide to tray on close (not quit)
- Auto-launch on login (opt-in)
- Prevent sleep during active sync
- Resume sync immediately after wake

## Target Stack

- apps/electron/src/main/
- apps/electron/electron-builder.yml

## Acceptance Criteria

- [ ] System tray icon appears with PRM branding
- [ ] Context menu: Show PRM, Sync Now, Preferences, Quit
- [ ] Clicking tray icon toggles window visibility (macOS)
- [ ] Closing window hides to tray instead of quitting
- [ ] "Quit" menu item fully exits the app
- [ ] Sleep prevention during active sync batches
- [ ] Immediate sync triggered on wake from sleep
- [ ] Settings toggle for "Launch at login"
- [ ] Settings toggle for "Keep Mac awake while syncing"
- [ ] Hidden startup mode (--hidden flag, starts minimized)
- [ ] Tray tooltip shows sync status (idle/syncing/error)

## Key Decisions

- **Tray icon**: System tray with context menu (show/hide, sync now, quit)
- **Dock visibility**: Hide from dock when minimized to tray, show when window open
- **Sleep prevention**: Use powerSaveBlocker during active sync, allow sleep between syncs
- **Auto-launch**: Opt-in via settings, launches hidden to tray

## References

- [Electron Tray API](https://www.electronjs.org/docs/latest/api/tray)
- [Electron powerSaveBlocker API](https://www.electronjs.org/docs/latest/api/power-save-blocker)
- [Electron powerMonitor API](https://www.electronjs.org/docs/latest/api/power-monitor)
- [Electron setLoginItemSettings](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows)`;

const prompt = `Using the Linear MCP, create a new issue in the PRM team with:
- Title: ${JSON.stringify(title)}
- Description: ${JSON.stringify(description)}

Return ONLY JSON (no markdown): {"identifier": "PRM-XXX", "id": "the-uuid"}`;

const result = executeClaudeForJSON<{ identifier: string; id: string }>(prompt, {
  timeout: 60000,
});

if (result.success && result.data) {
  console.log(JSON.stringify(result.data));
} else {
  console.error("Failed:", result.error);
  process.exit(1);
}
