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

/** node-mac-contacts module API. */
export interface NodeMacContacts {
  getAllContacts(
    extraProperties?: Array<
      | "jobTitle"
      | "departmentName"
      | "organizationName"
      | "middleName"
      | "note"
      | "contactImage"
      | "contactThumbnailImage"
      | "instantMessageAddresses"
      | "socialProfiles"
    >,
  ): NativeContact[];
  getContactsByName(
    name: string,
    extraProperties?: Array<
      | "jobTitle"
      | "departmentName"
      | "organizationName"
      | "middleName"
      | "note"
      | "contactImage"
      | "contactThumbnailImage"
      | "instantMessageAddresses"
      | "socialProfiles"
    >,
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
