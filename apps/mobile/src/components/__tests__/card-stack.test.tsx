import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CardStack, type CardStackItem } from "../card-stack";

// Ensure React is globally available for JSX transform
globalThis.React = React;

// Mock components before importing
vi.mock("@/components/animated", () => ({
  AnimatedView: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "animated-view", ...props }, children),
}));

vi.mock("@/lib/utils", () => ({
  getThemeColors: () => ({
    background: "#FFFFFF",
    foreground: "#18181B",
    mutedForeground: "#71717A",
    primary: "#3D3D3D",
  }),
}));

vi.mock("../swipeable-card", () => ({
  SwipeableCard: ({ children, onSwipe, disabled, triggerSwipe, className }: {
    children?: React.ReactNode;
    onSwipe: (dir: string) => void;
    disabled?: boolean;
    triggerSwipe?: string | null;
    className?: string;
  }) =>
    React.createElement(
      "div",
      {
        "data-testid": "swipeable-card",
        "data-disabled": disabled,
        "data-trigger-swipe": triggerSwipe,
        className,
      },
      children
    ),
}));

interface TestAction extends CardStackItem {
  id: string;
  title: string;
}

describe("CardStack", () => {
  const mockOnSwipe = vi.fn();
  const mockRenderCard = vi.fn((item: TestAction, index: number) => (
    <div data-testid={`card-${item.id}`} data-index={index}>
      {item.title}
    </div>
  ));

  const defaultActions: TestAction[] = [
    { id: "1", title: "Action 1" },
    { id: "2", title: "Action 2" },
    { id: "3", title: "Action 3" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockRenderCard.mockClear();
    mockRenderCard.mockImplementation((item: TestAction, index: number) => (
      <div data-testid={`card-${item.id}`} data-index={index}>
        {item.title}
      </div>
    ));
  });

  describe("empty state", () => {
    it("renders empty state when no actions", () => {
      render(
        <CardStack
          actions={[]}
          totalCount={0}
          onSwipe={mockOnSwipe}
          renderCard={mockRenderCard}
        />
      );

      expect(screen.getByText("All caught up!")).toBeDefined();
      expect(screen.getByText("New actions will appear here")).toBeDefined();
    });

    it("does not render any cards when empty", () => {
      render(
        <CardStack
          actions={[]}
          totalCount={0}
          onSwipe={mockOnSwipe}
          renderCard={mockRenderCard}
        />
      );

      expect(screen.queryByTestId("swipeable-card")).toBeNull();
      expect(mockRenderCard).not.toHaveBeenCalled();
    });
  });

  describe("rendering cards", () => {
    it("renders visible cards (max 2)", () => {
      render(
        <CardStack
          actions={defaultActions}
          totalCount={3}
          onSwipe={mockOnSwipe}
          renderCard={mockRenderCard}
        />
      );

      expect(screen.getByTestId("card-1")).toBeDefined();
      expect(screen.getByTestId("card-2")).toBeDefined();
      expect(screen.queryByTestId("card-3")).toBeNull();
    });

    it("renders maximum 2 visible cards even with more actions", () => {
      const manyActions: TestAction[] = [
        { id: "1", title: "Action 1" },
        { id: "2", title: "Action 2" },
        { id: "3", title: "Action 3" },
        { id: "4", title: "Action 4" },
        { id: "5", title: "Action 5" },
      ];

      render(
        <CardStack
          actions={manyActions}
          totalCount={5}
          onSwipe={mockOnSwipe}
          renderCard={mockRenderCard}
        />
      );

      expect(screen.getByTestId("card-1")).toBeDefined();
      expect(screen.getByTestId("card-2")).toBeDefined();
      expect(screen.queryByTestId("card-3")).toBeNull();
    });

    it("renders less than 2 cards if fewer available", () => {
      const fewActions: TestAction[] = [
        { id: "1", title: "Action 1" },
      ];

      render(
        <CardStack
          actions={fewActions}
          totalCount={1}
          onSwipe={mockOnSwipe}
          renderCard={mockRenderCard}
        />
      );

      expect(screen.getByTestId("card-1")).toBeDefined();
      expect(screen.queryByTestId("card-2")).toBeNull();
    });

    it("calls renderCard with correct arguments", () => {
      render(
        <CardStack
          actions={defaultActions}
          totalCount={3}
          onSwipe={mockOnSwipe}
          renderCard={mockRenderCard}
        />
      );

      expect(mockRenderCard).toHaveBeenCalledTimes(2);
      expect(mockRenderCard).toHaveBeenCalledWith(defaultActions[0], 0);
      expect(mockRenderCard).toHaveBeenCalledWith(defaultActions[1], 1);
    });
  });

  describe("top card interactivity", () => {
    it("only top card is interactive (disabled=false)", () => {
      render(
        <CardStack
          actions={defaultActions}
          totalCount={3}
          onSwipe={mockOnSwipe}
          renderCard={mockRenderCard}
        />
      );

      const cards = screen.getAllByTestId("swipeable-card");
      // First card should not be disabled (top card)
      expect(cards[0].getAttribute("data-disabled")).toBe("false");
    });

    it("non-top cards are disabled", () => {
      render(
        <CardStack
          actions={defaultActions}
          totalCount={3}
          onSwipe={mockOnSwipe}
          renderCard={mockRenderCard}
        />
      );

      const cards = screen.getAllByTestId("swipeable-card");
      // Second card should be disabled
      expect(cards[1].getAttribute("data-disabled")).toBe("true");
    });
  });

  describe("triggerSwipe prop", () => {
    it("passes triggerSwipe to top card only", () => {
      render(
        <CardStack
          actions={defaultActions}
          totalCount={3}
          onSwipe={mockOnSwipe}
          renderCard={mockRenderCard}
          triggerSwipe="right"
        />
      );

      const cards = screen.getAllByTestId("swipeable-card");
      expect(cards[0].getAttribute("data-trigger-swipe")).toBe("right");
      // Non-top cards get null, which getAttribute returns as null (not "null")
      expect(cards[1].getAttribute("data-trigger-swipe")).toBeNull();
    });

    it("passes null triggerSwipe when not provided", () => {
      render(
        <CardStack
          actions={defaultActions}
          totalCount={3}
          onSwipe={mockOnSwipe}
          renderCard={mockRenderCard}
        />
      );

      const cards = screen.getAllByTestId("swipeable-card");
      // triggerSwipe is undefined when not passed, getAttribute returns null for undefined
      expect(cards[1].getAttribute("data-trigger-swipe")).toBeNull();
    });
  });

  describe("single action", () => {
    it("renders single action correctly", () => {
      const singleAction: TestAction[] = [{ id: "1", title: "Only Action" }];

      render(
        <CardStack
          actions={singleAction}
          totalCount={1}
          onSwipe={mockOnSwipe}
          renderCard={mockRenderCard}
        />
      );

      expect(screen.getByTestId("card-1")).toBeDefined();
      expect(screen.getByText("Only Action")).toBeDefined();
      expect(screen.queryByText("All caught up!")).toBeNull();
    });
  });

  describe("card styling", () => {
    it("applies className to swipeable cards", () => {
      render(
        <CardStack
          actions={defaultActions}
          totalCount={3}
          onSwipe={mockOnSwipe}
          renderCard={mockRenderCard}
        />
      );

      const cards = screen.getAllByTestId("swipeable-card");
      cards.forEach((card) => {
        expect(card.className).toContain("w-full h-full");
      });
    });
  });
});
