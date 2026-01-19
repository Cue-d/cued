import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatInput } from "../chat-input";

describe("ChatInput", () => {
  const defaultProps = {
    value: "",
    onChange: vi.fn(),
    onSubmit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders textarea with placeholder", () => {
      render(<ChatInput {...defaultProps} />);
      expect(
        screen.getByPlaceholderText("Ask about your conversations...")
      ).toBeInTheDocument();
    });

    it("renders custom placeholder", () => {
      render(<ChatInput {...defaultProps} placeholder="Custom placeholder" />);
      expect(screen.getByPlaceholderText("Custom placeholder")).toBeInTheDocument();
    });

    it("renders send button", () => {
      render(<ChatInput {...defaultProps} />);
      expect(screen.getByRole("button")).toBeInTheDocument();
    });

    it("renders helper text about Enter key", () => {
      render(<ChatInput {...defaultProps} />);
      expect(
        screen.getByText(/Press Enter to send, Shift\+Enter for new line/i)
      ).toBeInTheDocument();
    });

    it("applies custom className", () => {
      const { container } = render(
        <ChatInput {...defaultProps} className="custom-class" />
      );
      expect(container.firstChild).toHaveClass("custom-class");
    });
  });

  describe("input handling", () => {
    it("displays value in textarea", () => {
      render(<ChatInput {...defaultProps} value="Test message" />);
      const textarea = screen.getByPlaceholderText("Ask about your conversations...");
      expect(textarea).toHaveValue("Test message");
    });

    it("calls onChange when typing", () => {
      const onChange = vi.fn();
      render(<ChatInput {...defaultProps} onChange={onChange} />);

      const textarea = screen.getByPlaceholderText("Ask about your conversations...");
      fireEvent.change(textarea, { target: { value: "Hello" } });

      expect(onChange).toHaveBeenCalledWith("Hello");
    });

    it("disables textarea when disabled prop is true", () => {
      render(<ChatInput {...defaultProps} disabled={true} />);
      const textarea = screen.getByPlaceholderText("Ask about your conversations...");
      expect(textarea).toBeDisabled();
    });
  });

  describe("submit handling", () => {
    it("calls onSubmit when Enter pressed with text", () => {
      const onSubmit = vi.fn();
      render(<ChatInput {...defaultProps} value="Test" onSubmit={onSubmit} />);

      const textarea = screen.getByPlaceholderText("Ask about your conversations...");
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

      expect(onSubmit).toHaveBeenCalled();
    });

    it("does not call onSubmit when Enter pressed with empty text", () => {
      const onSubmit = vi.fn();
      render(<ChatInput {...defaultProps} value="" onSubmit={onSubmit} />);

      const textarea = screen.getByPlaceholderText("Ask about your conversations...");
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("does not call onSubmit when Enter pressed with only whitespace", () => {
      const onSubmit = vi.fn();
      render(<ChatInput {...defaultProps} value="   " onSubmit={onSubmit} />);

      const textarea = screen.getByPlaceholderText("Ask about your conversations...");
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("does not call onSubmit when Shift+Enter pressed", () => {
      const onSubmit = vi.fn();
      render(<ChatInput {...defaultProps} value="Test" onSubmit={onSubmit} />);

      const textarea = screen.getByPlaceholderText("Ask about your conversations...");
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("does not call onSubmit when disabled", () => {
      const onSubmit = vi.fn();
      render(<ChatInput {...defaultProps} value="Test" onSubmit={onSubmit} disabled={true} />);

      const textarea = screen.getByPlaceholderText("Ask about your conversations...");
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("does not call onSubmit when loading", () => {
      const onSubmit = vi.fn();
      render(<ChatInput {...defaultProps} value="Test" onSubmit={onSubmit} isLoading={true} />);

      const textarea = screen.getByPlaceholderText("Ask about your conversations...");
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("calls onSubmit when button clicked with text", () => {
      const onSubmit = vi.fn();
      render(<ChatInput {...defaultProps} value="Test" onSubmit={onSubmit} />);

      const button = screen.getByRole("button");
      fireEvent.click(button);

      expect(onSubmit).toHaveBeenCalled();
    });

    it("does not call onSubmit when button clicked without text", () => {
      const onSubmit = vi.fn();
      render(<ChatInput {...defaultProps} value="" onSubmit={onSubmit} />);

      const button = screen.getByRole("button");
      fireEvent.click(button);

      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe("loading state", () => {
    it("shows stop button when loading", () => {
      const onStop = vi.fn();
      render(<ChatInput {...defaultProps} isLoading={true} onStop={onStop} />);

      // Button should have destructive variant class when loading
      const button = screen.getByRole("button");
      expect(button).toHaveClass("animate-pulse");
    });

    it("calls onStop when stop button clicked during loading", () => {
      const onStop = vi.fn();
      render(<ChatInput {...defaultProps} isLoading={true} onStop={onStop} />);

      const button = screen.getByRole("button");
      fireEvent.click(button);

      expect(onStop).toHaveBeenCalled();
    });
  });

  describe("button state", () => {
    it("disables button when empty and not loading", () => {
      render(<ChatInput {...defaultProps} value="" />);
      const button = screen.getByRole("button");
      expect(button).toBeDisabled();
    });

    it("enables button when has text", () => {
      render(<ChatInput {...defaultProps} value="Test" />);
      const button = screen.getByRole("button");
      expect(button).not.toBeDisabled();
    });

    it("enables button when loading (for stop action)", () => {
      render(<ChatInput {...defaultProps} value="" isLoading={true} onStop={vi.fn()} />);
      const button = screen.getByRole("button");
      expect(button).not.toBeDisabled();
    });

    it("disables button when disabled prop is true", () => {
      render(<ChatInput {...defaultProps} value="Test" disabled={true} />);
      const button = screen.getByRole("button");
      expect(button).toBeDisabled();
    });
  });
});
