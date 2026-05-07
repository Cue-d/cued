export type DaemonRequest =
  | { id: string; command: "ping" }
  | { id: string; command: "status" }
  | { id: string; command: "doctor" }
  | { id: string; command: "permissions-status" }
  | { id: string; command: "sql"; query: string }
  | {
      id: string;
      command: "actions-propose";
      actionType: string;
      actionVersion?: string;
      payload: unknown;
      priority?: number;
      title?: string | null;
      summary?: string | null;
      sourceSkill?: string | null;
      sourceJobId?: string | null;
      createdBy?: string | null;
      requiresApproval?: boolean;
      dedupeKey?: string | null;
    }
  | { id: string; command: "actions-list"; status?: string; limit?: number }
  | { id: string; command: "actions-show"; actionId: string }
  | { id: string; command: "actions-approve"; actionId: string; approvedBy?: string }
  | { id: string; command: "actions-deny"; actionId: string; deniedBy?: string }
  | { id: string; command: "actions-execute"; actionId: string; executedBy?: string }
  | { id: string; command: "actions-run-approved"; limit?: number; executedBy?: string }
  | { id: string; command: "integrations-list" }
  | { id: string; command: "integrations-refresh" }
  | { id: string; command: "integrations-connect"; platform: string; accountKey?: string }
  | { id: string; command: "integrations-disconnect"; platform: string; accountKey?: string }
  | { id: string; command: "integrations-remove"; platform: string; accountKey?: string }
  | { id: string; command: "integrations-enable"; platform: string; accountKey?: string }
  | { id: string; command: "integrations-disable"; platform: string; accountKey?: string }
  | {
      id: string;
      command: "attachments-list";
      messageId?: string;
      conversationId?: string;
      platform?: string;
      accountKey?: string;
      limit?: number;
    }
  | {
      id: string;
      command: "attachment-fetch";
      attachmentId: string;
      variant?: string;
      maxBytes?: number;
      allowLarge?: boolean;
      extractText?: boolean;
    }
  | {
      id: string;
      command: "attachments-search";
      query: string;
      platform?: string;
      accountKey?: string;
      conversationId?: string;
      limit?: number;
    }
  | {
      id: string;
      command: "message-send";
      platform: string;
      target: string;
      text: string;
      accountKey?: string;
      threadId?: string;
    }
  | { id: string; command: "sync-run"; source?: string }
  | { id: string; command: "sync-resume" }
  | { id: string; command: "shutdown-for-update" }
  | { id: string; command: "rebuild" }
  | { id: string; command: "reset"; source: string };

export type DaemonResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};
