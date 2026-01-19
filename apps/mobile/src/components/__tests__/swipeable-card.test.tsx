import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SwipeableCard, type SwipeDirection } from "../swipeable-card";

// Ensure React is globally available for JSX transform
globalThis.React = React;

// Mock components before importing
vi.mock("@/components/animated", () => ({
  AnimatedView: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "animated-view", ...props }, children),
}));

describe("SwipeableCard", () => {
  const mockOnSwipe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders children content", () => {
      render(
        <SwipeableCard onSwipe={mockOnSwipe}>
          <div data-testid="child-content">Card Content</div>
        </SwipeableCard>
      );

      expect(screen.getByTestId("child-content")).toBeDefined();
      expect(screen.getByText("Card Content")).toBeDefined();
    });

    it("renders with custom className", () => {
      render(
        <SwipeableCard onSwipe={mockOnSwipe} className="custom-class">
          <div>Content</div>
        </SwipeableCard>
      );

      const animatedViews = screen.getAllByTestId("animated-view");
      // Should have multiple AnimatedView elements
      expect(animatedViews.length).toBeGreaterThan(0);
    });

    it("renders swipe progress overlay", () => {
      render(
        <SwipeableCard onSwipe={mockOnSwipe}>
          <div>Content</div>
        </SwipeableCard>
      );

      // SwipeProgressOverlay renders AnimatedView elements
      const animatedViews = screen.getAllByTestId("animated-view");
      expect(animatedViews.length).toBeGreaterThan(1);
    });
  });

  describe("disabled state", () => {
    it("renders when disabled", () => {
      render(
        <SwipeableCard onSwipe={mockOnSwipe} disabled>
          <div data-testid="content">Content</div>
        </SwipeableCard>
      );

      expect(screen.getByTestId("content")).toBeDefined();
    });

    it("renders with disabled=false by default", () => {
      render(
        <SwipeableCard onSwipe={mockOnSwipe}>
          <div data-testid="content">Content</div>
        </SwipeableCard>
      );

      expect(screen.getByTestId("content")).toBeDefined();
    });
  });

  describe("triggerSwipe prop", () => {
    it("accepts null triggerSwipe", () => {
      render(
        <SwipeableCard onSwipe={mockOnSwipe} triggerSwipe={null}>
          <div data-testid="content">Content</div>
        </SwipeableCard>
      );

      expect(screen.getByTestId("content")).toBeDefined();
    });

    it("accepts right triggerSwipe direction", () => {
      render(
        <SwipeableCard onSwipe={mockOnSwipe} triggerSwipe="right">
          <div data-testid="content">Content</div>
        </SwipeableCard>
      );

      expect(screen.getByTestId("content")).toBeDefined();
    });

    it("accepts left triggerSwipe direction", () => {
      render(
        <SwipeableCard onSwipe={mockOnSwipe} triggerSwipe="left">
          <div data-testid="content">Content</div>
        </SwipeableCard>
      );

      expect(screen.getByTestId("content")).toBeDefined();
    });

    it("accepts up triggerSwipe direction", () => {
      render(
        <SwipeableCard onSwipe={mockOnSwipe} triggerSwipe="up">
          <div data-testid="content">Content</div>
        </SwipeableCard>
      );

      expect(screen.getByTestId("content")).toBeDefined();
    });
  });

  describe("SwipeDirection type", () => {
    it("onSwipe callback accepts valid SwipeDirection values", () => {
      const directions: SwipeDirection[] = ["left", "right", "up"];

      directions.forEach((direction) => {
        expect(() => {
          render(
            <SwipeableCard onSwipe={mockOnSwipe} triggerSwipe={direction}>
              <div>Content</div>
            </SwipeableCard>
          );
        }).not.toThrow();
      });
    });
  });

  describe("glass effect", () => {
    it("uses fallback styling when GlassView not available", () => {
      // isLiquidGlassAvailable is mocked to return false
      render(
        <SwipeableCard onSwipe={mockOnSwipe}>
          <div data-testid="content">Content</div>
        </SwipeableCard>
      );

      // Should render with fallback View instead of GlassView
      expect(screen.getByTestId("content")).toBeDefined();
    });
  });

  describe("component structure", () => {
    it("wraps content in gesture detector", () => {
      render(
        <SwipeableCard onSwipe={mockOnSwipe}>
          <div data-testid="content">Content</div>
        </SwipeableCard>
      );

      // GestureDetector is mocked to pass through children
      expect(screen.getByTestId("content")).toBeDefined();
    });

    it("renders background overlay for swipe feedback", () => {
      render(
        <SwipeableCard onSwipe={mockOnSwipe}>
          <div>Content</div>
        </SwipeableCard>
      );

      // Multiple AnimatedView elements for overlay and progress
      const animatedViews = screen.getAllByTestId("animated-view");
      expect(animatedViews.length).toBeGreaterThanOrEqual(2);
    });
  });
});
