import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock must use inline factory function - no external references
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/mock/userData"),
    setLoginItemSettings: vi.fn(),
    getLoginItemSettings: vi.fn(() => ({
      openAtLogin: false,
      wasOpenedAtLogin: false,
    })),
  },
  ipcMain: {
    handle: vi.fn(),
  },
}));

// Mock fs module with inline factory
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Import after mocking
import { SettingsManager, getSettingsManager } from "../settings";
import { app, ipcMain } from "electron";
import * as fs from "node:fs";

describe("SettingsManager", () => {
  let settingsManager: SettingsManager;

  beforeEach(() => {
    vi.clearAllMocks();
    settingsManager = new SettingsManager();
  });

  describe("constructor", () => {
    it("loads settings from disk if file exists", () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      vi.mocked(fs.readFileSync).mockReturnValueOnce(
        JSON.stringify({ autoLaunchEnabled: true })
      );

      const manager = new SettingsManager();
      expect(manager.getAutoLaunch()).toBe(true);
    });

    it("uses default settings if file does not exist", () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(false);

      const manager = new SettingsManager();
      expect(manager.getAutoLaunch()).toBe(false);
      expect(manager.getStartMinimized()).toBe(false);
      expect(manager.getPreventSleepWhileSyncing()).toBe(true);
    });

    it("uses default settings if file read fails", () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
        throw new Error("Read error");
      });

      const manager = new SettingsManager();
      expect(manager.getAutoLaunch()).toBe(false);
    });
  });

  describe("getSettings()", () => {
    it("returns all settings", () => {
      const settings = settingsManager.getSettings();

      expect(settings).toHaveProperty("autoLaunchEnabled");
      expect(settings).toHaveProperty("startMinimized");
      expect(settings).toHaveProperty("preventSleepWhileSyncing");
    });

    it("returns a copy of settings", () => {
      const settings1 = settingsManager.getSettings();
      const settings2 = settingsManager.getSettings();

      expect(settings1).not.toBe(settings2);
      expect(settings1).toEqual(settings2);
    });
  });

  describe("auto-launch settings", () => {
    describe("getAutoLaunch()", () => {
      it("returns false by default", () => {
        expect(settingsManager.getAutoLaunch()).toBe(false);
      });
    });

    describe("setAutoLaunch()", () => {
      it("enables auto-launch", () => {
        settingsManager.setAutoLaunch(true);

        expect(settingsManager.getAutoLaunch()).toBe(true);
      });

      it("disables auto-launch", () => {
        settingsManager.setAutoLaunch(true);
        settingsManager.setAutoLaunch(false);

        expect(settingsManager.getAutoLaunch()).toBe(false);
      });

      it("calls app.setLoginItemSettings with correct options", () => {
        settingsManager.setAutoLaunch(true);

        expect(app.setLoginItemSettings).toHaveBeenCalledWith({
          openAtLogin: true,
          openAsHidden: true,
          args: ["--hidden"],
        });
      });

      it("saves settings to disk", () => {
        settingsManager.setAutoLaunch(true);

        // Check that writeFileSync was called
        expect(fs.writeFileSync).toHaveBeenCalled();
        const calls = vi.mocked(fs.writeFileSync).mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(String(lastCall[0])).toContain("settings.json");
        // JSON is pretty-printed, check for key and value separately
        const content = String(lastCall[1]);
        expect(content).toContain('"autoLaunchEnabled"');
        expect(content).toContain("true");
      });
    });
  });

  describe("start minimized settings", () => {
    describe("getStartMinimized()", () => {
      it("returns false by default", () => {
        expect(settingsManager.getStartMinimized()).toBe(false);
      });
    });

    describe("setStartMinimized()", () => {
      it("enables start minimized", () => {
        settingsManager.setStartMinimized(true);

        expect(settingsManager.getStartMinimized()).toBe(true);
      });

      it("saves settings to disk", () => {
        settingsManager.setStartMinimized(true);

        expect(fs.writeFileSync).toHaveBeenCalled();
        const calls = vi.mocked(fs.writeFileSync).mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(String(lastCall[0])).toContain("settings.json");
        const content = String(lastCall[1]);
        expect(content).toContain('"startMinimized"');
        expect(content).toContain("true");
      });
    });
  });

  describe("sync history days settings", () => {
    describe("getSyncHistoryDays()", () => {
      it("returns 90 by default", () => {
        expect(settingsManager.getSyncHistoryDays()).toBe(90);
      });
    });

    describe("setSyncHistoryDays()", () => {
      it("updates sync history days", () => {
        settingsManager.setSyncHistoryDays(30);

        expect(settingsManager.getSyncHistoryDays()).toBe(30);
      });

      it("rounds to integer", () => {
        settingsManager.setSyncHistoryDays(45.7);

        expect(settingsManager.getSyncHistoryDays()).toBe(46);
      });

      it("enforces minimum of 1", () => {
        settingsManager.setSyncHistoryDays(0);

        expect(settingsManager.getSyncHistoryDays()).toBe(1);
      });

      it("saves settings to disk", () => {
        settingsManager.setSyncHistoryDays(180);

        expect(fs.writeFileSync).toHaveBeenCalled();
        const calls = vi.mocked(fs.writeFileSync).mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(String(lastCall[0])).toContain("settings.json");
        const content = String(lastCall[1]);
        expect(content).toContain('"syncHistoryDays"');
        expect(content).toContain("180");
      });
    });
  });

  describe("prevent sleep settings", () => {
    describe("getPreventSleepWhileSyncing()", () => {
      it("returns true by default", () => {
        expect(settingsManager.getPreventSleepWhileSyncing()).toBe(true);
      });
    });

    describe("setPreventSleepWhileSyncing()", () => {
      it("disables prevent sleep", () => {
        settingsManager.setPreventSleepWhileSyncing(false);

        expect(settingsManager.getPreventSleepWhileSyncing()).toBe(false);
      });

      it("saves settings to disk", () => {
        settingsManager.setPreventSleepWhileSyncing(false);

        expect(fs.writeFileSync).toHaveBeenCalled();
        const calls = vi.mocked(fs.writeFileSync).mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(String(lastCall[0])).toContain("settings.json");
        const content = String(lastCall[1]);
        expect(content).toContain('"preventSleepWhileSyncing"');
        expect(content).toContain("false");
      });
    });
  });

  describe("wasLaunchedHidden()", () => {
    const originalArgv = process.argv;

    afterEach(() => {
      process.argv = originalArgv;
    });

    it("returns true when --hidden flag is present", () => {
      process.argv = ["node", "app", "--hidden"];

      expect(SettingsManager.wasLaunchedHidden()).toBe(true);
    });

    it("returns false when --hidden flag is not present", () => {
      process.argv = ["node", "app"];

      expect(SettingsManager.wasLaunchedHidden()).toBe(false);
    });
  });

  describe("getLoginItemSettings()", () => {
    it("delegates to app.getLoginItemSettings", () => {
      settingsManager.getLoginItemSettings();

      expect(app.getLoginItemSettings).toHaveBeenCalled();
    });

    it("returns login item settings from OS", () => {
      vi.mocked(app.getLoginItemSettings).mockReturnValueOnce({
        openAtLogin: true,
        openAsHidden: false,
        wasOpenedAtLogin: false,
        wasOpenedAsHidden: false,
        restoreState: false,
        executableWillLaunchAtLogin: false,
        launchItems: [],
        status: "enabled",
      });

      const settings = settingsManager.getLoginItemSettings();

      expect(settings.openAtLogin).toBe(true);
    });
  });

  describe("setupIpcHandlers()", () => {
    it("registers settings:getAll handler", () => {
      settingsManager.setupIpcHandlers();

      expect(ipcMain.handle).toHaveBeenCalledWith(
        "settings:getAll",
        expect.any(Function)
      );
    });

    it("registers settings:getAutoLaunch handler", () => {
      settingsManager.setupIpcHandlers();

      expect(ipcMain.handle).toHaveBeenCalledWith(
        "settings:getAutoLaunch",
        expect.any(Function)
      );
    });

    it("registers settings:setAutoLaunch handler", () => {
      settingsManager.setupIpcHandlers();

      expect(ipcMain.handle).toHaveBeenCalledWith(
        "settings:setAutoLaunch",
        expect.any(Function)
      );
    });

    it("registers settings:getStartMinimized handler", () => {
      settingsManager.setupIpcHandlers();

      expect(ipcMain.handle).toHaveBeenCalledWith(
        "settings:getStartMinimized",
        expect.any(Function)
      );
    });

    it("registers settings:setStartMinimized handler", () => {
      settingsManager.setupIpcHandlers();

      expect(ipcMain.handle).toHaveBeenCalledWith(
        "settings:setStartMinimized",
        expect.any(Function)
      );
    });

    it("registers settings:getPreventSleepWhileSyncing handler", () => {
      settingsManager.setupIpcHandlers();

      expect(ipcMain.handle).toHaveBeenCalledWith(
        "settings:getPreventSleepWhileSyncing",
        expect.any(Function)
      );
    });

    it("registers settings:setPreventSleepWhileSyncing handler", () => {
      settingsManager.setupIpcHandlers();

      expect(ipcMain.handle).toHaveBeenCalledWith(
        "settings:setPreventSleepWhileSyncing",
        expect.any(Function)
      );
    });

    it("registers settings:getLoginItemSettings handler", () => {
      settingsManager.setupIpcHandlers();

      expect(ipcMain.handle).toHaveBeenCalledWith(
        "settings:getLoginItemSettings",
        expect.any(Function)
      );
    });

    it("registers settings:getSyncHistoryDays handler", () => {
      settingsManager.setupIpcHandlers();

      expect(ipcMain.handle).toHaveBeenCalledWith(
        "settings:getSyncHistoryDays",
        expect.any(Function)
      );
    });

    it("registers settings:setSyncHistoryDays handler", () => {
      settingsManager.setupIpcHandlers();

      expect(ipcMain.handle).toHaveBeenCalledWith(
        "settings:setSyncHistoryDays",
        expect.any(Function)
      );
    });
  });
});

describe("getSettingsManager()", () => {
  it("returns a SettingsManager singleton", () => {
    const manager = getSettingsManager();
    expect(manager).toBeInstanceOf(SettingsManager);
  });
});
