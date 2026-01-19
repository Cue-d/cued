import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolArtifact } from "../tool-artifact";

// Mock the artifacts module
vi.mock("../artifacts", () => {
  const MockIcon = ({ className }: { className?: string }) => (
    <span data-testid="mock-icon" className={className}>Icon</span>
  );

  const mockSearchArtifact = {
    kind: "search_messages",
    description: "Search results",
    icon: MockIcon,
    emptyMessage: "No messages found",
    parse: (result: unknown) => {
      if (!result || typeof result !== "object") return null;
      const data = result as Record<string, unknown>;
      if (Array.isArray(data.results)) {
        return data.results;
      }
      return null;
    },
    content: ({ data }: { data: unknown[] }) => (
      <div data-testid="search-content">
        {data.map((item: any, i: number) => (
          <div key={i} data-testid="search-result">{item.content}</div>
        ))}
      </div>
    ),
    actions: [],
  };

  const mockContactsArtifact = {
    kind: "search_contacts",
    description: "Contacts",
    icon: MockIcon,
    emptyMessage: "No contacts found",
    parse: (result: unknown) => {
      if (!result || typeof result !== "object") return null;
      const data = result as Record<string, unknown>;
      if (Array.isArray(data.results)) {
        return data.results;
      }
      return null;
    },
    content: ({ data }: { data: unknown[] }) => (
      <div data-testid="contacts-content">
        {data.map((item: any, i: number) => (
          <div key={i} data-testid="contact-result">{item.displayName}</div>
        ))}
      </div>
    ),
    actions: [],
  };

  return {
    artifactDefinitions: [mockSearchArtifact, mockContactsArtifact],
    getArtifactByKind: (kind: string) => {
      if (kind === "search_messages") return mockSearchArtifact;
      if (kind === "search_contacts") return mockContactsArtifact;
      return null;
    },
    parseToolResult: (toolName: string, result: unknown) => {
      const artifact =
        toolName === "search_messages"
          ? mockSearchArtifact
          : toolName === "search_contacts"
            ? mockContactsArtifact
            : null;
      if (!artifact) return null;
      const data = artifact.parse(result);
      if (data === null) return null;
      return { kind: artifact.kind, data, artifact };
    },
  };
});

// Mock tooltip to simplify rendering
vi.mock("../../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));

describe("ToolArtifact", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("search messages artifact", () => {
    it("renders search results when valid data provided", () => {
      const result = {
        results: [
          { _id: "1", content: "Hello world", sentAt: Date.now(), platform: "imessage" },
          { _id: "2", content: "Test message", sentAt: Date.now(), platform: "gmail" },
        ],
      };

      render(<ToolArtifact toolName="search_messages" result={result} />);

      expect(screen.getByTestId("search-content")).toBeInTheDocument();
      expect(screen.getAllByTestId("search-result")).toHaveLength(2);
      expect(screen.getByText("Hello world")).toBeInTheDocument();
      expect(screen.getByText("Test message")).toBeInTheDocument();
    });

    it("renders empty state when no results", () => {
      const result = { results: [] };

      render(<ToolArtifact toolName="search_messages" result={result} />);

      expect(screen.getByText("No messages found")).toBeInTheDocument();
      expect(screen.queryByTestId("search-content")).not.toBeInTheDocument();
    });

    it("renders artifact header with icon and description", () => {
      const result = {
        results: [{ _id: "1", content: "Test", sentAt: Date.now(), platform: "imessage" }],
      };

      render(<ToolArtifact toolName="search_messages" result={result} />);

      expect(screen.getByTestId("mock-icon")).toBeInTheDocument();
    });
  });

  describe("contacts artifact", () => {
    it("renders contacts when valid data provided", () => {
      const result = {
        results: [
          { _id: "1", displayName: "John Doe", handles: [] },
          { _id: "2", displayName: "Jane Smith", handles: [] },
        ],
      };

      render(<ToolArtifact toolName="search_contacts" result={result} />);

      expect(screen.getByTestId("contacts-content")).toBeInTheDocument();
      expect(screen.getAllByTestId("contact-result")).toHaveLength(2);
      expect(screen.getByText("John Doe")).toBeInTheDocument();
      expect(screen.getByText("Jane Smith")).toBeInTheDocument();
    });

    it("renders empty state when no contacts", () => {
      const result = { results: [] };

      render(<ToolArtifact toolName="search_contacts" result={result} />);

      expect(screen.getByText("No contacts found")).toBeInTheDocument();
      expect(screen.queryByTestId("contacts-content")).not.toBeInTheDocument();
    });
  });

  describe("unknown tool names", () => {
    it("returns null for unknown tool name", () => {
      const { container } = render(
        <ToolArtifact toolName="unknown_tool" result={{ data: "test" }} />
      );

      expect(container.firstChild).toBeNull();
    });
  });

  describe("invalid results", () => {
    it("returns null for null result", () => {
      const { container } = render(
        <ToolArtifact toolName="search_messages" result={null} />
      );

      expect(container.firstChild).toBeNull();
    });

    it("returns null for undefined result", () => {
      const { container } = render(
        <ToolArtifact toolName="search_messages" result={undefined} />
      );

      expect(container.firstChild).toBeNull();
    });

    it("returns null when parse returns null", () => {
      const { container } = render(
        <ToolArtifact toolName="search_messages" result={{ invalid: "data" }} />
      );

      expect(container.firstChild).toBeNull();
    });
  });

  describe("styling", () => {
    it("applies custom className", () => {
      const result = {
        results: [{ _id: "1", content: "Test", sentAt: Date.now(), platform: "imessage" }],
      };

      const { container } = render(
        <ToolArtifact toolName="search_messages" result={result} className="custom-class" />
      );

      expect(container.firstChild).toHaveClass("custom-class");
    });
  });
});
