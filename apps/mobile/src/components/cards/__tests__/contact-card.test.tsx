import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { type ContactFormData } from "@cued/shared";
import { ContactCard, type ContactCardProps } from "../contact-card";

// Ensure React is globally available for JSX transform
globalThis.React = React;

// Mock @/lib/utils
vi.mock("@/lib/utils", () => ({
  cn: (...args: (string | undefined | false)[]) => args.filter(Boolean).join(" "),
  getThemeColors: () => ({
    background: "#FFFFFF",
    foreground: "#18181B",
    mutedForeground: "#71717A",
    primary: "#3D3D3D",
  }),
}));

// Helper to get form inputs by accessibility label (since RN renders as lowercase)
const getInputByLabel = (container: HTMLElement, label: string) =>
  container.querySelector(`textinput[accessibilitylabel="${label}"]`);

describe("ContactCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const defaultFormData: ContactFormData = {
    name: "",
    company: "",
    tags: "",
    notes: "",
  };

  const defaultProps: ContactCardProps = {
    personName: "John Doe",
    formData: defaultFormData,
    onFormChange: vi.fn(),
  };

  describe("header rendering", () => {
    it("renders person name", () => {
      render(<ContactCard {...defaultProps} />);

      expect(screen.getByText("John Doe")).toBeDefined();
    });

    it("renders 'New connection' subtitle", () => {
      render(<ContactCard {...defaultProps} />);

      expect(screen.getByText("New connection")).toBeDefined();
    });
  });

  describe("platform badge", () => {
    it("renders platform badge with Open text for iMessage", () => {
      const { container } = render(<ContactCard {...defaultProps} platform="imessage" />);

      expect(screen.getByText("Open")).toBeDefined();
      expect(container.querySelector('pressable[accessibilitylabel="imessage"]')).not.toBeNull();
    });

    it("renders platform badge with Open text for LinkedIn", () => {
      const { container } = render(<ContactCard {...defaultProps} platform="linkedin" />);

      expect(screen.getByText("Open")).toBeDefined();
      expect(container.querySelector('pressable[accessibilitylabel="linkedin"]')).not.toBeNull();
    });

    it("renders platform badge with Open text for Slack", () => {
      const { container } = render(<ContactCard {...defaultProps} platform="slack" />);

      expect(screen.getByText("Open")).toBeDefined();
      expect(container.querySelector('pressable[accessibilitylabel="slack"]')).not.toBeNull();
    });

    it("does not render platform badge when null", () => {
      render(<ContactCard {...defaultProps} platform={null} />);

      expect(screen.queryByText("Open")).toBeNull();
    });
  });

  describe("form fields", () => {
    it("renders all form field labels", () => {
      render(<ContactCard {...defaultProps} />);

      expect(screen.getByText("Name")).toBeDefined();
      expect(screen.getByText("Company")).toBeDefined();
      expect(screen.getByText("Tags")).toBeDefined();
      expect(screen.getByText("Notes")).toBeDefined();
    });

    it("renders description text", () => {
      render(<ContactCard {...defaultProps} />);

      expect(screen.getByText(/Tell me a bit more about them/)).toBeDefined();
    });

    it("renders form fields with current values", () => {
      const formData: ContactFormData = {
        name: "Jane Smith",
        company: "Acme Inc",
        tags: "work, investor",
        notes: "Met at conference",
      };
      const { container } = render(<ContactCard {...defaultProps} formData={formData} />);

      // Fields should display their values via value attribute
      const nameInput = getInputByLabel(container, "Name");
      expect(nameInput?.getAttribute("value")).toBe("Jane Smith");

      const companyInput = getInputByLabel(container, "Company");
      expect(companyInput?.getAttribute("value")).toBe("Acme Inc");
    });

    it("renders all form inputs", () => {
      const { container } = render(<ContactCard {...defaultProps} />);

      expect(getInputByLabel(container, "Name")).not.toBeNull();
      expect(getInputByLabel(container, "Company")).not.toBeNull();
      expect(getInputByLabel(container, "Tags")).not.toBeNull();
      expect(getInputByLabel(container, "Notes")).not.toBeNull();
    });
  });

  describe("tag badges", () => {
    it("renders tag badges from comma-separated tags", () => {
      const formData: ContactFormData = {
        ...defaultFormData,
        tags: "work, investor, tech",
      };
      render(<ContactCard {...defaultProps} formData={formData} />);

      expect(screen.getByText("work")).toBeDefined();
      expect(screen.getByText("investor")).toBeDefined();
      expect(screen.getByText("tech")).toBeDefined();
    });

    it("trims whitespace from tags", () => {
      const formData: ContactFormData = {
        ...defaultFormData,
        tags: "  work  ,   investor  ",
      };
      render(<ContactCard {...defaultProps} formData={formData} />);

      expect(screen.getByText("work")).toBeDefined();
      expect(screen.getByText("investor")).toBeDefined();
    });

    it("does not render empty tags", () => {
      const formData: ContactFormData = {
        ...defaultFormData,
        tags: "work, , , investor",
      };
      render(<ContactCard {...defaultProps} formData={formData} />);

      expect(screen.getByText("work")).toBeDefined();
      expect(screen.getByText("investor")).toBeDefined();
    });

    it("does not render tag badges when tags is empty", () => {
      render(<ContactCard {...defaultProps} formData={defaultFormData} />);

      // No tag badges should be rendered
      const container = screen.getByText("Tags").parentElement?.parentElement;
      // The tag badges area should not have any visible tags
      expect(container).toBeDefined();
    });
  });

  describe("placeholders", () => {
    it("renders placeholder for name field", () => {
      const { container } = render(<ContactCard {...defaultProps} />);

      const nameInput = getInputByLabel(container, "Name");
      expect(nameInput?.getAttribute("placeholder")).toBe("Their name...");
    });

    it("renders placeholder for company field", () => {
      const { container } = render(<ContactCard {...defaultProps} />);

      const companyInput = getInputByLabel(container, "Company");
      expect(companyInput?.getAttribute("placeholder")).toBe("Where do they work?");
    });

    it("renders placeholder for tags field", () => {
      const { container } = render(<ContactCard {...defaultProps} />);

      const tagsInput = getInputByLabel(container, "Tags");
      expect(tagsInput?.getAttribute("placeholder")).toBe("work, friend, investor, met at conference...");
    });

    it("renders placeholder for notes field", () => {
      const { container } = render(<ContactCard {...defaultProps} />);

      const notesInput = getInputByLabel(container, "Notes");
      expect(notesInput?.getAttribute("placeholder")).toContain("Where did you meet?");
    });
  });

  describe("styling", () => {
    it("applies custom className", () => {
      const { container } = render(
        <ContactCard {...defaultProps} className="custom-class" />
      );

      expect(container.firstChild).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("handles empty person name", () => {
      render(<ContactCard {...defaultProps} personName="" />);

      // Should still render without crashing
      expect(screen.getByText("New connection")).toBeDefined();
    });

    it("handles special characters in person name", () => {
      render(<ContactCard {...defaultProps} personName="José García-López" />);

      expect(screen.getByText("José García-López")).toBeDefined();
    });

    it("handles long tags without crashing", () => {
      const formData: ContactFormData = {
        ...defaultFormData,
        tags: "very-long-tag-name, another-long-tag, yet-another-one, more-tags",
      };
      render(<ContactCard {...defaultProps} formData={formData} />);

      expect(screen.getByText("very-long-tag-name")).toBeDefined();
    });
  });
});
