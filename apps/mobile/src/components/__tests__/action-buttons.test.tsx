import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

// Ensure React is globally available for JSX transform
globalThis.React = React;

vi.mock("@/lib/utils", () => ({
  cn: (...inputs: string[]) => inputs.filter(Boolean).join(" "),
}));

import { ActionButtons } from "../action-buttons";

describe("ActionButtons", () => {
  const mockOnSwipe = vi.fn();

  // Helper to get pressable elements
  const getPressables = (container: HTMLElement) => {
    return container.querySelectorAll("pressable");
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders skip button with default label", () => {
      render(<ActionButtons onSwipe={mockOnSwipe} />);

      expect(screen.getByText("Skip")).toBeDefined();
    });

    it("renders send button with default label", () => {
      render(<ActionButtons onSwipe={mockOnSwipe} />);

      expect(screen.getByText("Send")).toBeDefined();
    });

    it("renders custom skip label", () => {
      render(<ActionButtons onSwipe={mockOnSwipe} skipLabel="Dismiss" />);

      expect(screen.getByText("Dismiss")).toBeDefined();
      expect(screen.queryByText("Skip")).toBeNull();
    });

    it("renders custom send label", () => {
      render(<ActionButtons onSwipe={mockOnSwipe} sendLabel="Approve" />);

      expect(screen.getByText("Approve")).toBeDefined();
      expect(screen.queryByText("Send")).toBeNull();
    });

    it("renders three pressable buttons (skip, snooze, send)", () => {
      const { container } = render(<ActionButtons onSwipe={mockOnSwipe} />);

      const pressables = getPressables(container);
      // Should have 3 buttons: skip, snooze, send
      expect(pressables.length).toBe(3);
    });
  });

  describe("button structure", () => {
    it("skip button is first pressable", () => {
      const { container } = render(<ActionButtons onSwipe={mockOnSwipe} />);

      const pressables = getPressables(container);
      // Skip button should contain "Skip" text
      expect(pressables[0].textContent).toContain("Skip");
    });

    it("send button is last pressable", () => {
      const { container } = render(<ActionButtons onSwipe={mockOnSwipe} />);

      const pressables = getPressables(container);
      // Send button should contain "Send" text
      expect(pressables[2].textContent).toContain("Send");
    });

    it("middle button is snooze (clock icon)", () => {
      const { container } = render(<ActionButtons onSwipe={mockOnSwipe} />);

      const pressables = getPressables(container);
      // Snooze button should be in the middle (index 1)
      // It doesn't have text, just an icon - verify it exists
      expect(pressables[1]).toBeDefined();
    });
  });

  describe("disabled state", () => {
    it("renders with disabled=false by default", () => {
      render(<ActionButtons onSwipe={mockOnSwipe} />);

      // Buttons should render
      expect(screen.getByText("Skip")).toBeDefined();
      expect(screen.getByText("Send")).toBeDefined();
    });

    it("accepts disabled prop", () => {
      render(<ActionButtons onSwipe={mockOnSwipe} disabled />);

      // Component should still render
      expect(screen.getByText("Skip")).toBeDefined();
      expect(screen.getByText("Send")).toBeDefined();
    });

    it("applies opacity to disabled buttons", () => {
      const { container } = render(<ActionButtons onSwipe={mockOnSwipe} disabled />);

      const pressables = getPressables(container);
      // Disabled buttons should have opacity style
      pressables.forEach((pressable) => {
        const style = pressable.getAttribute("style");
        expect(style).toContain("opacity");
      });
    });
  });

  describe("custom labels", () => {
    it("renders with both custom labels", () => {
      render(
        <ActionButtons
          onSwipe={mockOnSwipe}
          skipLabel="Reject"
          sendLabel="Accept"
        />
      );

      expect(screen.getByText("Reject")).toBeDefined();
      expect(screen.getByText("Accept")).toBeDefined();
      expect(screen.queryByText("Skip")).toBeNull();
      expect(screen.queryByText("Send")).toBeNull();
    });

    it("maintains button order with custom labels", () => {
      const { container } = render(
        <ActionButtons
          onSwipe={mockOnSwipe}
          skipLabel="No"
          sendLabel="Yes"
        />
      );

      const pressables = getPressables(container);
      expect(pressables[0].textContent).toContain("No");
      expect(pressables[2].textContent).toContain("Yes");
    });
  });

  describe("component structure", () => {
    it("renders in a row layout", () => {
      const { container } = render(<ActionButtons onSwipe={mockOnSwipe} />);

      // Find the container View
      const viewElement = container.querySelector("view");
      expect(viewElement).not.toBeNull();
      expect(viewElement?.className).toContain("flex-row");
    });

    it("has gap between buttons", () => {
      const { container } = render(<ActionButtons onSwipe={mockOnSwipe} />);

      const viewElement = container.querySelector("view");
      expect(viewElement?.className).toContain("gap-3");
    });
  });
});
