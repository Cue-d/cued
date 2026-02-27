/**
 * Mock Convex API for testing
 * Provides mock function references that match the real API structure
 */

// Mock function reference factory
const mockFn = (module: string, name: string) => `${module}:${name}` as const;

export const api = {
  actions: {
    getPendingActionCount: mockFn("actions", "getPendingActionCount"),
    getPendingActions: mockFn("actions", "getPendingActions"),
    createAction: mockFn("actions", "createAction"),
    updateActionStatus: mockFn("actions", "updateActionStatus"),
    swipeAction: mockFn("actions", "swipeAction"),
    selectDraftOption: mockFn("actions", "selectDraftOption"),
    updateDraftResponse: mockFn("actions", "updateDraftResponse"),
    searchActions: mockFn("actions", "searchActions"),
  },
  contacts: {
    getContacts: mockFn("contacts", "getContacts"),
    getContact: mockFn("contacts", "getContact"),
    updateContact: mockFn("contacts", "updateContact"),
    mergeContacts: mockFn("contacts", "mergeContacts"),
    getPendingMergeSuggestions: mockFn("contacts", "getPendingMergeSuggestions"),
    getPendingMergeSuggestionCount: mockFn("contacts", "getPendingMergeSuggestionCount"),
  },
  messages: {
    getMessages: mockFn("messages", "getMessages"),
    getMessage: mockFn("messages", "getMessage"),
  },
  search: {
    search: mockFn("search", "search"),
    searchMessages: mockFn("search", "searchMessages"),
    searchContacts: mockFn("search", "searchContacts"),
  },
  users: {
    getUser: mockFn("users", "getUser"),
    updateUser: mockFn("users", "updateUser"),
    getCurrentUser: mockFn("users", "getCurrentUser"),
  },
  presence: {
    heartbeat: mockFn("presence", "heartbeat"),
    getPresence: mockFn("presence", "getPresence"),
  },
  integrations: {
    getIntegrations: mockFn("integrations", "getIntegrations"),
    createIntegration: mockFn("integrations", "createIntegration"),
  },
  sync: {
    syncMessages: mockFn("sync", "syncMessages"),
    getSyncCursor: mockFn("sync", "getSyncCursor"),
    updateSyncCursor: mockFn("sync", "updateSyncCursor"),
  },
} as const;
