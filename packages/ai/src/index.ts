export type {
  Tool,
  ToolContext,
  ToolExecutionOptions,
  ToolResult,
} from "./types.js";
export { getErrorMessage } from "./types.js";

export {
  searchMessagesTool,
  searchContactsTool,
  createActionTool,
  getConversationsTool,
  searchMemoriesTool,
} from "./tools/index.js";

// Mem0 provider for Vercel AI SDK
export {
  createMem0Provider,
  addMemories,
  getMemories,
  retrieveMemories,
} from "./mem0.js";
