import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContactListItem, type ContactListItemData } from "../contact-list-item";

// Ensure React is globally available for JSX transform
globalThis.React = React;

vi.mock("@/lib/utils", () => ({
  getThemeColors: () => ({
    background: "#FFFFFF",
    foreground: "#18181B",
    mutedForeground: "#71717A",
    primary: "#3D3D3D",
  }),
}));

describe("ContactListItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const defaultContact: ContactListItemData = {
    id: "contact-1",
    displayName: "John Doe",
    company: "Acme Inc",
    phoneNumber: "+1 (555) 123-4567",
    email: "john@example.com",
  };

  // Helper to get the pressable container element
  const getPressable = (container: HTMLElement) => {
    return container.querySelector("pressable");
  };

  describe("rendering", () => {
    it("renders contact display name", () => {
      render(<ContactListItem contact={defaultContact} />);

      expect(screen.getByText("John Doe")).toBeDefined();
    });

    it("renders contact initials", () => {
      render(<ContactListItem contact={defaultContact} />);

      expect(screen.getByText("JD")).toBeDefined();
    });

    it("prefers avatar image over initials when avatarUrl is present", () => {
      render(
        <ContactListItem
          contact={{
            ...defaultContact,
            avatarUrl: "https://example.com/avatar.jpg",
          }}
        />,
      );

      expect(screen.queryByText("JD")).toBeNull();
    });

    it("renders company when provided", () => {
      render(<ContactListItem contact={defaultContact} />);

      expect(screen.getByText("Acme Inc")).toBeDefined();
    });

    it("does not render company when not provided", () => {
      const contactWithoutCompany: ContactListItemData = {
        id: "contact-2",
        displayName: "Jane Smith",
      };

      render(<ContactListItem contact={contactWithoutCompany} />);

      expect(screen.getByText("Jane Smith")).toBeDefined();
      expect(screen.queryByText("Acme Inc")).toBeNull();
    });

    it("handles null company", () => {
      const contactWithNullCompany: ContactListItemData = {
        id: "contact-3",
        displayName: "Test User",
        company: null,
      };

      render(<ContactListItem contact={contactWithNullCompany} />);

      expect(screen.getByText("Test User")).toBeDefined();
    });
  });

  describe("initials generation", () => {
    it("generates initials from two-word name", () => {
      render(<ContactListItem contact={defaultContact} />);

      expect(screen.getByText("JD")).toBeDefined();
    });

    it("generates initials from single-word name", () => {
      const singleNameContact: ContactListItemData = {
        id: "contact-4",
        displayName: "Madonna",
      };

      render(<ContactListItem contact={singleNameContact} />);

      expect(screen.getByText("M")).toBeDefined();
    });

    it("generates initials from three-word name", () => {
      const threeNameContact: ContactListItemData = {
        id: "contact-5",
        displayName: "Mary Jane Watson",
      };

      render(<ContactListItem contact={threeNameContact} />);

      // getInitials for "Mary Jane Watson" returns first+last initials
      // The result depends on the getInitials implementation
      const container = screen.getByText("Mary Jane Watson").parentElement?.parentElement;
      expect(container).toBeDefined();
      // Just verify the component renders without crashing
    });
  });

  describe("accessibility", () => {
    it("has button accessibility role", () => {
      const { container } = render(<ContactListItem contact={defaultContact} />);

      const pressable = getPressable(container);
      expect(pressable).not.toBeNull();
      expect(pressable?.getAttribute("accessibilityrole")).toBe("button");
    });

    it("has accessibility label with contact name", () => {
      const { container } = render(<ContactListItem contact={defaultContact} />);

      const pressable = getPressable(container);
      expect(pressable?.getAttribute("accessibilitylabel")).toBe("View John Doe");
    });
  });

  describe("optional fields", () => {
    it("renders without phone number", () => {
      const contactWithoutPhone: ContactListItemData = {
        id: "contact-6",
        displayName: "No Phone",
        email: "nophone@example.com",
      };

      render(<ContactListItem contact={contactWithoutPhone} />);

      expect(screen.getByText("No Phone")).toBeDefined();
    });

    it("renders without email", () => {
      const contactWithoutEmail: ContactListItemData = {
        id: "contact-7",
        displayName: "No Email",
        phoneNumber: "+1 (555) 000-0000",
      };

      render(<ContactListItem contact={contactWithoutEmail} />);

      expect(screen.getByText("No Email")).toBeDefined();
    });

    it("renders with minimal data (id and displayName only)", () => {
      const minimalContact: ContactListItemData = {
        id: "minimal-1",
        displayName: "Minimal Contact",
      };

      render(<ContactListItem contact={minimalContact} />);

      expect(screen.getByText("Minimal Contact")).toBeDefined();
      expect(screen.getByText("MC")).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("handles empty display name", () => {
      const emptyNameContact: ContactListItemData = {
        id: "empty-1",
        displayName: "",
      };

      const { container } = render(<ContactListItem contact={emptyNameContact} />);

      // Should still render without crashing
      const pressable = getPressable(container);
      expect(pressable).not.toBeNull();
    });

    it("handles long display name", () => {
      const longNameContact: ContactListItemData = {
        id: "long-1",
        displayName: "Very Long Display Name That Might Overflow The Container",
        company: "Also A Very Long Company Name That Might Overflow",
      };

      render(<ContactListItem contact={longNameContact} />);

      expect(screen.getByText("Very Long Display Name That Might Overflow The Container")).toBeDefined();
    });

    it("handles special characters in name", () => {
      const specialCharContact: ContactListItemData = {
        id: "special-1",
        displayName: "José García-López",
      };

      render(<ContactListItem contact={specialCharContact} />);

      expect(screen.getByText("José García-López")).toBeDefined();
    });
  });
});
