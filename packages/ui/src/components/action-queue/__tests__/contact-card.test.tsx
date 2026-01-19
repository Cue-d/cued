import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContactCard, type ContactFormData, type ExistingContact } from "../contact-card";

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
    autoFocus: false, // Disable autofocus for tests
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

  it("renders meeting context text", () => {
    render(<ContactCard {...defaultProps} />);
    expect(screen.getByText("You met someone new today")).toBeInTheDocument();
  });

  it("renders all form fields", () => {
    render(<ContactCard {...defaultProps} />);
    expect(screen.getByPlaceholderText("Their name...")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Where do they work?")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/work, friend, investor/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Where did you meet/)).toBeInTheDocument();
  });

  it("displays form data values", () => {
    const formData: ContactFormData = {
      name: "John Doe",
      company: "Acme Inc",
      tags: "investor, friend",
      notes: "Met at conference",
    };

    render(<ContactCard {...defaultProps} formData={formData} />);

    expect(screen.getByDisplayValue("John Doe")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Acme Inc")).toBeInTheDocument();
    expect(screen.getByDisplayValue("investor, friend")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Met at conference")).toBeInTheDocument();
  });

  describe("form interactions", () => {
    it("calls onFormChange when name input changes", () => {
      const onFormChange = vi.fn();
      render(<ContactCard {...defaultProps} onFormChange={onFormChange} />);

      const nameInput = screen.getByPlaceholderText("Their name...");
      fireEvent.change(nameInput, { target: { value: "New Name" } });

      expect(onFormChange).toHaveBeenCalledWith({
        ...defaultFormData,
        name: "New Name",
      });
    });

    it("calls onFormChange when company input changes", () => {
      const onFormChange = vi.fn();
      render(<ContactCard {...defaultProps} onFormChange={onFormChange} />);

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

      const tagsInput = screen.getByPlaceholderText(/work, friend, investor/);
      fireEvent.change(tagsInput, { target: { value: "work, mentor" } });

      expect(onFormChange).toHaveBeenCalledWith({
        ...defaultFormData,
        tags: "work, mentor",
      });
    });

    it("calls onFormChange when notes textarea changes", () => {
      const onFormChange = vi.fn();
      render(<ContactCard {...defaultProps} onFormChange={onFormChange} />);

      const notesTextarea = screen.getByPlaceholderText(/Where did you meet/);
      fireEvent.change(notesTextarea, { target: { value: "Met at lunch" } });

      expect(onFormChange).toHaveBeenCalledWith({
        ...defaultFormData,
        notes: "Met at lunch",
      });
    });
  });

  describe("tags rendering", () => {
    it("renders tag badges when tags are provided", () => {
      const formData: ContactFormData = {
        ...defaultFormData,
        tags: "investor, friend, mentor",
      };

      render(<ContactCard {...defaultProps} formData={formData} />);

      expect(screen.getByText("investor")).toBeInTheDocument();
      expect(screen.getByText("friend")).toBeInTheDocument();
      expect(screen.getByText("mentor")).toBeInTheDocument();
    });

    it("does not render tag badges when tags are empty", () => {
      render(<ContactCard {...defaultProps} />);
      // The tags input exists but no badges should be rendered
      const badges = screen.queryAllByRole("status"); // Badges typically don't have a role
      // Instead, check that specific tag text doesn't appear as a separate badge
      expect(screen.queryByText("investor")).not.toBeInTheDocument();
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

  describe("platform badge", () => {
    it("renders platform badge when platform is provided", () => {
      render(<ContactCard {...defaultProps} platform="imessage" />);
      expect(screen.getByText("imessage")).toBeInTheDocument();
    });

    it("does not render platform badge when platform is null", () => {
      render(<ContactCard {...defaultProps} platform={null} />);
      // Should not find any platform text
      expect(screen.queryByText("imessage")).not.toBeInTheDocument();
      expect(screen.queryByText("gmail")).not.toBeInTheDocument();
    });
  });

  describe("existing contacts dropdown", () => {
    const existingContacts: ExistingContact[] = [
      { id: "1", name: "Alice Johnson", company: "Tech Inc" },
      { id: "2", name: "Bob Smith", company: null },
    ];

    it("renders link to existing contact dropdown when contacts provided", () => {
      render(
        <ContactCard {...defaultProps} existingContacts={existingContacts} />
      );
      expect(screen.getByText("Link to existing contact")).toBeInTheDocument();
    });

    it("does not render dropdown when no existing contacts", () => {
      render(<ContactCard {...defaultProps} existingContacts={[]} />);
      expect(screen.queryByText("Link to existing contact")).not.toBeInTheDocument();
    });

    it("shows linked contact in form data", () => {
      const formData: ContactFormData = {
        ...defaultFormData,
        linkedContactId: "1",
      };

      render(
        <ContactCard
          {...defaultProps}
          formData={formData}
          existingContacts={existingContacts}
        />
      );

      expect(screen.getByText("Link to existing contact")).toBeInTheDocument();
    });
  });

  describe("timestamp formatting", () => {
    it("renders meeting time when createdAt is provided", () => {
      // Create a specific time (3:45 PM)
      const date = new Date();
      date.setHours(15, 45, 0, 0);

      render(<ContactCard {...defaultProps} createdAt={date.getTime()} />);

      // The time format depends on locale, but should contain "at" followed by a time
      // Look for the specific time format pattern (e.g., "at 3:45 PM")
      expect(screen.getByText(/at \d+:\d+/)).toBeInTheDocument();
    });

    it("shows 'earlier' when no timestamp provided", () => {
      render(<ContactCard {...defaultProps} />);
      expect(screen.getByText("at earlier")).toBeInTheDocument();
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
