# Cued Mobile App

Expo React Native app for iOS and Android.

## Prerequisites

### Watchman (required for hot reload)

Watchman is required for fast hot reload during development.

```bash
brew install watchman
```

Verify installation:

```bash
watchman --version
```

If hot reload isn't working, try:

```bash
watchman watch-del-all
watchman shutdown-server
```

## Development

```bash
pnpm install
pnpm dev
```

## Building

```bash
pnpm ios     # Run on iOS simulator
pnpm android # Run on Android emulator
```
