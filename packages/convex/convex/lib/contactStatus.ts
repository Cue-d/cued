import type { Doc } from "../_generated/dataModel";

export type ContactStatus = "active" | "archived";

type ContactStatusLike = Pick<Doc<"contacts">, "status" | "isDismissed">;

/** Get effective status with backward compatibility for legacy dismissed records. */
export function getContactStatus(contact: ContactStatusLike): ContactStatus {
  // Legacy dismissed flag always maps to archived semantics.
  if (contact.isDismissed) return "archived";
  if (contact.status === "archived" || contact.status === "dismissed") return "archived";
  return "active";
}

/** Whether this contact should receive new actions and analysis. */
export function isContactActionable(contact: ContactStatusLike): boolean {
  return getContactStatus(contact) === "active";
}
