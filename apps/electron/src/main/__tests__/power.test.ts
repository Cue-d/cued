import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

// vi.mock must use inline factory function - no external references
vi.mock("electron", () => ({
  powerSaveBlocker: {
    start: vi.fn(() => 1),
    stop: vi.fn(() => true),
    isStarted: vi.fn(() => true),
  },
  powerMonitor: {
    on: vi.fn(),
    getSystemIdleState: vi.fn(() => "active"),
    getSystemIdleTime: vi.fn(() => 0),
  },
  ipcMain: {
    handle: vi.fn(),
  },
}));

// Import after mocking
import { PowerManager, getPowerManager } from "../power";
import { powerSaveBlocker, powerMonitor, ipcMain } from "electron";

describe("PowerManager", () => {
  let powerManager: PowerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    powerManager = new PowerManager();
  });

  afterEach(() => {
    powerManager.destroy();
  });

  describe("constructor", () => {
    it("sets up sleep/wake handlers", () => {
      expect(powerMonitor.on).toHaveBeenCalledWith(
        "suspend",
        expect.any(Function)
      );
      expect(powerMonitor.on).toHaveBeenCalledWith(
        "resume",
        expect.any(Function)
      );
    });
  });

  describe("startPreventingSleep()", () => {
    it("calls powerSaveBlocker.start with prevent-app-suspension", () => {
      powerManager.startPreventingSleep();

      expect(powerSaveBlocker.start).toHaveBeenCalledWith(
        "prevent-app-suspension"
      );
    });

    it("does not start duplicate blocker if already blocking", () => {
      powerManager.startPreventingSleep();
      powerManager.startPreventingSleep();

      expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    });
  });

  describe("stopPreventingSleep()", () => {
    it("calls powerSaveBlocker.stop with blocker ID", () => {
      powerManager.startPreventingSleep();
      powerManager.stopPreventingSleep();

      expect(powerSaveBlocker.stop).toHaveBeenCalledWith(1);
    });

    it("does nothing if not currently blocking", () => {
      powerManager.stopPreventingSleep();

      expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
    });

    it("clears blocker ID after stopping", () => {
      powerManager.startPreventingSleep();
      powerManager.stopPreventingSleep();

      // Now it should be able to start again
      vi.clearAllMocks();
      powerManager.startPreventingSleep();

      expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    });
  });

  describe("isPreventingSleep()", () => {
    it("returns false when not blocking", () => {
      expect(powerManager.isPreventingSleep()).toBe(false);
    });

    it("returns true when blocking is active", () => {
      powerManager.startPreventingSleep();

      expect(powerManager.isPreventingSleep()).toBe(true);
    });

    it("delegates to powerSaveBlocker.isStarted", () => {
      powerManager.startPreventingSleep();
      powerManager.isPreventingSleep();

      expect(powerSaveBlocker.isStarted).toHaveBeenCalledWith(1);
    });
  });

  describe("sleep/wake callbacks", () => {
    it("calls onSuspend callback on suspend event", () => {
      const onSuspend = vi.fn();
      vi.clearAllMocks();
      powerManager = new PowerManager({ onSuspend });

      const powerMonitorMock = powerMonitor.on as ReturnType<typeof vi.fn>;
      const suspendHandler = powerMonitorMock.mock.calls.find(
        (call) => call[0] === "suspend"
      )?.[1];
      suspendHandler?.();

      expect(onSuspend).toHaveBeenCalled();
    });

    it("calls onResume callback on resume event", () => {
      const onResume = vi.fn();
      vi.clearAllMocks();
      powerManager = new PowerManager({ onResume });

      const powerMonitorMock = powerMonitor.on as ReturnType<typeof vi.fn>;
      const resumeHandler = powerMonitorMock.mock.calls.find(
        (call) => call[0] === "resume"
      )?.[1];
      resumeHandler?.();

      expect(onResume).toHaveBeenCalled();
    });

    it("stops preventing sleep on suspend", () => {
      // Create new manager to capture fresh handlers
      vi.clearAllMocks();
      const pm = new PowerManager();
      pm.startPreventingSleep();

      // Get the suspend handler that was registered
      const powerMonitorMock = powerMonitor.on as ReturnType<typeof vi.fn>;
      const suspendCall = powerMonitorMock.mock.calls.find(
        (call) => call[0] === "suspend"
      );
      expect(suspendCall).toBeDefined();

      // Reset mocks to track the stop call
      vi.mocked(powerSaveBlocker.stop).mockClear();

      // Call suspend handler
      suspendCall?.[1]();

      expect(powerSaveBlocker.stop).toHaveBeenCalled();
      pm.destroy();
    });
  });

  describe("setMainWindow()", () => {
    it("accepts a BrowserWindow reference", () => {
      const mockWindow = {
        webContents: { send: vi.fn() },
      } as unknown as BrowserWindow;

      expect(() => {
        powerManager.setMainWindow(mockWindow);
      }).not.toThrow();
    });

    it("accepts null", () => {
      expect(() => {
        powerManager.setMainWindow(null);
      }).not.toThrow();
    });
  });

  describe("setupIpcHandlers()", () => {
    it("registers power:isPreventingSleep handler", () => {
      powerManager.setupIpcHandlers();

      expect(ipcMain.handle).toHaveBeenCalledWith(
        "power:isPreventingSleep",
        expect.any(Function)
      );
    });

    it("registers power:getIdleState handler", () => {
      powerManager.setupIpcHandlers();

      expect(ipcMain.handle).toHaveBeenCalledWith(
        "power:getIdleState",
        expect.any(Function)
      );
    });

    it("registers power:getIdleTime handler", () => {
      powerManager.setupIpcHandlers();

      expect(ipcMain.handle).toHaveBeenCalledWith(
        "power:getIdleTime",
        expect.any(Function)
      );
    });
  });

  describe("destroy()", () => {
    it("stops preventing sleep if active", () => {
      powerManager.startPreventingSleep();
      vi.clearAllMocks();

      powerManager.destroy();

      expect(powerSaveBlocker.stop).toHaveBeenCalled();
    });

    it("does nothing if not blocking", () => {
      powerManager.destroy();

      expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
    });
  });
});

describe("getPowerManager()", () => {
  it("returns a PowerManager singleton", () => {
    const manager = getPowerManager();
    expect(manager).toBeInstanceOf(PowerManager);
  });
});
