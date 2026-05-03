## Summary

-

## Validation

- [ ] `pnpm check:biome`
- [ ] `pnpm build`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `swift build --package-path native/macos/CuedNative -c release` if native macOS code changed
- [ ] `pnpm build:app:macos` if packaging, permissions, bundled runtime, or app resources changed

## Data, Auth, And Privacy

- [ ] No real local databases, message exports, browser profiles, logs with private content, tokens, cookies, or OAuth secrets included
- [ ] Integration credential changes are documented
- [ ] Migration/local data effects are documented
