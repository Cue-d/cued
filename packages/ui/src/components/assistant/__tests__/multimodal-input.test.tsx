import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MultimodalInput, type Attachment } from "../multimodal-input";

// Mock motion/react to avoid animation issues
vi.mock("motion/react", () => ({
  motion: {
    div: ({
      children,
      className,
      style,
      animate,
      initial,
      transition,
      ...rest
    }: React.ComponentProps<"div"> & {
      animate?: unknown;
      initial?: unknown;
      transition?: unknown;
    }) => (
      <div className={className} style={style as React.CSSProperties} {...rest}>
        {children}
      </div>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock the sub-components to simplify testing
vi.mock("../prompt-input", () => ({
  PromptInput: ({
    children,
    onSubmit,
    className,
    style,
  }: {
    children: React.ReactNode;
    onSubmit?: (e: React.FormEvent) => void;
    className?: string;
    style?: React.CSSProperties;
  }) => (
    <form
      onSubmit={onSubmit}
      className={className}
      style={style}
      data-testid="prompt-input"
    >
      {children}
    </form>
  ),
  PromptInputTextarea: ({
    value,
    onChange,
    placeholder,
    ...props
  }: {
    value?: string;
    onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
    placeholder?: string;
    "data-testid"?: string;
    ref?: React.Ref<HTMLTextAreaElement>;
  }) => (
    <textarea
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      data-testid={props["data-testid"]}
    />
  ),
  PromptInputToolbar: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className} data-testid="toolbar">{children}</div>
  ),
  PromptInputTools: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className} data-testid="tools">{children}</div>
  ),
  PromptInputSubmit: ({
    children,
    disabled,
    isLoading,
    ...props
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    isLoading?: boolean;
    "data-testid"?: string;
    className?: string;
  }) => (
    <button type="submit" disabled={disabled} data-testid={props["data-testid"]}>
      {children}
    </button>
  ),
}));

// Mock preview attachment
vi.mock("../preview-attachment", () => ({
  PreviewAttachment: ({
    attachment,
    isUploading,
    onRemove,
  }: {
    attachment: Attachment;
    isUploading?: boolean;
    onRemove?: () => void;
  }) => (
    <div data-testid="preview-attachment" data-uploading={isUploading}>
      <span>{attachment.name}</span>
      {onRemove && (
        <button onClick={onRemove} data-testid="remove-attachment">
          Remove
        </button>
      )}
    </div>
  ),
}));

describe("MultimodalInput", () => {
  const defaultProps = {
    input: "",
    setInput: vi.fn(),
    onSubmit: vi.fn(),
    attachments: [] as Attachment[],
    setAttachments: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders textarea with placeholder", () => {
      render(<MultimodalInput {...defaultProps} />);
      expect(
        screen.getByPlaceholderText("Ask about your conversations...")
      ).toBeInTheDocument();
    });

    it("renders custom placeholder", () => {
      render(<MultimodalInput {...defaultProps} placeholder="Custom placeholder" />);
      expect(screen.getByPlaceholderText("Custom placeholder")).toBeInTheDocument();
    });

    it("renders send button", () => {
      render(<MultimodalInput {...defaultProps} />);
      expect(screen.getByTestId("send-button")).toBeInTheDocument();
    });

    it("renders attachments button", () => {
      render(<MultimodalInput {...defaultProps} />);
      expect(screen.getByTestId("attachments-button")).toBeInTheDocument();
    });

    it("applies custom className", () => {
      const { container } = render(
        <MultimodalInput {...defaultProps} className="custom-class" />
      );
      expect(container.firstChild).toHaveClass("custom-class");
    });
  });

  describe("input handling", () => {
    it("displays input value in textarea", () => {
      render(<MultimodalInput {...defaultProps} input="Test message" />);
      const textarea = screen.getByTestId("multimodal-input");
      expect(textarea).toHaveValue("Test message");
    });

    it("calls setInput when typing", () => {
      const setInput = vi.fn();
      render(<MultimodalInput {...defaultProps} setInput={setInput} />);

      const textarea = screen.getByTestId("multimodal-input");
      fireEvent.change(textarea, { target: { value: "Hello" } });

      expect(setInput).toHaveBeenCalledWith("Hello");
    });
  });

  describe("submit handling", () => {
    it("calls onSubmit when form submitted with text", () => {
      const onSubmit = vi.fn();
      render(<MultimodalInput {...defaultProps} input="Test" onSubmit={onSubmit} />);

      const form = screen.getByTestId("prompt-input");
      fireEvent.submit(form);

      expect(onSubmit).toHaveBeenCalled();
    });

    it("does not call onSubmit when form submitted without text or attachments", () => {
      const onSubmit = vi.fn();
      render(<MultimodalInput {...defaultProps} input="" onSubmit={onSubmit} />);

      const form = screen.getByTestId("prompt-input");
      fireEvent.submit(form);

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("calls onSubmit when form submitted with attachments but no text", () => {
      const onSubmit = vi.fn();
      const attachments: Attachment[] = [
        { url: "data:image/png;base64,test", name: "test.png", contentType: "image/png" },
      ];

      render(
        <MultimodalInput
          {...defaultProps}
          input=""
          attachments={attachments}
          onSubmit={onSubmit}
        />
      );

      const form = screen.getByTestId("prompt-input");
      fireEvent.submit(form);

      expect(onSubmit).toHaveBeenCalled();
    });
  });

  describe("attachments", () => {
    it("renders attachment previews when attachments provided", () => {
      const attachments: Attachment[] = [
        { url: "data:image/png;base64,test", name: "test.png", contentType: "image/png" },
      ];

      render(<MultimodalInput {...defaultProps} attachments={attachments} />);

      expect(screen.getByTestId("preview-attachment")).toBeInTheDocument();
      expect(screen.getByText("test.png")).toBeInTheDocument();
    });

    it("renders multiple attachment previews", () => {
      const attachments: Attachment[] = [
        { url: "data:image/png;base64,test1", name: "image1.png", contentType: "image/png" },
        { url: "data:image/jpeg;base64,test2", name: "image2.jpg", contentType: "image/jpeg" },
      ];

      render(<MultimodalInput {...defaultProps} attachments={attachments} />);

      expect(screen.getAllByTestId("preview-attachment")).toHaveLength(2);
    });

    it("calls setAttachments to remove attachment when remove button clicked", () => {
      const setAttachments = vi.fn();
      const attachments: Attachment[] = [
        { url: "data:image/png;base64,test", name: "test.png", contentType: "image/png" },
      ];

      render(
        <MultimodalInput
          {...defaultProps}
          attachments={attachments}
          setAttachments={setAttachments}
        />
      );

      const removeButton = screen.getByTestId("remove-attachment");
      fireEvent.click(removeButton);

      expect(setAttachments).toHaveBeenCalled();
    });

    it("shows attachments preview area when attachments exist", () => {
      const attachments: Attachment[] = [
        { url: "data:image/png;base64,test", name: "test.png", contentType: "image/png" },
      ];

      render(<MultimodalInput {...defaultProps} attachments={attachments} />);

      expect(screen.getByTestId("attachments-preview")).toBeInTheDocument();
    });
  });

  describe("file input", () => {
    it("opens file input when attachments button clicked", () => {
      render(<MultimodalInput {...defaultProps} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const clickSpy = vi.spyOn(fileInput, "click");

      const attachButton = screen.getByTestId("attachments-button");
      fireEvent.click(attachButton);

      expect(clickSpy).toHaveBeenCalled();
    });

    it("handles file selection", async () => {
      const setAttachments = vi.fn();
      render(<MultimodalInput {...defaultProps} setAttachments={setAttachments} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(["test"], "test.png", { type: "image/png" });

      // Mock FileReader
      const mockFileReader = {
        readAsDataURL: vi.fn(),
        result: "data:image/png;base64,dGVzdA==",
        onload: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      vi.spyOn(global, "FileReader").mockImplementation(() => mockFileReader as any);

      fireEvent.change(fileInput, { target: { files: [file] } });

      // Trigger the onload callback
      await waitFor(() => {
        if (mockFileReader.onload) {
          mockFileReader.onload();
        }
      });

      await waitFor(() => {
        expect(setAttachments).toHaveBeenCalled();
      });
    });

    it("accepts only images", () => {
      render(<MultimodalInput {...defaultProps} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toHaveAttribute("accept", "image/*");
    });

    it("allows multiple file selection", () => {
      render(<MultimodalInput {...defaultProps} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toHaveAttribute("multiple");
    });
  });

  describe("loading state", () => {
    it("shows stop button when submitting", () => {
      render(<MultimodalInput {...defaultProps} isSubmitting={true} onStop={vi.fn()} />);

      expect(screen.getByTestId("stop-button")).toBeInTheDocument();
    });

    it("calls onStop when stop button clicked", () => {
      const onStop = vi.fn();
      render(<MultimodalInput {...defaultProps} isSubmitting={true} onStop={onStop} />);

      const stopButton = screen.getByTestId("stop-button");
      fireEvent.click(stopButton);

      expect(onStop).toHaveBeenCalled();
    });

    it("disables attachments button when submitting", () => {
      render(<MultimodalInput {...defaultProps} isSubmitting={true} />);

      const attachButton = screen.getByTestId("attachments-button");
      expect(attachButton).toBeDisabled();
    });
  });

  describe("submit button state", () => {
    it("disables send button when no text and no attachments", () => {
      render(<MultimodalInput {...defaultProps} input="" attachments={[]} />);

      const sendButton = screen.getByTestId("send-button");
      expect(sendButton).toBeDisabled();
    });

    it("enables send button when has text", () => {
      render(<MultimodalInput {...defaultProps} input="Hello" />);

      const sendButton = screen.getByTestId("send-button");
      expect(sendButton).not.toBeDisabled();
    });

    it("enables send button when has attachments", () => {
      const attachments: Attachment[] = [
        { url: "data:image/png;base64,test", name: "test.png", contentType: "image/png" },
      ];

      render(<MultimodalInput {...defaultProps} input="" attachments={attachments} />);

      const sendButton = screen.getByTestId("send-button");
      expect(sendButton).not.toBeDisabled();
    });
  });
});
