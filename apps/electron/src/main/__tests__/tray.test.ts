import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

// vi.mock must use inline factory function - no external references
vi.mock("electron", () => ({
  Tray: vi.fn(() => ({
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    on: vi.fn(),
    destroy: vi.fn(),
  })),
  Menu: {
    buildFromTemplate: vi.fn(() => ({ items: [] })),
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: vi.fn(() => true),
      setTemplateImage: vi.fn(),
    })),
    createFromDataURL: vi.fn(() => ({
      setTemplateImage: vi.fn(),
    })),
    createFromBuffer: vi.fn(() => ({
      setTemplateImage: vi.fn(),
    })),
  },
  app: {
    isPackaged: false,
    quit: vi.fn(),
    getAppPath: vi.fn(() => "/mock/app/path"),
  },
}));

// Import after mocking
import { TrayManager, getTrayManager } from "../tray";
import { Tray, Menu, app } from "electron";

describe("TrayManager", () => {
  let trayManager: TrayManager;

  beforeEach(() => {
    vi.clearAllMocks();
    trayManager = new TrayManager();
  });

  afterEach(() => {
    trayManager.destroy();
  });

  describe("create()", () => {
    it("creates a tray instance", () => {
      trayManager.create();

      expect(Tray).toHaveBeenCalled();
      expect(trayManager.getTray()).toBeDefined();
    });

    it("does not create duplicate tray if already created", () => {
      trayManager.create();
      trayManager.create();

      expect(Tray).toHaveBeenCalledTimes(1);
    });

    it("builds context menu", () => {
      trayManager.create();

      expect(Menu.buildFromTemplate).toHaveBeenCalled();
    });
  });

  describe("context menu structure", () => {
    it("includes all required menu items", () => {
      trayManager.create();

      const MenuMock = Menu.buildFromTemplate as ReturnType<typeof vi.fn>;
      const menuTemplate = MenuMock.mock.calls[0][0] as Array<{ label?: string; type?: string }>;

      // Check for required items
      const showItem = menuTemplate.find((item) => item.label === "Show Cued");
      const syncItem = menuTemplate.find(
        (item) => item.label === "Sync Now" || item.label === "Syncing..."
      );
      const prefsItem = menuTemplate.find((item) => item.label === "Preferences...");
      const quitItem = menuTemplate.find((item) => item.label === "Quit Cued");
      const separators = menuTemplate.filter((item) => item.type === "separator");

      expect(showItem).toBeDefined();
      expect(syncItem).toBeDefined();
      expect(prefsItem).toBeDefined();
      expect(quitItem).toBeDefined();
      expect(separators.length).toBeGreaterThan(0);
    });
  });

  describe("callbacks", () => {
    it("calls onShowWindow callback when Show Cued clicked", () => {
      const onShowWindow = vi.fn();
      trayManager = new TrayManager({ onShowWindow });
      trayManager.create();

      const MenuMock = Menu.buildFromTemplate as ReturnType<typeof vi.fn>;
      const menuTemplate = MenuMock.mock.calls[0][0] as Array<{ label?: string; click?: () => void }>;
      const showItem = menuTemplate.find((item) => item.label === "Show Cued");
      showItem?.click?.();

      expect(onShowWindow).toHaveBeenCalled();
    });

    it("calls onSyncNow callback when Sync Now clicked", () => {
      const onSyncNow = vi.fn();
      trayManager = new TrayManager({ onSyncNow });
      trayManager.create();

      const MenuMock = Menu.buildFromTemplate as ReturnType<typeof vi.fn>;
      const menuTemplate = MenuMock.mock.calls[0][0] as Array<{ label?: string; click?: () => void }>;
      const syncItem = menuTemplate.find((item) => item.label === "Sync Now");
      syncItem?.click?.();

      expect(onSyncNow).toHaveBeenCalled();
    });

    it("calls onQuit callback and app.quit when Quit clicked", () => {
      const onQuit = vi.fn();
      trayManager = new TrayManager({ onQuit });
      trayManager.create();

      const MenuMock = Menu.buildFromTemplate as ReturnType<typeof vi.fn>;
      const menuTemplate = MenuMock.mock.calls[0][0] as Array<{ label?: string; click?: () => void }>;
      const quitItem = menuTemplate.find((item) => item.label === "Quit Cued");
      quitItem?.click?.();

      expect(onQuit).toHaveBeenCalled();
      expect(app.quit).toHaveBeenCalled();
    });
  });

  describe("setMainWindow()", () => {
    it("accepts a BrowserWindow reference", () => {
      const mockWindow = {
        show: vi.fn(),
        hide: vi.fn(),
      } as unknown as BrowserWindow;

      expect(() => {
        trayManager.setMainWindow(mockWindow);
      }).not.toThrow();
    });

    it("accepts null", () => {
      expect(() => {
        trayManager.setMainWindow(null);
      }).not.toThrow();
    });
  });

  describe("destroy()", () => {
    it("clears tray reference after destroy", () => {
      trayManager.create();
      trayManager.destroy();

      expect(trayManager.getTray()).toBeNull();
    });

    it("does nothing if tray not created", () => {
      expect(() => {
        trayManager.destroy();
      }).not.toThrow();
    });
  });

  describe("getTray()", () => {
    it("returns null before create()", () => {
      expect(trayManager.getTray()).toBeNull();
    });

    it("returns tray instance after create()", () => {
      trayManager.create();
      expect(trayManager.getTray()).not.toBeNull();
    });
  });
});

describe("getTrayManager()", () => {
  it("returns a TrayManager singleton", () => {
    const manager = getTrayManager();
    expect(manager).toBeInstanceOf(TrayManager);
  });
});
