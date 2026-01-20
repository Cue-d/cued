import { execSync, spawnSync } from "child_process";

export interface ClaudeResponse {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Execute a prompt using Claude Code CLI
 * This gives access to configured MCP servers (including Linear)
 */
export function executeClaudePrompt(
  prompt: string,
  options: {
    timeout?: number;
    cwd?: string;
  } = {}
): ClaudeResponse {
  const timeout = options.timeout || 120000; // 2 minutes default
  const cwd = options.cwd || process.cwd();

  try {
    // Use --print for non-interactive mode
    // --dangerously-skip-permissions to allow MCP tools without prompts
    // shell: false to avoid escaping issues with prompt content
    const result = spawnSync(
      "claude",
      ["--print", "--dangerously-skip-permissions", prompt],
      {
        encoding: "utf-8",
        timeout,
        cwd,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        shell: false,
      }
    );

    if (result.error) {
      return {
        success: false,
        output: "",
        error: result.error.message,
      };
    }

    if (result.status !== 0) {
      return {
        success: false,
        output: result.stdout || "",
        error: result.stderr || `Exit code: ${result.status}`,
      };
    }

    // Parse JSON output if possible
    let output = result.stdout;
    try {
      const parsed = JSON.parse(output);
      // Claude Code JSON output has a "result" field
      if (parsed.result) {
        output = parsed.result;
      }
    } catch {
      // Not JSON, use raw output
    }

    return {
      success: true,
      output: output.trim(),
    };
  } catch (error) {
    return {
      success: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Execute a prompt and extract JSON from the response
 */
export function executeClaudeForJSON<T>(
  prompt: string,
  options: {
    timeout?: number;
    cwd?: string;
  } = {}
): { success: boolean; data?: T; error?: string } {
  const response = executeClaudePrompt(prompt, options);

  if (!response.success) {
    return { success: false, error: response.error };
  }

  try {
    // Try to extract JSON from the response
    let jsonStr = response.output;

    // Handle markdown code blocks
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    const data = JSON.parse(jsonStr) as T;
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: `Failed to parse JSON: ${error instanceof Error ? error.message : error}`,
    };
  }
}

/**
 * Check if Claude Code CLI is available
 */
export function isClaudeAvailable(): boolean {
  try {
    const result = spawnSync("claude", ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      shell: false,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Check if Linear MCP is configured
 */
export function checkLinearMCP(): ClaudeResponse {
  return executeClaudePrompt(
    "List available MCP servers. Do you have access to Linear MCP? Just answer yes or no.",
    { timeout: 30000 }
  );
}
