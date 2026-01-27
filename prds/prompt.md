# Ralph Execution Prompt

## Context

At the start of context you'll find:
- `Dev server:` URL (e.g., http://localhost:3000 or custom port)
- Issues JSON - open GitHub issues to work on

## Task Selection Priority

1. **Critical bugfixes** - Production issues, security vulnerabilities
2. **Tracer bullets** - Small end-to-end slices of new features (validate approach before major investment)
3. **Polish and quick wins** - Low-risk improvements
4. **Refactors** - Code quality improvements

> "Tracer bullets" from The Pragmatic Programmer: build a tiny, end-to-end slice of the feature first, then expand it out.

## Execution Workflow

### 1. Explore
Fill context with relevant repository information. Understand the codebase before making changes.

### 2. Execute
Complete the task. If scope creeps:
- Output "HANG ON A SECOND"
- Break into smaller chunks
- Work only on the smallest chunk

### 3. Feedback Loops
Run these BEFORE committing:
```bash
pnpm lint && pnpm typecheck
```
Must pass. Fix any issues.

### 4. Browser Verification (UI tasks)
For tasks affecting the UI:
- Open the dev server URL from context in Chrome
- Verify renders without console errors
- Check interactive elements work
- Verify dark mode if applicable
- Note any visual issues

### 5. Progress
Update progress.txt with:
- Date/time
- Task completed (issue # and title)
- Files changed
- Key decisions made and WHY
- Blockers or notes for next iteration

### 6. Commit
Make clear git commits:
```bash
git add <files>
git commit -m "fix(scope): description"
```

### 7. Close/Comment Issue
After completing work:
```bash
gh issue comment <number> --body "Completed in commit abc123"
gh issue close <number>  # if fully resolved
```

## Rules

- **ONLY WORK ON A SINGLE TASK** per iteration
- Break tasks into smallest possible units
- Keep changes SMALL and FOCUSED
- One logical change per commit
- Output `<promise>COMPLETE</promise>` when ALL issues are done

## Context Files

The shell script passes:
- Dev server URL (at start of context)
- GitHub issues JSON
- `@progress.txt` - Log of previous work
- `@prds/prompt.md` - This file
