import React from "react";
import { render, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRouterPush } from "@/test/setup";

const { mockSelectionAsync, contactAvatarPropsSpy } = vi.hoisted(() => ({
  mockSelectionAsync: vi.fn(),
  contactAvatarPropsSpy: vi.fn(),
}));

vi.mock("expo-haptics", () => ({
  selectionAsync: mockSelectionAsync,
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<typeof import("react-native")>("react-native");
  return {
    ...actual,
    Pressable: ({
      onPress,
      children,
      ...props
    }: {
      onPress?: () => void;
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => (
      <button data-testid="header-avatar-pressable" onClick={onPress} {...props}>
        {children}
      </button>
    ),
  };
});

vi.mock("@/providers/AuthProvider", () => ({
  useAuth: () => ({
    user: {
      first_name: "Jane",
      last_name: "Doe",
      email: "jane@example.com",
      profile_picture_url: "https://example.com/jane.jpg",
    },
  }),
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
        data-testid="header-contact-avatar"
        data-initials={props.initials}
        data-avatar-url={props.avatarUrl ?? ""}
        data-size={String(props.size)}
      />
    );
  },
}));

import { HeaderAvatar } from "../header-avatar";

describe("HeaderAvatar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes user initials and profile photo URL to ContactAvatar", () => {
    const { getByTestId } = render(<HeaderAvatar size={48} />);

    const avatar = getByTestId("header-contact-avatar");
    expect(avatar.getAttribute("data-avatar-url")).toBe("https://example.com/jane.jpg");
    expect(avatar.getAttribute("data-size")).toBe("48");
    expect(contactAvatarPropsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        initials: "JD",
        avatarUrl: "https://example.com/jane.jpg",
        size: 48,
      }),
    );
  });

  it("navigates to settings and triggers haptic feedback on press", () => {
    const { getByTestId } = render(<HeaderAvatar />);
    fireEvent.click(getByTestId("header-avatar-pressable"));

    expect(mockSelectionAsync).toHaveBeenCalled();
    expect(mockRouterPush).toHaveBeenCalledWith("/settings");
  });
});
