export type {
  Tool,
  ToolContext,
  ToolExecutionOptions,
  ToolResult,
} from "./types";
export { getErrorMessage } from "./types";

export { openai, DEFAULT_MODEL, FAST_MODEL } from "./openai";

export {
  searchMessagesTool,
  searchContactsTool,
  createActionTool,
  getConversationsTool,
  searchMemoriesTool,
  searchActionsTool,
} from "./tools";

export {
  createMem0Provider,
  addContactMemories,
  addMemories,
  getMemories,
  retrieveMemories,
  searchMemories,
  type AddMemoriesResult,
  type ConversationMessage,
  type Mem0Provider,
  type Mem0ConfigSettings,
} from "./mem0";

export { SYSTEM_PROMPT, buildSystemPrompt } from "./prompts/system";
export {
  CUSTOM_FACT_EXTRACTION_PROMPT,
  CUSTOM_UPDATE_MEMORY_PROMPT,
  buildMemoryInstructions,
} from "./prompts/memory";
