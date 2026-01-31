/**
 * Mock for expo/fetch module
 * Uses the global fetch in test environment
 */
export const fetch = globalThis.fetch;
