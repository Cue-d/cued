// Must run before React to mock window.electron in browser
import "./browser-mock";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RootErrorBoundary } from "./components/RootErrorBoundary";
import { closeConvexClientSingleton } from "./lib/convex-client-singleton";
import "./globals.css";

function toJSON(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function installGlobalErrorLogging(): void {
  window.addEventListener("error", (event) => {
    console.error(`[RendererBoot] Uncaught error ${toJSON({
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    })}`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason instanceof Error
      ? { message: event.reason.message, stack: event.reason.stack }
      : event.reason;
    console.error(`[RendererBoot] Unhandled promise rejection ${toJSON(reason)}`);
  });
}

function installLifecycleHooks(): void {
  window.addEventListener("beforeunload", () => {
    closeConvexClientSingleton();
  });
}

function bootRenderer(): void {
  if (import.meta.env.DEV) {
    installGlobalErrorLogging();
  }
  installLifecycleHooks();

  const rootElement = document.getElementById("root");
  if (import.meta.env.DEV) {
    console.log(`[RendererBoot] Starting ${toJSON({
      href: window.location.href,
      readyState: document.readyState,
      hasRoot: Boolean(rootElement),
      hasElectron: Boolean((window as { electron?: unknown }).electron),
    })}`);
  }

  if (!rootElement) {
    throw new Error("Renderer root element (#root) not found");
  }

  createRoot(rootElement).render(
    <StrictMode>
      <RootErrorBoundary>
        <App />
      </RootErrorBoundary>
    </StrictMode>
  );

  if (import.meta.env.DEV) {
    console.log("[RendererBoot] React render invoked");
  }
}

bootRenderer();
