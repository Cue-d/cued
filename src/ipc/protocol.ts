export type DaemonRequest =
  | { id: string; command: "ping" }
  | { id: string; command: "status" }
  | { id: string; command: "doctor" }
  | { id: string; command: "integrations-list" }
  | { id: string; command: "integrations-refresh" }
  | { id: string; command: "integrations-connect"; platform: string; accountKey?: string }
  | { id: string; command: "integrations-disconnect"; platform: string; accountKey?: string }
  | { id: string; command: "integrations-remove"; platform: string; accountKey?: string }
  | { id: string; command: "integrations-enable"; platform: string; accountKey?: string }
  | { id: string; command: "integrations-disable"; platform: string; accountKey?: string }
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
  | { id: string; command: "rebuild" }
  | { id: string; command: "reset"; source: string }
  | {
      id: string;
      command: "merge-contact";
      leftContactId: string;
      rightContactId: string;
      reason?: string;
    }
  | {
      id: string;
      command: "split-contact";
      contactId: string;
      reason?: string;
    };

export type DaemonResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};
