import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CuedDatabase } from "../db/database.js";
import type { AuthSessionState, Platform } from "../types/provider.js";
import { resolveMacOSNativeBinary } from "../workers/native-binary.js";
import type { AuthSessionSummary, IntegrationStateSummary } from "./service.js";
import {
  getSignalConfigDir,
  inspectSignalCli,
  isSignalCliVersionSupported,
  readSignalLinkedAccount,
  startSignalLinkSession,
} from "./signal-cli.js";
import {
  getWhatsAppStoreDir,
  inspectWhatsAppHelper,
  readWhatsAppHelperStatus,
  startWhatsAppPairSession,
} from "./whatsapp-helper.js";

export interface QrNativeAuthResult {
  sessionId: string;
  platform: Platform;
  accountKey: string;
  state: Extract<AuthSessionState, "authenticated" | "failed" | "cancelled">;
  keychainService?: string | null;
  keychainAccount?: string | null;
  resultSummary?: Record<string, unknown> | null;
  errorSummary?: string | null;
}

export interface QrNativeAuthHandle {
  child: ChildProcess;
  completion: Promise<QrNativeAuthResult>;
}

function resolveNativeQrBinary(): string {
  const binary = resolveMacOSNativeBinary(
    process.env.CUED_AUTH_NATIVE_BINARY ?? process.env.CUED_CONTACTS_NATIVE_BINARY,
  );
  if (!binary) {
    throw new Error("CuedNative binary not found; build native/macos/CuedNative first");
  }
  return binary;
}

function parseFakeResult(
  session: AuthSessionSummary,
  integration: IntegrationStateSummary,
): QrNativeAuthResult | null {
  const raw = process.env.CUED_FAKE_QR_AUTH_RESULT;
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    sessionId: session.id,
    platform: session.platform,
    accountKey: session.accountKey,
    state:
      parsed.state === "authenticated"
        ? "authenticated"
        : parsed.state === "cancelled"
          ? "cancelled"
          : "failed",
    keychainService: typeof parsed.keychainService === "string" ? parsed.keychainService : null,
    keychainAccount:
      typeof parsed.keychainAccount === "string" ? parsed.keychainAccount : session.accountKey,
    resultSummary: {
      runtime: "qr_native",
      integration: `${integration.platform}/${integration.accountKey}`,
      ...(typeof parsed.resultSummary === "object" && parsed.resultSummary
        ? (parsed.resultSummary as Record<string, unknown>)
        : {}),
    },
    errorSummary: typeof parsed.errorSummary === "string" ? parsed.errorSummary : null,
  };
}

export function startQrNativeAuthSession(
  _db: CuedDatabase,
  session: AuthSessionSummary,
  integration: IntegrationStateSummary,
): QrNativeAuthHandle {
  const fake = parseFakeResult(session, integration);
  if (fake) {
    const child = spawn("sh", ["-lc", "exit 0"], { stdio: "ignore" });
    return {
      child,
      completion: Promise.resolve(fake),
    };
  }

  if (integration.platform === "signal") {
    const configDir =
      typeof integration.metadata?.configDir === "string"
        ? integration.metadata.configDir
        : getSignalConfigDir(session.accountKey);
    const child = spawn("sh", ["-lc", "exit 0"], { stdio: "ignore" });
    const completion = (async (): Promise<QrNativeAuthResult> => {
      const inspected = await inspectSignalCli();
      if (!inspected.cliPath) {
        return {
          sessionId: session.id,
          platform: session.platform,
          accountKey: session.accountKey,
          state: "failed",
          resultSummary: {
            runtime: "qr_native",
            helper: "signal-cli",
            configDir,
          },
          errorSummary: "signal-cli was not found. Set CUED_SIGNAL_CLI_PATH or install signal-cli.",
        };
      }
      if (!isSignalCliVersionSupported(inspected.version)) {
        return {
          sessionId: session.id,
          platform: session.platform,
          accountKey: session.accountKey,
          state: "failed",
          resultSummary: {
            runtime: "qr_native",
            helper: "signal-cli",
            cliPath: inspected.cliPath,
            signalCliVersion: inspected.version?.raw ?? null,
            configDir,
          },
          errorSummary: `signal-cli is too old (${inspected.version?.raw ?? "unknown"}). Upgrade to a supported version.`,
        };
      }

      const link = startSignalLinkSession({
        cliPath: inspected.cliPath,
        configDir,
        deviceName: "Cued",
      });
      const provisioningUri = await link.provisioningUri;
      const nativeBinary = resolveNativeQrBinary();
      const qrWindow = spawn(
        nativeBinary,
        [
          "auth",
          "qr",
          "--title",
          "Connect Signal",
          "--subtitle",
          "Scan this code in Signal > Settings > Linked Devices",
          "--uri",
          provisioningUri,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const qrClosed = new Promise<"cancelled">((resolve) => {
        qrWindow.once("close", () => resolve("cancelled"));
      });

      try {
        await Promise.race([link.completion.then(() => "authenticated" as const), qrClosed]).then(
          (state) => {
            if (state === "cancelled") {
              link.cancel();
              throw new Error("Signal linking cancelled");
            }
          },
        );
      } catch (error) {
        if (!qrWindow.killed) {
          qrWindow.kill("SIGTERM");
        }
        return {
          sessionId: session.id,
          platform: session.platform,
          accountKey: session.accountKey,
          state:
            error instanceof Error && error.message === "Signal linking cancelled"
              ? "cancelled"
              : "failed",
          resultSummary: {
            runtime: "qr_native",
            helper: "signal-cli",
            cliPath: inspected.cliPath,
            signalCliVersion: inspected.version?.raw ?? null,
            configDir,
          },
          errorSummary: error instanceof Error ? error.message : String(error),
        };
      }

      if (!qrWindow.killed) {
        qrWindow.kill("SIGTERM");
      }
      const linkedAccount = readSignalLinkedAccount(configDir);
      return {
        sessionId: session.id,
        platform: session.platform,
        accountKey: session.accountKey,
        state: "authenticated",
        keychainService: null,
        keychainAccount: null,
        resultSummary: {
          runtime: "qr_native",
          helper: "signal-cli",
          cliPath: inspected.cliPath,
          signalCliVersion: inspected.version?.raw ?? null,
          configDir,
          linkedAccount,
        },
        errorSummary: null,
      };
    })();

    return {
      child,
      completion,
    };
  }

  if (integration.platform === "whatsapp") {
    const storeDir =
      typeof integration.metadata?.storeDir === "string"
        ? integration.metadata.storeDir
        : getWhatsAppStoreDir(session.accountKey);
    const child = spawn("sh", ["-lc", "exit 0"], { stdio: "ignore" });
    const completion = (async (): Promise<QrNativeAuthResult> => {
      const inspected = inspectWhatsAppHelper();
      if (!inspected.helperPath) {
        return {
          sessionId: session.id,
          platform: session.platform,
          accountKey: session.accountKey,
          state: "failed",
          resultSummary: {
            runtime: "qr_native",
            helper: "cued-whatsapp-helper",
            storeDir,
          },
          errorSummary:
            "WhatsApp helper was not found. Build native/helpers/whatsapp-go first or set CUED_WHATSAPP_HELPER_BINARY.",
        };
      }

      const existingStatus = await readWhatsAppHelperStatus(storeDir).catch(() => null);
      if (existingStatus?.authenticated && existingStatus.accountJid) {
        return {
          sessionId: session.id,
          platform: session.platform,
          accountKey: session.accountKey,
          state: "authenticated",
          keychainService: null,
          keychainAccount: null,
          resultSummary: {
            runtime: "qr_native",
            helper: "cued-whatsapp-helper",
            helperPath: inspected.helperPath,
            helperVersion: existingStatus.helperVersion ?? inspected.version,
            storeDir,
            accountJid: existingStatus.accountJid,
            pushName: existingStatus.pushName ?? null,
          },
          errorSummary: null,
        };
      }

      const pair = startWhatsAppPairSession({
        helperPath: inspected.helperPath,
        storeDir,
        deviceName: "Cued",
      });
      const initial = await Promise.race([
        pair.qrCode.then((value) => ({ type: "qr" as const, value })),
        pair.completion.then((value) => ({ type: "authenticated" as const, value })),
      ]);

      if (initial.type === "authenticated") {
        return {
          sessionId: session.id,
          platform: session.platform,
          accountKey: session.accountKey,
          state: "authenticated",
          keychainService: null,
          keychainAccount: null,
          resultSummary: {
            runtime: "qr_native",
            helper: "cued-whatsapp-helper",
            helperPath: inspected.helperPath,
            helperVersion: initial.value.helperVersion ?? inspected.version,
            storeDir,
            accountJid: initial.value.accountJid,
            pushName: initial.value.pushName ?? null,
          },
          errorSummary: null,
        };
      }

      const qrCode = initial.value;
      const nativeBinary = resolveNativeQrBinary();
      const qrWindow = spawn(
        nativeBinary,
        [
          "auth",
          "qr",
          "--title",
          "Connect WhatsApp",
          "--subtitle",
          "Scan this code in WhatsApp > Linked Devices",
          "--uri",
          qrCode,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const qrClosed = new Promise<"cancelled">((resolve) => {
        qrWindow.once("close", () => resolve("cancelled"));
      });

      try {
        const result = await Promise.race([
          pair.completion.then((value) => ({ type: "authenticated" as const, value })),
          qrClosed.then(() => ({ type: "cancelled" as const, value: null })),
        ]);
        if (result.type === "cancelled") {
          pair.cancel();
          throw new Error("WhatsApp linking cancelled");
        }

        if (!qrWindow.killed) {
          qrWindow.kill("SIGTERM");
        }

        return {
          sessionId: session.id,
          platform: session.platform,
          accountKey: session.accountKey,
          state: "authenticated",
          keychainService: null,
          keychainAccount: null,
          resultSummary: {
            runtime: "qr_native",
            helper: "cued-whatsapp-helper",
            helperPath: inspected.helperPath,
            helperVersion: result.value.helperVersion ?? inspected.version,
            storeDir,
            accountJid: result.value.accountJid,
            pushName: result.value.pushName ?? null,
          },
          errorSummary: null,
        };
      } catch (error) {
        if (!qrWindow.killed) {
          qrWindow.kill("SIGTERM");
        }
        return {
          sessionId: session.id,
          platform: session.platform,
          accountKey: session.accountKey,
          state:
            error instanceof Error && error.message === "WhatsApp linking cancelled"
              ? "cancelled"
              : "failed",
          resultSummary: {
            runtime: "qr_native",
            helper: "cued-whatsapp-helper",
            helperPath: inspected.helperPath,
            helperVersion: inspected.version,
            storeDir,
          },
          errorSummary: error instanceof Error ? error.message : String(error),
        };
      }
    })();

    return {
      child,
      completion,
    };
  }

  const errorSummary = `QR auth runtime not implemented yet for ${integration.platform}; set CUED_FAKE_QR_AUTH_RESULT for tests`;
  const child = spawn("sh", ["-lc", "exit 1"], { stdio: "ignore" });
  return {
    child,
    completion: Promise.resolve({
      sessionId: session.id,
      platform: session.platform,
      accountKey: session.accountKey,
      state: "failed",
      keychainService: null,
      keychainAccount: null,
      resultSummary: {
        runtime: "qr_native",
        stub: true,
        ticket: randomUUID(),
      },
      errorSummary,
    }),
  };
}

export async function runQrNativeAuthSessionSync(
  db: CuedDatabase,
  session: AuthSessionSummary,
  integration: IntegrationStateSummary,
): Promise<QrNativeAuthResult> {
  const handle = startQrNativeAuthSession(db, session, integration);
  return handle.completion;
}
