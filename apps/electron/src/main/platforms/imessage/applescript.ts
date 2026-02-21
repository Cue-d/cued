import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const APPLESCRIPT_TIMEOUT_MS = 30_000;

export type IMessageScriptTarget =
  | { kind: "individual"; recipient: string }
  | { kind: "group"; chatIdentifier: string };

export interface BuildIMessageSendScriptArgs {
  target: IMessageScriptTarget;
  text?: string;
  attachmentPaths?: readonly string[];
}

/**
 * Escape user-controlled values before embedding them in AppleScript strings.
 */
export function escapeAppleScriptString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function buildTargetSetup(target: IMessageScriptTarget): string[] {
  if (target.kind === "individual") {
    const escapedRecipient = escapeAppleScriptString(target.recipient);
    return [
      'set targetService to 1st account whose service type = iMessage',
      `set targetDestination to participant "${escapedRecipient}" of targetService`,
    ];
  }

  const escapedChatIdentifier = escapeAppleScriptString(target.chatIdentifier);
  return [`set targetDestination to chat id "${escapedChatIdentifier}"`];
}

/**
 * Generate an AppleScript program that sends optional text and attachments.
 */
export function buildIMessageSendScript(
  args: BuildIMessageSendScriptArgs
): string {
  const lines = [...buildTargetSetup(args.target)];

  if (args.text) {
    lines.push(`send "${escapeAppleScriptString(args.text)}" to targetDestination`);
  }

  for (const attachmentPath of args.attachmentPaths ?? []) {
    lines.push(
      `send (POSIX file "${escapeAppleScriptString(attachmentPath)}") to targetDestination`
    );
  }

  return [
    'tell application "Messages"',
    ...lines.map((line) => `  ${line}`),
    "end tell",
  ].join("\n");
}

export async function executeAppleScript(script: string): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    timeout: APPLESCRIPT_TIMEOUT_MS,
    encoding: "utf8",
  });
  return stdout.trim();
}
