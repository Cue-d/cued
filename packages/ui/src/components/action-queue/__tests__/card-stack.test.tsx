import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CardStack, type ActionItem } from "../CardStack";

// Mock motion/react to avoid animation issues in tests
vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, className, style, ...props }: React.ComponentProps<"div">) => (
      <div className={className} style={style as React.CSSProperties} {...props}>
        {children}
      </div>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("CardStack", () => {
  const mockActions: ActionItem[] = [
    { id: "action-1", type: "message_response" },
    { id: "action-2", type: "new_contact" },
    { id: "action-3", type: "message_response" },
  ];

  const defaultProps = {
    actions: mockActions,
    totalCount: 3,
    onSwipe: vi.fn().mockResolvedValue(undefined),
    renderCard: vi.fn((action: ActionItem, options: { isTop: boolean }) => (
      <div data-testid={`card-${action.id}`}>
        Card: {action.id} {options.isTop ? "(top)" : ""}
      </div>
    )),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders card count header", () => {
      render(<CardStack {...defaultProps} />);
      expect(screen.getByText("3 Left")).toBeInTheDocument();
    });

    it("renders action buttons", () => {
      render(<CardStack {...defaultProps} />);
      expect(screen.getByText("Discard")).toBeInTheDocument();
      expect(screen.getByText("Snooze")).toBeInTheDocument();
      expect(screen.getByText("Send")).toBeInTheDocument();
    });

    it("renders visible cards (max 3)", () => {
      render(<CardStack {...defaultProps} />);

      expect(screen.getByTestId("card-action-1")).toBeInTheDocument();
      expect(screen.getByTestId("card-action-2")).toBeInTheDocument();
      expect(screen.getByTestId("card-action-3")).toBeInTheDocument();
    });

    it("calls renderCard with correct isTop value", () => {
      render(<CardStack {...defaultProps} />);

      // renderCard is called for each visible card
      expect(defaultProps.renderCard).toHaveBeenCalledWith(
        mockActions[0],
        expect.objectContaining({ isTop: true })
      );
      expect(defaultProps.renderCard).toHaveBeenCalledWith(
        mockActions[1],
        expect.objectContaining({ isTop: false })
      );
      expect(defaultProps.renderCard).toHaveBeenCalledWith(
        mockActions[2],
        expect.objectContaining({ isTop: false })
      );
    });

    it("only renders top 3 cards when more than 3 actions", () => {
      const manyActions: ActionItem[] = [
        { id: "1", type: "message" },
        { id: "2", type: "message" },
        { id: "3", type: "message" },
        { id: "4", type: "message" },
        { id: "5", type: "message" },
      ];

      render(
        <CardStack
          {...defaultProps}
          actions={manyActions}
          totalCount={5}
        />
      );

      expect(screen.getByTestId("card-1")).toBeInTheDocument();
      expect(screen.getByTestId("card-2")).toBeInTheDocument();
      expect(screen.getByTestId("card-3")).toBeInTheDocument();
      expect(screen.queryByTestId("card-4")).not.toBeInTheDocument();
      expect(screen.queryByTestId("card-5")).not.toBeInTheDocument();
    });
  });

  describe("empty state", () => {
    it("renders default empty state when no actions", () => {
      render(<CardStack {...defaultProps} actions={[]} totalCount={0} />);

      expect(screen.getByText("All caught up!")).toBeInTheDocument();
      expect(screen.getByText("New actions will appear here.")).toBeInTheDocument();
    });

    it("renders custom empty state when provided", () => {
      render(
        <CardStack
          {...defaultProps}
          actions={[]}
          totalCount={0}
          emptyState={<div>Custom empty state</div>}
        />
      );

      expect(screen.getByText("Custom empty state")).toBeInTheDocument();
      expect(screen.queryByText("All caught up!")).not.toBeInTheDocument();
    });

    it("does not render action buttons in empty state", () => {
      render(<CardStack {...defaultProps} actions={[]} totalCount={0} />);

      expect(screen.queryByText("Discard")).not.toBeInTheDocument();
      expect(screen.queryByText("Snooze")).not.toBeInTheDocument();
      expect(screen.queryByText("Send")).not.toBeInTheDocument();
    });
  });

  describe("button interactions", () => {
    it("triggers left swipe when Discard button is clicked", async () => {
      const onSwipe = vi.fn().mockResolvedValue(undefined);
      render(<CardStack {...defaultProps} onSwipe={onSwipe} />);

      const discardButton = screen.getByText("Discard");
      fireEvent.click(discardButton);

      await waitFor(() => {
        expect(onSwipe).toHaveBeenCalledWith(
          "action-1",
          "left",
          undefined,
          undefined
        );
      });
    });

    it("triggers right swipe when Send button is clicked", async () => {
      const onSwipe = vi.fn().mockResolvedValue(undefined);
      render(<CardStack {...defaultProps} onSwipe={onSwipe} />);

      const sendButton = screen.getByText("Send");
      fireEvent.click(sendButton);

      await waitFor(() => {
        expect(onSwipe).toHaveBeenCalledWith(
          "action-1",
          "right",
          undefined,
          undefined
        );
      });
    });

    it("triggers up swipe with snooze time when Snooze button is clicked", async () => {
      const onSwipe = vi.fn().mockResolvedValue(undefined);
      render(<CardStack {...defaultProps} onSwipe={onSwipe} />);

      const snoozeButton = screen.getByText("Snooze");
      fireEvent.click(snoozeButton);

      await waitFor(() => {
        expect(onSwipe).toHaveBeenCalledWith(
          "action-1",
          "up",
          undefined,
          expect.any(Number) // snoozedUntil timestamp
        );
      });
    });
  });

  describe("keyboard navigation", () => {
    it("triggers left swipe on ArrowLeft key", async () => {
      const onSwipe = vi.fn().mockResolvedValue(undefined);
      render(<CardStack {...defaultProps} onSwipe={onSwipe} />);

      // Find the container (has tabIndex=0)
      const container = screen.getByText("3 Left").closest("[tabindex]");
      expect(container).not.toBeNull();

      fireEvent.keyDown(container!, { key: "ArrowLeft" });

      await waitFor(() => {
        expect(onSwipe).toHaveBeenCalledWith(
          "action-1",
          "left",
          undefined,
          undefined
        );
      });
    });

    it("triggers right swipe on ArrowRight key", async () => {
      const onSwipe = vi.fn().mockResolvedValue(undefined);
      render(<CardStack {...defaultProps} onSwipe={onSwipe} />);

      const container = screen.getByText("3 Left").closest("[tabindex]");
      fireEvent.keyDown(container!, { key: "ArrowRight" });

      await waitFor(() => {
        expect(onSwipe).toHaveBeenCalledWith(
          "action-1",
          "right",
          undefined,
          undefined
        );
      });
    });

    it("triggers up swipe on ArrowUp key", async () => {
      const onSwipe = vi.fn().mockResolvedValue(undefined);
      render(<CardStack {...defaultProps} onSwipe={onSwipe} />);

      const container = screen.getByText("3 Left").closest("[tabindex]");
      fireEvent.keyDown(container!, { key: "ArrowUp" });

      await waitFor(() => {
        expect(onSwipe).toHaveBeenCalledWith(
          "action-1",
          "up",
          undefined,
          expect.any(Number)
        );
      });
    });

    it("ignores keyboard events when typing in input", async () => {
      const onSwipe = vi.fn().mockResolvedValue(undefined);
      const renderCardWithInput = (action: ActionItem) => (
        <div>
          <input data-testid={`input-${action.id}`} />
        </div>
      );

      render(
        <CardStack
          {...defaultProps}
          onSwipe={onSwipe}
          renderCard={renderCardWithInput}
        />
      );

      const input = screen.getByTestId("input-action-1");
      fireEvent.keyDown(input, { key: "ArrowLeft" });

      // Should not trigger swipe when typing
      await new Promise((r) => setTimeout(r, 250));
      expect(onSwipe).not.toHaveBeenCalled();
    });
  });

  describe("response text handling", () => {
    it("passes response text to onSwipe", async () => {
      const onSwipe = vi.fn().mockResolvedValue(undefined);
      const responseChangeRef: { current: ((text: string) => void) | null } = { current: null };

      const renderCardCapture = (
        action: ActionItem,
        options: { onResponseChange: (text: string) => void }
      ) => {
        if (action.id === "action-1") {
          responseChangeRef.current = options.onResponseChange;
        }
        return <div data-testid={`card-${action.id}`} />;
      };

      render(
        <CardStack
          {...defaultProps}
          onSwipe={onSwipe}
          renderCard={renderCardCapture}
        />
      );

      // Simulate typing a response
      if (responseChangeRef.current) {
        responseChangeRef.current("Hello, world!");
      }

      // Trigger send
      const sendButton = screen.getByText("Send");
      fireEvent.click(sendButton);

      await waitFor(() => {
        expect(onSwipe).toHaveBeenCalledWith(
          "action-1",
          "right",
          "Hello, world!",
          undefined
        );
      });
    });
  });
});
