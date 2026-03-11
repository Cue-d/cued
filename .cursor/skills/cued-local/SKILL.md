---
name: cued-local
description: Use this skill when a task requires inspecting Cued's local SQLite database for contacts, conversations, duplicate contacts, or message history. Prefer direct SQL via sqlite3 with JSON output. Use web search only after local evidence identifies a likely person and the task asks who they are.
---

Read `~/.cued/local.db` with `sqlite3 -json` and use the same query strategy as the Claude skill at `.claude/skills/cued-local/SKILL.md`.
