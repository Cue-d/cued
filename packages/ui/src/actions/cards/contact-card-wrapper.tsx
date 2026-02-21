/**
 * Contact card wrapper for new_connection and eod_contact actions.
 * Delegates to ContactCard with context mapping.
 */

import * as React from "react";
import { ContactCard } from "../../components/action-queue/contact-card";
import type { ActionCardProps } from "../types";
import type { ContactFormData } from "@cued/shared";

/**
 * Contact card state management.
 * Uses responseText to store notes (the primary editable field).
 */
export function ContactCardWrapper({
  action,
  isTop,
  context,
  responseText,
  onResponseChange,
  autoFocus,
  className,
  openInApp,
  readOnly,
}: ActionCardProps) {
  // Use local state for form data, with responseText as the notes field
  const [formData, setFormData] = React.useState<ContactFormData>(() => ({
    name: action.contactName ?? "",
    company: "",
    tags: "",
    notes: responseText,
    linkedContactId: null,
  }));

  // Sync notes field with responseText
  React.useEffect(() => {
    if (formData.notes !== responseText) {
      onResponseChange(formData.notes);
    }
  }, [formData.notes, responseText, onResponseChange]);

  const handleFormChange = React.useCallback((data: ContactFormData) => {
    setFormData(data);
  }, []);

  return (
    <ContactCard
      personName={action.contactName ?? "New Contact"}
      avatarUrl={(isTop ? context?.contact?.avatarUrl : null) ?? action.contactAvatarUrl ?? null}
      createdAt={action.createdAt}
      formData={formData}
      onFormChange={handleFormChange}
      autoFocus={readOnly ? false : isTop && autoFocus}
      className={className}
      openInApp={openInApp}
      readOnly={readOnly}
    />
  );
}

// Export specific card types that use the same component
export const NewConnectionCard = ContactCardWrapper;
export const EODContactCard = ContactCardWrapper;
