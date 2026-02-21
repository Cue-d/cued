import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("expo-image", () => ({
  Image: ({
    onError,
    source,
  }: {
    onError?: () => void;
    source?: { uri?: string };
  }) => (
    <img
      data-testid="avatar-image"
      data-uri={source?.uri ?? ""}
      onError={onError}
    />
  ),
}));

import { ContactAvatar } from "../contact-avatar";

describe("ContactAvatar", () => {
  it("renders image when avatarUrl is provided", () => {
    render(
      <ContactAvatar initials="JD" avatarUrl="https://example.com/jd.jpg" size={40} />
    );

    expect(screen.getByTestId("avatar-image")).toBeDefined();
    expect(screen.queryByText("JD")).toBeNull();
  });

  it("falls back to initials when avatarUrl is missing", () => {
    render(<ContactAvatar initials="AB" avatarUrl={null} size={40} />);

    expect(screen.getByText("AB")).toBeDefined();
    expect(screen.queryByTestId("avatar-image")).toBeNull();
  });

  it("falls back to initials after image load error", () => {
    render(
      <ContactAvatar
        initials="XY"
        avatarUrl="https://example.com/broken.jpg"
        size={40}
      />
    );

    fireEvent.error(screen.getByTestId("avatar-image"));
    expect(screen.getByText("XY")).toBeDefined();
  });

  it("applies fallback style props", () => {
    render(
      <ContactAvatar
        initials="ZZ"
        avatarUrl={null}
        size={40}
        fallbackTextClassName="font-bold text-red-500"
        fallbackTextStyle={{ fontSize: 22 }}
      />
    );

    const initials = screen.getByText("ZZ");
    expect(initials.getAttribute("class")).toContain("font-bold");
    expect(initials.getAttribute("class")).toContain("text-red-500");
    expect(initials.getAttribute("style")).toContain("font-size: 22px");
  });
});
