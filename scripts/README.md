# Ralph PRD CLI

Minimal CLI for viewing GitHub issues. The actual execution is handled by `ralph-once.sh` and `afk-ralph.sh`.

## How It Works

```
GitHub Issues → ralph-once.sh → Claude → Commit
      ↑                                    │
      └─── /write-a-prd skill ←────────────┘
```

1. **Create PRDs**: Use `/write-a-prd` skill to create detailed PRDs as GitHub issues
2. **Execute**: Ralph scripts fetch issues and pass them to Claude
3. **Complete**: Claude implements, commits, and closes issues

## Commands

### View Issues

```bash
pnpm prd list              # List open GitHub issues
pnpm prd view 123          # View issue #123
```

### Execute (from repo root)

```bash
./ralph-once.sh                    # Single iteration (HITL)
./ralph-once.sh --issue 123        # Target specific issue
./ralph-once.sh --port 3001        # Custom dev server port
./ralph-once.sh --sandbox          # Run in Docker sandbox

./afk-ralph.sh 10                  # 10 iterations (AFK)
./afk-ralph.sh 10 --issue 123      # Target specific issue
```

## Creating PRDs

Use the `/write-a-prd` skill in Claude Code:

```
/write-a-prd
```

This guides you through:
1. Problem discovery
2. Solution design
3. Technical interview
4. Scope definition
5. Module planning
6. GitHub issue creation

PRDs are created as GitHub issues with the "PRD:" prefix.

## Key Files

| File | Purpose |
|------|---------|
| `prds/prompt.md` | Instructions for Claude during execution |
| `progress.txt` | Log of completed work |
| `.claude/skills/write-a-prd/SKILL.md` | PRD creation skill |

---

Last updated: 2026-01-27
