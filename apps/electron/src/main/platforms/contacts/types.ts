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
  contactImage?: Buffer;
  contactThumbnailImage?: Buffer;
}

/** Auth status strings returned by node-mac-contacts. */
export type ContactsAuthStatus =
  | "Not Determined"
  | "Denied"
  | "Authorized"
  | "Restricted";

export type ContactExtraProperty =
  | "jobTitle"
  | "departmentName"
  | "organizationName"
  | "middleName"
  | "note"
  | "contactImage"
  | "contactThumbnailImage"
  | "instantMessageAddresses"
  | "socialProfiles";

/** node-mac-contacts module API. */
export interface NodeMacContacts {
  getAllContacts(
    extraProperties?: ContactExtraProperty[],
  ): NativeContact[];
  getContactsByName(
    name: string,
    extraProperties?: ContactExtraProperty[],
  ): NativeContact[];
  getAuthStatus(): ContactsAuthStatus;
  requestAccess(): Promise<"Denied" | "Authorized">;
  listener: {
    setup(): void;
    remove(): void;
    on(event: "contact-changed", callback: (external: boolean) => void): void;
    removeAllListeners(): void;
  };
}
