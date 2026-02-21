import { describe, expect, it } from "vitest";
import {
  buildIMessageSendScript,
  escapeAppleScriptString,
} from "../applescript";

describe("iMessage AppleScript utils", () => {
  describe("escapeAppleScriptString", () => {
    it("escapes control chars, quotes, and backslashes", () => {
      const escaped = escapeAppleScriptString('test"\n\r\t\\value');
      expect(escaped).toBe('test\\"\\n\\r\\t\\\\value');
    });
  });

  describe("buildIMessageSendScript", () => {
    it("escapes user-controlled input for individual sends", () => {
      const payload = 'bad"recipient\n"; do shell script "whoami"; "';
      const script = buildIMessageSendScript({
        target: { kind: "individual", recipient: payload },
        text: payload,
        attachmentPaths: [payload],
      });

      expect(script.includes(payload)).toBe(false);
      expect(script).toContain('bad\\"recipient\\n\\"; do shell script \\"whoami\\"; \\"');
      expect(script).toContain('send (POSIX file "');
    });

    it("never embeds raw dangerous payloads into generated script", () => {
      const payloads = [
        'bad"recipient\n"; do shell script "whoami"; "',
        'chat"id"; do shell script "cat /etc/passwd"; "',
        '/tmp/evil"; rm -rf /; ".jpg',
      ];

      for (const payload of payloads) {
        const dmScript = buildIMessageSendScript({
          target: { kind: "individual", recipient: payload },
          text: payload,
          attachmentPaths: [payload],
        });
        expect(dmScript.includes(payload)).toBe(false);

        const groupScript = buildIMessageSendScript({
          target: { kind: "group", chatIdentifier: payload },
          text: payload,
          attachmentPaths: [payload],
        });
        expect(groupScript.includes(payload)).toBe(false);
      }
    });

    it("builds group script with attachment-only payload", () => {
      const script = buildIMessageSendScript({
        target: { kind: "group", chatIdentifier: 'chat;-;id"123' },
        attachmentPaths: ["/tmp/photo.jpg"],
      });

      expect(script).toContain('set targetDestination to chat id "chat;-;id\\"123"');
      expect(script).toContain('send (POSIX file "/tmp/photo.jpg") to targetDestination');
      expect(script).not.toContain('send "" to targetDestination');
    });
  });
});
