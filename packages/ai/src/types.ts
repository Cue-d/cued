import { z } from "zod";

/** Context providing Convex access and user identity for tool execution. */
export interface ToolContext {
  userId: string;
  query: <T>(queryFn: unknown, args: Record<string, unknown>) => Promise<T>;
  mutation: <T>(
    mutationFn: unknown,
    args: Record<string, unknown>,
  ) => Promise<T>;
}

/** Options passed to tool execute functions, compatible with Vercel AI SDK. */
export interface ToolExecutionOptions {
  toolCallId: string;
  abortSignal?: AbortSignal;
  context: ToolContext;
}

/** Result of a tool execution. */
export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/** PRM tool definition, designed for use with Vercel AI SDK's tool() helper. */
export interface Tool<TInput extends z.ZodTypeAny, TOutput> {
  name: string;
  description: string;
  inputSchema: TInput;
  execute: (
    input: z.infer<TInput>,
    options: ToolExecutionOptions,
  ) => Promise<ToolResult<TOutput>>;
}
