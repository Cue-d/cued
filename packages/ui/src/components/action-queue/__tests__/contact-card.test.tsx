import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { type ContactFormData } from "@cued/shared";
import { ContactCard, type ExistingContact } from "../contact-card";

describe("ContactCard", () => {
  const defaultFormData: ContactFormData = {
    name: "",
    company: "",
    tags: "",
    notes: "",
  };

  const defaultProps = {
    personName: "Jane Smith",
    formData: defaultFormData,
    onFormChange: vi.fn(),
    autoFocus: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders person name in header", () => {
    render(<ContactCard {...defaultProps} />);
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();
  });

  it("renders initials in avatar", () => {
    render(<ContactCard {...defaultProps} />);
    expect(screen.getByText("JS")).toBeInTheDocument();
  });

  it("renders prompt text", () => {
    render(<ContactCard {...defaultProps} />);
    expect(
      screen.getByText("What do you remember about them?")
    ).toBeInTheDocument();
  });

  it("renders notes textarea immediately visible", () => {
    render(<ContactCard {...defaultProps} />);
    expect(
      screen.getByPlaceholderText(/Where you met/)
    ).toBeInTheDocument();
  });

  it("shows detail fields after expanding", () => {
    render(<ContactCard {...defaultProps} />);

    // Company/Tags should not be visible initially
    expect(
      screen.queryByPlaceholderText("Where do they work?")
    ).not.toBeInTheDocument();

    // Click "Add details" to expand
    fireEvent.click(screen.getByText("Add details"));

    expect(
      screen.getByPlaceholderText("Where do they work?")
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/work, friend, investor/)
    ).toBeInTheDocument();
  });

  it("displays form data values", () => {
    const formData: ContactFormData = {
      name: "John Doe",
      company: "Acme Inc",
      tags: "investor, friend",
      notes: "Met at conference",
    };

    // When company/tags have values, details section auto-expands
    render(<ContactCard {...defaultProps} formData={formData} />);

    expect(screen.getByDisplayValue("Met at conference")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Acme Inc")).toBeInTheDocument();
    expect(screen.getByDisplayValue("investor, friend")).toBeInTheDocument();
  });

  describe("form interactions", () => {
    it("calls onFormChange when notes textarea changes", () => {
      const onFormChange = vi.fn();
      render(<ContactCard {...defaultProps} onFormChange={onFormChange} />);

      const notesTextarea = screen.getByPlaceholderText(/Where you met/);
      fireEvent.change(notesTextarea, { target: { value: "Met at lunch" } });

      expect(onFormChange).toHaveBeenCalledWith({
        ...defaultFormData,
        notes: "Met at lunch",
      });
    });

    it("calls onFormChange when company input changes", () => {
      const onFormChange = vi.fn();
      render(<ContactCard {...defaultProps} onFormChange={onFormChange} />);

      fireEvent.click(screen.getByText("Add details"));

      const companyInput = screen.getByPlaceholderText("Where do they work?");
      fireEvent.change(companyInput, { target: { value: "Tech Corp" } });

      expect(onFormChange).toHaveBeenCalledWith({
        ...defaultFormData,
        company: "Tech Corp",
      });
    });

    it("calls onFormChange when tags input changes", () => {
      const onFormChange = vi.fn();
      render(<ContactCard {...defaultProps} onFormChange={onFormChange} />);

      fireEvent.click(screen.getByText("Add details"));

      const tagsInput = screen.getByPlaceholderText(/work, friend, investor/);
      fireEvent.change(tagsInput, { target: { value: "work, mentor" } });

      expect(onFormChange).toHaveBeenCalledWith({
        ...defaultFormData,
        tags: "work, mentor",
      });
    });
  });

  describe("tags rendering", () => {
    it("renders tag badges when tags are provided", () => {
      const formData: ContactFormData = {
        ...defaultFormData,
        tags: "investor, friend, mentor",
      };

      // Tags auto-expand details section
      render(<ContactCard {...defaultProps} formData={formData} />);

      expect(screen.getByText("investor")).toBeInTheDocument();
      expect(screen.getByText("friend")).toBeInTheDocument();
      expect(screen.getByText("mentor")).toBeInTheDocument();
    });

    it("handles whitespace in tags gracefully", () => {
      const formData: ContactFormData = {
        ...defaultFormData,
        tags: "  work  ,  friend  ,  ",
      };

      render(<ContactCard {...defaultProps} formData={formData} />);

      expect(screen.getByText("work")).toBeInTheDocument();
      expect(screen.getByText("friend")).toBeInTheDocument();
    });
  });

  describe("existing contacts dropdown", () => {
    const existingContacts: ExistingContact[] = [
      { id: "1", name: "Alice Johnson", company: "Tech Inc" },
      { id: "2", name: "Bob Smith", company: null },
    ];

    it("renders link to existing contact when contacts provided and details open", () => {
      render(
        <ContactCard {...defaultProps} existingContacts={existingContacts} />
      );

      fireEvent.click(screen.getByText("Add details"));
      expect(
        screen.getByText("Link to existing contact")
      ).toBeInTheDocument();
    });

    it("does not render dropdown when no existing contacts", () => {
      render(<ContactCard {...defaultProps} existingContacts={[]} />);

      fireEvent.click(screen.getByText("Add details"));
      expect(
        screen.queryByText("Link to existing contact")
      ).not.toBeInTheDocument();
    });
  });

  describe("timestamp formatting", () => {
    it("renders meeting time when createdAt is provided", () => {
      const date = new Date();
      date.setHours(15, 45, 0, 0);

      render(<ContactCard {...defaultProps} createdAt={date.getTime()} />);

      expect(screen.getByText(/Met today/)).toBeInTheDocument();
    });

    it("shows 'earlier' when no timestamp provided", () => {
      render(<ContactCard {...defaultProps} />);
      expect(screen.getByText(/earlier/)).toBeInTheDocument();
    });
  });

  describe("ref handling", () => {
    it("exposes focusInput method via ref", () => {
      const ref = { current: null as { focusInput: () => void } | null };

      render(<ContactCard {...defaultProps} ref={ref} />);

      expect(ref.current).not.toBeNull();
      expect(typeof ref.current?.focusInput).toBe("function");
    });
  });
});
