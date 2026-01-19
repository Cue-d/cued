import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SwipeableCard } from "../swipeable-card";

// Mock motion/react
vi.mock("motion/react", () => ({
  motion: {
    div: ({
      children,
      className,
      style,
      onPointerDown,
      onPointerUp,
      onPointerCancel,
      onDragEnd,
      drag,
      ...rest
    }: React.ComponentProps<"div"> & {
      drag?: boolean;
      onDragEnd?: (e: unknown, info: { offset: { x: number; y: number }; velocity: { x: number; y: number } }) => void;
    }) => (
      <div
        className={className}
        style={style as React.CSSProperties}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        data-drag-enabled={drag}
        {...rest}
      >
        {children}
      </div>
    ),
  },
  useMotionValue: (initial: number) => ({
    get: () => initial,
    set: vi.fn(),
  }),
  useTransform: () => 1,
  animate: vi.fn(),
}));

describe("SwipeableCard", () => {
  const defaultProps = {
    children: <div data-testid="card-content">Card Content</div>,
    onSwipe: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders children content", () => {
      render(<SwipeableCard {...defaultProps} />);
      expect(screen.getByTestId("card-content")).toBeInTheDocument();
      expect(screen.getByText("Card Content")).toBeInTheDocument();
    });

    it("applies custom className", () => {
      const { container } = render(
        <SwipeableCard {...defaultProps} className="custom-class" />
      );
      const cardWrapper = container.firstChild;
      expect(cardWrapper).toHaveClass("custom-class");
    });

    it("renders swipe overlays", () => {
      render(<SwipeableCard {...defaultProps} />);

      // Overlays contain action labels
      expect(screen.getByText("Send")).toBeInTheDocument();
      expect(screen.getByText("Discard")).toBeInTheDocument();
      expect(screen.getByText("Snooze")).toBeInTheDocument();
    });
  });

  describe("drag state", () => {
    it("enables drag by default", () => {
      const { container } = render(<SwipeableCard {...defaultProps} />);
      const cardWrapper = container.firstChild;
      expect(cardWrapper).toHaveAttribute("data-drag-enabled", "true");
    });

    it("disables drag when disabled prop is true", () => {
      const { container } = render(
        <SwipeableCard {...defaultProps} disabled={true} />
      );
      const cardWrapper = container.firstChild;
      expect(cardWrapper).toHaveAttribute("data-drag-enabled", "false");
    });
  });

  describe("gesture callbacks", () => {
    // Note: Full gesture testing would require more sophisticated mocking
    // of motion/react's drag behavior. These tests verify the component
    // structure and callback setup.

    it("does not call onSwipe on initial render", () => {
      render(<SwipeableCard {...defaultProps} />);
      expect(defaultProps.onSwipe).not.toHaveBeenCalled();
    });

    it("accepts triggerSwipe prop without error", () => {
      expect(() => {
        render(<SwipeableCard {...defaultProps} triggerSwipe="right" />);
      }).not.toThrow();
    });

    it("accepts triggerSwipe prop for left direction", () => {
      expect(() => {
        render(<SwipeableCard {...defaultProps} triggerSwipe="left" />);
      }).not.toThrow();
    });

    it("accepts triggerSwipe prop for up direction", () => {
      expect(() => {
        render(<SwipeableCard {...defaultProps} triggerSwipe="up" />);
      }).not.toThrow();
    });

    it("handles null triggerSwipe prop", () => {
      expect(() => {
        render(<SwipeableCard {...defaultProps} triggerSwipe={null} />);
      }).not.toThrow();
    });
  });

  describe("text selection behavior", () => {
    it("renders with data-selectable areas when children contain them", () => {
      render(
        <SwipeableCard {...defaultProps}>
          <div data-selectable="true">Selectable text</div>
        </SwipeableCard>
      );

      expect(screen.getByText("Selectable text")).toBeInTheDocument();
    });
  });

  describe("visual feedback", () => {
    // These tests verify the overlay elements exist for visual feedback

    it("has right swipe overlay with send icon", () => {
      render(<SwipeableCard {...defaultProps} />);
      // The Send text is inside the right overlay
      const sendText = screen.getByText("Send");
      expect(sendText).toBeInTheDocument();
    });

    it("has left swipe overlay with discard icon", () => {
      render(<SwipeableCard {...defaultProps} />);
      const discardText = screen.getByText("Discard");
      expect(discardText).toBeInTheDocument();
    });

    it("has up swipe overlay with snooze icon", () => {
      render(<SwipeableCard {...defaultProps} />);
      const snoozeText = screen.getByText("Snooze");
      expect(snoozeText).toBeInTheDocument();
    });
  });
});
