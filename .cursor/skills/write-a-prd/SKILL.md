---
name: write-a-prd
description: Use this skill when writing a PRD for a feature. Guides through problem discovery, solution design, and GitHub issue creation.
---

This skill guides you through creating a Product Requirements Document (PRD) for a feature. Go through the steps below. Skip steps if not necessary.

## Process

### 1. Gather Requirements
Ask the user for a long, detailed description of the problem they want to solve and any potential ideas for solutions.

### 2. Verify Context
Explore the repo to verify their assertions and understand the current state of the codebase.

### 3. Explore Alternatives
Ask whether they have considered other options, and present other options to them.

### 4. Technical Interview
Interview the user about the implementation. Be extremely detailed and thorough.

### 5. Define Scope
Hammer out the exact scope of the implementation:
- What you plan to build
- What you DON'T plan to build as part of this PRD

### 6. Module Planning
Sketch out the major modules you will need to build or modify.

Actively look for opportunities to extract **deep modules** that can be tested in isolation. A deep module (as opposed to a shallow module) is one which encapsulates a lot of functionality in a simple, testable interface which rarely changes.

Check with the user:
- Do these modules match their expectations?
- Which modules should have tests?

### 7. Write and Submit PRD
Once you have a complete understanding, write the PRD using the template below.

Submit as a GitHub issue:
```bash
gh issue create --title "PRD: <Feature Name>" --body "<PRD content>"
```

---

## PRD Template

```markdown
## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As a <actor>, I want <feature>, so that <benefit>

This list should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

**Do NOT include specific file paths or code snippets.** They may end up being outdated very quickly.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.
```
