import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResolveContactCardWrapper } from "../resolve-contact-card-wrapper";
import type { ActionCardProps } from "../../types";

describe("ResolveContactCardWrapper", () => {
  it("shows a clean LinkedIn account label and opens canonical profile URL", () => {
    const onLinkClick = vi.fn();

    const props: ActionCardProps = {
      action: {
        _id: "action-1",
        type: "resolve_contact",
        status: "pending",
        priority: 1,
        reason: null,
        llmReason: null,
        createdAt: Date.now(),
        snoozedUntil: null,
        completedAt: null,
        discardedAt: null,
        conversationId: null,
        contactId: "contact-1",
        contactName: "Archie McKenzie",
        secondaryContactId: "contact-2",
        secondaryContactName: "Archie McKenzie",
        mergeSuggestionId: "merge-1",
        mergeConfidence: 0.95,
        mergeSource: "exact_name_match",
        mergeReasoning: null,
        platform: "linkedin",
      },
      isTop: true,
      context: {
        action: {
          _id: "action-1",
          type: "resolve_contact",
          status: "pending",
          priority: 1,
          reason: null,
          llmReason: null,
          createdAt: Date.now(),
          snoozedUntil: null,
          completedAt: null,
          discardedAt: null,
          platform: "linkedin",
          secondaryContactId: "contact-2",
          mergeSuggestionId: "merge-1",
        },
        conversation: null,
        contact: {
          _id: "contact-1",
          displayName: "Archie McKenzie",
          company: null,
          notes: null,
          importance: null,
          handles: [
            {
              handleType: "linkedin_handle",
              handle: "https://www.linkedin.com/in/Archie-McKenzie/?trk=profile",
              platform: "linkedin",
            },
          ],
        },
        secondaryContact: {
          _id: "contact-2",
          displayName: "Archie McKenzie",
          company: null,
          notes: null,
          importance: null,
          handles: [],
        },
        participants: [],
        messages: [],
      },
      responseText: "",
      onResponseChange: vi.fn(),
      autoFocus: false,
      onLinkClick,
    };

    render(<ResolveContactCardWrapper {...props} />);

    expect(screen.getByText("LinkedIn account")).toBeInTheDocument();
    expect(
      screen.queryByText("https://www.linkedin.com/in/Archie-McKenzie/?trk=profile")
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open in LinkedIn" }));
    expect(onLinkClick).toHaveBeenCalledWith(
      "https://www.linkedin.com/in/archie-mckenzie"
    );
  });

  it("hides opaque LinkedIn member IDs from merge rows", () => {
    const onLinkClick = vi.fn();

    const props: ActionCardProps = {
      action: {
        _id: "action-1",
        type: "resolve_contact",
        status: "pending",
        priority: 1,
        reason: null,
        llmReason: null,
        createdAt: Date.now(),
        snoozedUntil: null,
        completedAt: null,
        discardedAt: null,
        conversationId: null,
        contactId: "contact-1",
        contactName: "Theo Tarr",
        secondaryContactId: "contact-2",
        secondaryContactName: "Theo Tarr",
        mergeSuggestionId: "merge-1",
        mergeConfidence: 0.95,
        mergeSource: "exact_name_match",
        mergeReasoning: null,
        platform: "linkedin",
      },
      isTop: true,
      context: {
        action: {
          _id: "action-1",
          type: "resolve_contact",
          status: "pending",
          priority: 1,
          reason: null,
          llmReason: null,
          createdAt: Date.now(),
          snoozedUntil: null,
          completedAt: null,
          discardedAt: null,
          platform: "linkedin",
          secondaryContactId: "contact-2",
          mergeSuggestionId: "merge-1",
        },
        conversation: null,
        contact: {
          _id: "contact-1",
          displayName: "Theo Tarr",
          company: null,
          notes: null,
          importance: null,
          handles: [
            {
              handleType: "linkedin_handle",
              handle: "ACoAAEFsIqIBxYzabc123def456ghi",
              platform: "linkedin",
            },
          ],
        },
        secondaryContact: {
          _id: "contact-2",
          displayName: "Theo Tarr",
          company: null,
          notes: null,
          importance: null,
          handles: [],
        },
        participants: [],
        messages: [],
      },
      responseText: "",
      onResponseChange: vi.fn(),
      autoFocus: false,
      onLinkClick,
    };

    render(<ResolveContactCardWrapper {...props} />);

    expect(
      screen.queryByText("ACoAAEFsIqIBxYzabc123def456ghi")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open in LinkedIn" })
    ).not.toBeInTheDocument();
  });
});
