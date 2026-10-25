import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AuthSessionState, Platform } from "../../../core/types/provider.js";
import type { CuedDatabase } from "../../../db/database.js";
import { resolveMacOSNativeBinary } from "../../../runtime/native-binary.js";
import {
  getSignalConfigDir,
  inspectSignalCli,
  isSignalCliVersionSupported,
  readSignalLinkedAccount,
  startSignalLinkSession,
} from "../../signal/cli/client.js";
import { ensureSignalCliAvailable } from "../../signal/cli/install.js";
import {
  getWhatsAppStoreDir,
  inspectWhatsAppHelper,
  readWhatsAppHelperStatus,
  startWhatsAppPairSession,
  type WhatsAppHelperStatus,
} from "../../whatsapp/helper/pair.js";
import type { AuthSessionSummary, IntegrationStateSummary } from "../state/types.js";

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

function startAuthSentinelProcess(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 2147483647)"], {
    stdio: "ignore",
  });
}

function keepSentinelUntilComplete(
  child: ChildProcess,
  completion: Promise<QrNativeAuthResult>,
): Promise<QrNativeAuthResult> {
  return completion.finally(() => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  });
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

function isDurableWhatsAppAuthStatus(
  status: WhatsAppHelperStatus | null,
): status is WhatsAppHelperStatus & { accountJid: string } {
  return status?.authenticated === true && Boolean(status.accountJid?.trim());
}

type WhatsAppQrFailureCode =
  | "helper_missing"
  | "helper_pair_failed"
  | "native_qr_unavailable"
  | "qr_cancelled"
  | "durable_status_timeout";

async function waitForDurableWhatsAppAuthStatus(
  storeDir: string,
  timeoutMs = 30_000,
): Promise<WhatsAppHelperStatus & { accountJid: string }> {
  const startedAt = Date.now();
  let lastStatus: WhatsAppHelperStatus | null = null;
  let lastError: unknown = null;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      lastStatus = await readWhatsAppHelperStatus(storeDir);
      if (isDurableWhatsAppAuthStatus(lastStatus)) {
        return lastStatus;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  const statusDetail = lastStatus
    ? `authenticated=${lastStatus.authenticated}, accountJid=${lastStatus.accountJid ? "present" : "missing"}`
    : lastError instanceof Error
      ? "helper status unavailable"
      : lastError
        ? "helper status unavailable"
        : "no helper status";
  throw new Error(`WhatsApp linking did not produce a durable linked account (${statusDetail})`);
}

function buildWhatsAppAuthenticatedResult(input: {
  session: AuthSessionSummary;
  inspected: ReturnType<typeof inspectWhatsAppHelper>;
  storeDir: string;
  status: WhatsAppHelperStatus & { accountJid: string };
}): QrNativeAuthResult {
  return {
    sessionId: input.session.id,
    platform: input.session.platform,
    accountKey: input.session.accountKey,
    state: "authenticated",
    keychainService: null,
    keychainAccount: null,
    resultSummary: {
      runtime: "qr_native",
      helper: "cued-whatsapp-helper",
      helperPath: input.inspected.helperPath,
      helperVersion: input.status.helperVersion ?? input.inspected.version,
      storeDir: input.storeDir,
      accountJid: input.status.accountJid,
      pushName: input.status.pushName ?? null,
      durableStatusVerified: true,
      historySyncPending: typeof input.status.lastHistorySyncAt !== "number",
      lastHistorySyncAt: input.status.lastHistorySyncAt ?? null,
      lastHistoryNotificationAt: input.status.lastHistoryNotificationAt ?? null,
    },
    errorSummary: null,
  };
}

function buildWhatsAppFailedResult(input: {
  session: AuthSessionSummary;
  inspected: ReturnType<typeof inspectWhatsAppHelper>;
  state?: Extract<AuthSessionState, "failed" | "cancelled">;
  errorCode: WhatsAppQrFailureCode;
  phase: string;
}): QrNativeAuthResult {
  const messageByCode: Record<WhatsAppQrFailureCode, string> = {
    helper_missing:
      "WhatsApp helper was not found. Build native/helpers/whatsapp-go first or set CUED_WHATSAPP_HELPER_BINARY.",
    helper_pair_failed: "WhatsApp QR pairing failed in the helper runtime.",
    native_qr_unavailable: "WhatsApp QR window could not be opened.",
    qr_cancelled: "WhatsApp QR pairing cancelled.",
    durable_status_timeout: "WhatsApp QR pairing did not produce a durable linked account.",
  };
  return {
    sessionId: input.session.id,
    platform: input.session.platform,
    accountKey: input.session.accountKey,
    state: input.state ?? "failed",
    keychainService: null,
    keychainAccount: null,
    resultSummary: {
      runtime: "qr_native",
      helper: "cued-whatsapp-helper",
      helperAvailable:
        input.errorCode === "helper_missing" ? false : Boolean(input.inspected.helperPath),
      helperVersion: input.inspected.version,
      errorCode: input.errorCode,
      phase: input.phase,
    },
    errorSummary: messageByCode[input.errorCode],
  };
}

function classifyWhatsAppQrError(error: unknown): {
  state: Extract<AuthSessionState, "failed" | "cancelled">;
  errorCode: WhatsAppQrFailureCode;
} {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/cancelled/i.test(message)) {
    return { state: "cancelled", errorCode: "qr_cancelled" };
  }
  if (/cuednative binary not found|qr window/i.test(message)) {
    return { state: "failed", errorCode: "native_qr_unavailable" };
  }
  if (/enoent|not found|no such file/i.test(message)) {
    return { state: "failed", errorCode: "helper_missing" };
  }
  if (/durable linked account/i.test(message)) {
    return { state: "failed", errorCode: "durable_status_timeout" };
  }
  return { state: "failed", errorCode: "helper_pair_failed" };
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
    const child = startAuthSentinelProcess();
    const completion = (async (): Promise<QrNativeAuthResult> => {
      await ensureSignalCliAvailable();
      if (child.exitCode !== null || child.signalCode !== null || child.killed) {
        throw new Error("Signal linking cancelled");
      }
      const inspected = await inspectSignalCli();
      if (!inspected.cliPath) {
        return {
          sessionId: session.id,
          platform: session.platform,
          accountKey: session.accountKey,
          state: "failed",
          resultSummary: {
            runtime: "qr_native",
            helper: "cued-signal-cli",
            configDir,
          },
          errorSummary: "Bundled Signal helper was not found. Rebuild or update Cued.",
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
            helper: "cued-signal-cli",
            cliPath: inspected.cliPath,
            helperRoot: inspected.helperRoot,
            javaHome: inspected.javaHome,
            signalCliVersion: inspected.version?.raw ?? null,
            configDir,
          },
          errorSummary: `Bundled Signal helper is too old or invalid (${inspected.version?.raw ?? "unknown"}). Rebuild or update Cued.`,
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
            helper: "cued-signal-cli",
            cliPath: inspected.cliPath,
            helperRoot: inspected.helperRoot,
            javaHome: inspected.javaHome,
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
          helper: "cued-signal-cli",
          cliPath: inspected.cliPath,
          helperRoot: inspected.helperRoot,
          javaHome: inspected.javaHome,
          signalCliVersion: inspected.version?.raw ?? null,
          configDir,
          linkedAccount,
        },
        errorSummary: null,
      };
    })();

    return {
      child,
      completion: keepSentinelUntilComplete(child, completion),
    };
  }

  if (integration.platform === "whatsapp") {
    const storeDir =
      typeof integration.metadata?.storeDir === "string"
        ? integration.metadata.storeDir
        : getWhatsAppStoreDir(session.accountKey);
    const child = startAuthSentinelProcess();
    const completion = (async (): Promise<QrNativeAuthResult> => {
      const inspected = inspectWhatsAppHelper();
      if (!inspected.helperPath) {
        return buildWhatsAppFailedResult({
          session,
          inspected,
          errorCode: "helper_missing",
          phase: "inspect_helper",
        });
      }

      const existingStatus = await readWhatsAppHelperStatus(storeDir).catch(() => null);
      if (isDurableWhatsAppAuthStatus(existingStatus)) {
        return buildWhatsAppAuthenticatedResult({
          session,
          inspected,
          storeDir,
          status: existingStatus,
        });
      }

      const pair = startWhatsAppPairSession({
        helperPath: inspected.helperPath,
        storeDir,
        deviceName: "Cued",
      });
      let qrWindow: ChildProcess | null = null;

      try {
        const initial = await Promise.race([
          pair.qrCode.then((value) => ({ type: "qr" as const, value })),
          pair.completion.then((value) => ({ type: "authenticated" as const, value })),
        ]);

        if (initial.type === "authenticated") {
          const status = await waitForDurableWhatsAppAuthStatus(storeDir);
          return buildWhatsAppAuthenticatedResult({ session, inspected, storeDir, status });
        }

        const qrCode = initial.value;
        const nativeBinary = resolveNativeQrBinary();
        qrWindow = spawn(
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
          qrWindow?.once("close", () => resolve("cancelled"));
        });
        const qrFailed = new Promise<never>((_, reject) => {
          qrWindow?.once("error", reject);
        });
        const result = await Promise.race([
          pair.completion.then((value) => ({ type: "authenticated" as const, value })),
          qrClosed.then(() => ({ type: "cancelled" as const, value: null })),
          qrFailed,
        ]);
        if (result.type === "cancelled") {
          pair.cancel();
          throw new Error("WhatsApp linking cancelled");
        }

        if (qrWindow && !qrWindow.killed) {
          qrWindow.kill("SIGTERM");
        }

        const status = await waitForDurableWhatsAppAuthStatus(storeDir);
        return buildWhatsAppAuthenticatedResult({ session, inspected, storeDir, status });
      } catch (error) {
        if (qrWindow && !qrWindow.killed) {
          qrWindow.kill("SIGTERM");
        }
        pair.cancel();
        const classified = classifyWhatsAppQrError(error);
        const errorCode =
          qrWindow && classified.errorCode === "helper_missing"
            ? "native_qr_unavailable"
            : classified.errorCode;
        return buildWhatsAppFailedResult({
          session,
          inspected,
          state: classified.state,
          errorCode,
          phase: qrWindow ? "pairing" : "start_pairing",
        });
      }
    })();

    return {
      child,
      completion: keepSentinelUntilComplete(child, completion),
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
