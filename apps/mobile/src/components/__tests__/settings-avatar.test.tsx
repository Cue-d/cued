import React from "react";
import { render } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { contactAvatarPropsSpy } = vi.hoisted(() => ({
  contactAvatarPropsSpy: vi.fn(),
}));

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => <div {...props}>{children}</div>,
}));

vi.mock("convex/react", () => ({
  useQuery: () => ({ integrations: [] }),
}));

vi.mock("uniwind", () => ({
  useUniwind: () => ({ theme: "light", hasAdaptiveThemes: false }),
  Uniwind: { setTheme: vi.fn() },
}));

vi.mock("@/providers/AuthProvider", () => ({
  useAuth: () => ({
    user: {
      first_name: "Jane",
      last_name: "Doe",
      email: "jane@example.com",
      email_verified: true,
      profile_picture_url: "https://example.com/jane.jpg",
      id: "user_12345678",
    },
    signOut: vi.fn(),
    isLoading: false,
  }),
}));

vi.mock("@/contexts/electron-presence-context", () => ({
  useElectronPrescence: () => ({
    isOnline: true,
    lastSeen: null,
  }),
}));

vi.mock("@/lib/auth", () => ({
  getRedirectUri: () => "cued://auth/callback",
}));

vi.mock("@/components/platform-icons", () => ({
  PlatformIcon: () => null,
}));

vi.mock("@/components/contact-avatar", () => ({
  ContactAvatar: (props: {
    initials: string;
    avatarUrl?: string | null;
    size: number;
  }) => {
    contactAvatarPropsSpy(props);
    return (
      <div
        data-testid="settings-contact-avatar"
        data-initials={props.initials}
        data-avatar-url={props.avatarUrl ?? ""}
      />
    );
  },
}));

import SettingsScreen from "../../../app/settings";

describe("SettingsScreen avatar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wires user avatar URL and initials into ContactAvatar", () => {
    const { getByTestId } = render(<SettingsScreen />);

    const avatar = getByTestId("settings-contact-avatar");
    expect(avatar.getAttribute("data-avatar-url")).toBe("https://example.com/jane.jpg");
    expect(contactAvatarPropsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        initials: "JD",
        avatarUrl: "https://example.com/jane.jpg",
        size: 80,
      }),
    );
  });
});
