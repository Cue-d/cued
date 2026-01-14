export type {
  Tool,
  ToolContext,
  ToolExecutionOptions,
  ToolResult,
} from "./types.js";
export { getErrorMessage } from "./types.js";

// OpenAI provider for Vercel AI SDK
export { openai, DEFAULT_MODEL, FAST_MODEL } from "./openai.js";

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
  searchMemories,
  type Mem0Provider,
  type Mem0ConfigSettings,
} from "./mem0.js";

// System prompts
export { SYSTEM_PROMPT, buildSystemPrompt } from "./prompts/system.js";
