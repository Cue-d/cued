/** Contact shape returned by node-mac-contacts. */
export interface NativeContact {
  identifier: string;
  firstName: string;
  lastName: string;
  nickname: string;
  birthday: string;
  phoneNumbers: string[];
  emailAddresses: string[];
  organizationName?: string;
}

/** Auth status strings returned by node-mac-contacts. */
export type ContactsAuthStatus =
  | "Not Determined"
  | "Denied"
  | "Authorized"
  | "Restricted";

/** node-mac-contacts module API. */
export interface NodeMacContacts {
  getAllContacts(extraProperties?: string[]): NativeContact[];
  getContactsByName(name: string, extraProperties?: string[]): NativeContact[];
  getAuthStatus(): ContactsAuthStatus;
  requestAccess(): Promise<"Denied" | "Authorized">;
  listener: {
    setup(): void;
    remove(): void;
    on(event: "contact-changed", callback: (external: boolean) => void): void;
    removeAllListeners(): void;
  };
}
