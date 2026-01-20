# Linear Issue Guidelines

Write your Linear issues naturally. The PRD generator is flexible and will work with various formats.

## What Helps PRD Generation

The more context you provide, the better the generated tasks will be:

- **Clear goal** - What should be accomplished?
- **Technologies** - What stack/packages are involved?
- **Success criteria** - How do we know it's done?
- **Key decisions** - Any important constraints or choices?

## Suggested Sections (Optional)

You can use these sections if helpful, but they're not required:

```markdown
## Overview
What this feature does and why it matters.

## Stack (optional)
- Technology 1
- Package name

## Acceptance Criteria (optional)
- [ ] Thing that must work
- [ ] Another requirement

## Decisions (optional)
- **Choice**: Why we're doing it this way
```

## Examples

### Minimal (still works)
```markdown
Add dark mode to the mobile app. Should detect system preference and allow manual toggle. Use MMKV for persistence.
```

### Detailed
```markdown
## Overview
Add dark mode support with system preference detection and manual toggle.

## Stack
- react-native-mmkv
- NativeWind v5

## Acceptance Criteria
- [ ] Detects system color scheme
- [ ] Manual toggle in settings
- [ ] Preference persists
- [ ] All screens support both themes

## Decisions
- **MMKV over AsyncStorage**: Faster sync reads
```

## What Matters Most

1. **Author approval** - The PRD is yours to refine. Generated tasks are a starting point.
2. **Verification** - Generated tasks will include verification steps (typecheck, lint, test).
3. **Flexibility** - Use whatever structure works for your feature.

The PRD generator extracts what it can and fills in reasonable defaults for the rest.
