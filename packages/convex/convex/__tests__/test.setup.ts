/// <reference types="vite/client" />
/**
 * Test setup file for convex-test.
 *
 * This file exports the modules glob pattern needed for convex-test
 * to find and load Convex function files when running in a non-standard
 * directory structure.
 *
 * The glob must capture all files in the convex directory including the
 * _generated directory which contains api.js and server.js.
 */

// Glob patterns relative to this file's location (convex/__tests__/)
// We need to go up one level to the convex/ directory
export const modules = import.meta.glob([
  "../*.ts",
  "../lib/*.ts",
  "../_generated/*.js",
  "../_generated/*.d.ts",
]);
