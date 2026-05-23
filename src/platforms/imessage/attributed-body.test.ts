import { describe, expect, it } from "vitest";
import { extractTextFromAttributedBody } from "./attributed-body.js";

describe("extractTextFromAttributedBody", () => {
  it("decodes the existing archived NSString byte pattern", () => {
    const blob = Buffer.concat([
      Buffer.from("bplist00NSString"),
      Buffer.from([0x94, 0x84, 0x01, 0x2b, 0x0b]),
      Buffer.from("hello there"),
      Buffer.from("NSDictionary"),
    ]);

    expect(extractTextFromAttributedBody(blob)).toBe("hello there");
  });

  it("decodes typedstream strings delimited by the stream end marker", () => {
    const blob = Buffer.concat([
      Buffer.from("bplist00NSString"),
      Buffer.from([0x01, 0x2b]),
      Buffer.from("fallback text"),
      Buffer.from([0x86, 0x84]),
    ]);

    expect(extractTextFromAttributedBody(blob)).toBe("fallback text");
  });

  it("does not treat the first byte of end-delimited text as a length prefix", () => {
    const text = "a".repeat(120);
    const blob = Buffer.concat([
      Buffer.from("bplist00NSString"),
      Buffer.from([0x01, 0x2b]),
      Buffer.from(text),
      Buffer.from([0x86, 0x84]),
    ]);

    expect(extractTextFromAttributedBody(blob)).toBe(text);
  });

  it("decodes typedstream strings with an embedded short length", () => {
    const blob = Buffer.concat([
      Buffer.from("bplist00NSString"),
      Buffer.from([0x01, 0x2b, 0x0f]),
      Buffer.from("length prefixed"),
      Buffer.from([0x86, 0x84]),
    ]);

    expect(extractTextFromAttributedBody(blob)).toBe("length prefixed");
  });

  it("decodes typedstream strings with two-byte NX lengths", () => {
    const text = "x".repeat(300);
    const blob = Buffer.concat([
      Buffer.from("bplist00NSString"),
      Buffer.from([0x01, 0x2b, 0x81, 0x2c, 0x01]),
      Buffer.from(text),
    ]);

    expect(extractTextFromAttributedBody(blob)).toBe(text);
  });

  it("returns an attachment marker for object replacement payloads", () => {
    const blob = Buffer.concat([
      Buffer.from("bplist00NSString"),
      Buffer.from([0x01, 0x2b]),
      Buffer.from("\ufffc"),
      Buffer.from([0x86, 0x84]),
    ]);

    expect(extractTextFromAttributedBody(blob)).toBe("[attachment]");
  });

  it("does not scan arbitrary readable strings without a typed string tag", () => {
    const blob = Buffer.from("bplist00NSString\0Readable but unstructured text");

    expect(extractTextFromAttributedBody(blob)).toBeNull();
  });

  it("rejects invalid utf8 typed string payloads", () => {
    const blob = Buffer.concat([
      Buffer.from("bplist00NSString"),
      Buffer.from([0x01, 0x2b, 0x03, 0xc3, 0x28, 0x41]),
    ]);

    expect(extractTextFromAttributedBody(blob)).toBeNull();
  });
});
