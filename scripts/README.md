# PRD CLI & Linear Integration

Automated pipeline for converting Linear issues to executable PRDs.

## Setup

### 1. Install Linear MCP Server

Each teammate needs to authenticate once:

```bash
claude mcp add-json linear '{"command": "npx", "args": ["-y","mcp-remote","https://mcp.linear.app/sse"]}'
```

Then run `/mcp` in Claude Code to complete OAuth.

### 2. Install Dependencies

```bash
cd scripts
pnpm install
```

### 3. Prerequisites

- Claude Code CLI installed and authenticated
- Linear MCP server configured (step 1)

No API keys needed - uses Claude Code CLI for AI and Linear MCP for issue tracking.

## Usage

### Pull Linear Issue → Generate PRD

```bash
pnpm prd pull PRM-123
```

Creates `prds/prm-123-prd.json` with tasks extracted from the issue.

### Execute PRD Tasks

```bash
# Standard execution (respects hitl/afk mode)
pnpm prd run prds/prm-123-prd.json

# Interactive mode (step-by-step confirmation)
pnpm prd run prds/prm-123-prd.json --interactive
```

### Sync Progress to Linear

```bash
pnpm prd sync prds/prm-123-prd.json
```

Syncs progress to Linear in multiple ways:
1. **Progress Document** - Full progress log as a Linear Document
2. **Issue Description** - Collapsible progress section appended to issue
3. **Status Update** - Auto-updates issue status based on completion %
4. **Progress Comment** - Adds comment with recent activity

The issue description gets a collapsible "🤖 AI Progress Log" section with:
- Progress bar and completion percentage
- Link to full progress document
- Recent activity (last 5 tasks) in expandable section
- Task checklist in expandable section

**Options:**
```bash
pnpm prd sync prds/prm-123-prd.json --no-description  # Skip issue description update
pnpm prd sync prds/prm-123-prd.json --no-document     # Skip progress document
pnpm prd sync prds/prm-123-prd.json --no-comment      # Skip progress comment
pnpm prd sync prds/prm-123-prd.json --no-status       # Skip status update
```

### Link PR to Linear Issue

```bash
pnpm prd link-pr PRM-123 https://github.com/org/repo/pull/456
pnpm prd link-pr PRM-123 https://github.com/org/repo/pull/456 --title "feat: Add dark mode"
```

Attaches PR URL as metadata to the Linear issue.

### Check Status

```bash
pnpm prd status prds/prm-123-prd.json
```

## Templates

- **Linear Issue Template:** `templates/linear-issue.md`
- **PRD JSON Schema:** `templates/prd-schema.json`

## Linear Workflow (Claude Code)

When working on a feature in Claude Code:

1. **Reference the issue** - "Work on PRM-123"
2. **Claude fetches context** - Pulls issue details, acceptance criteria
3. **Progress updates** - Updates status and adds comments
4. **Link PRs** - Associates commits/PRs with the issue

### Example Commands

```
"What's assigned to me in the current sprint?"
"Start working on PRM-123"
"Update PRM-123 to In Progress"
"Add comment to PRM-123: Implemented auth flow, testing remaining"
"Mark PRM-123 as Done"
```

### Best Practices

- Always reference issue IDs when working on tracked features
- Update status when starting/completing work
- Add comments for decisions, blockers, or notable progress
- Create sub-issues for complex features

### Branch Naming

Use Linear issue IDs: `theotarr/prm-123-dark-mode`

## AI Agent Automation

AI agents (Claude Code, etc.) should automatically trigger PRD generation when users reference Linear issues.

### Auto-Trigger Conditions

Run `pnpm prd pull <issue-id>` when user says:
- "Work on PRM-123" / "Start PRM-123"
- "Create PRD for PRM-123"
- "Implement PRM-123"
- Any request referencing a Linear issue that needs planning

### Automated Workflow

```
1. mcp__linear__get_issue → Fetch issue details
2. cd scripts && pnpm prd pull PRM-123 → Generate PRD
3. mcp__linear__update_issue → Set status to "In Progress"
4. git checkout -b theotarr/prm-123-feature-name → Create branch
5. Execute tasks from PRD JSON
6. cd scripts && pnpm prd sync prds/prm-123-prd.json → Update Linear
7. Create PR with gh pr create
8. cd scripts && pnpm prd link-pr PRM-123 <pr-url> → Link PR to Linear
```

### Auto-Link PRs

After creating a PR, automatically link it to the Linear issue:
```bash
# Get PR URL from gh pr create output, then:
pnpm prd link-pr PRM-123 https://github.com/org/repo/pull/456
```

AI agents should run this automatically after `gh pr create` succeeds.

### PRD JSON Structure

Generated PRDs (`prds/<issue-id>-prd.json`) contain:
- `issueId`: Linear issue identifier
- `title`: Feature title
- `tasks`: Array of executable tasks with status tracking
- `acceptanceCriteria`: From Linear issue

Agents should read and execute tasks sequentially, updating status as they go.
