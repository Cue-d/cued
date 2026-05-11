import { describe, expect, it, vi } from "vitest";
import {
  parseRunningCuedProcesses,
  selectCompetingDaemonProcesses,
  terminateCompetingDaemons,
} from "./competing-daemons.js";

describe("competing daemon cleanup", () => {
  it("ignores the current process and selects different bundle owners", () => {
    const processes = parseRunningCuedProcesses(`
      101 /Applications/Cued.app/Contents/MacOS/CuedDaemon --menu-bar
      202 /Users/avery/.Trash/cued-reset/Cued.app/Contents/Resources/runtime/node/bin/node /Users/avery/.Trash/cued-reset/Cued.app/Contents/Resources/cued-runtime/dist/cli.js daemon
      303 /Users/avery/Applications/Cued.app/Contents/MacOS/CuedDaemon --menu-bar
    `);

    expect(
      selectCompetingDaemonProcesses(
        processes,
        "/Applications/Cued.app/Contents/MacOS/CuedDaemon",
        101,
      ).map((processInfo) => processInfo.pid),
    ).toEqual([202, 303]);
  });

  it("waits for competing owners to release pid, lock, and socket state", () => {
    let now = 0;
    let runningChecks = 0;
    let lockChecks = 0;
    let socketChecks = 0;
    const sleep = vi.fn((ms: number) => {
      now += ms;
    });
    const killProcess = vi.fn();

    const result = terminateCompetingDaemons({
      expectedExecutablePath: "/Applications/Cued.app/Contents/MacOS/CuedDaemon",
      psOutput:
        "202 /Users/avery/.Trash/cued-reset/Cued.app/Contents/MacOS/CuedDaemon --menu-bar\n",
      currentPid: 999,
      waitMs: 1_000,
      pollMs: 100,
      now: () => now,
      sleep,
      killProcess,
      isProcessRunning: () => {
        runningChecks += 1;
        return runningChecks < 2;
      },
      readLock: () => {
        lockChecks += 1;
        return lockChecks < 2
          ? {
              kind: "daemon",
              pid: 202,
              startedAt: 1,
              updatedAt: 1,
            }
          : null;
      },
      socketExists: () => {
        socketChecks += 1;
        return socketChecks < 2;
      },
    });

    expect(killProcess).toHaveBeenCalledWith(202);
    expect(result.terminated).toEqual([202]);
    expect(sleep).toHaveBeenCalled();
  });
});
