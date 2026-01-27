import { describe, expect, it } from "vitest";
import { extractTextFromAttributedBody } from "../attributed-body";

/** Build a test blob with the attributedBody format. */
function buildBlob(text: string, options: { marker?: number; padding?: number[] } = {}): Buffer {
  const { marker = 0x94, padding = [] } = options;
  const textBuffer = Buffer.from(text);
  return Buffer.concat([
    Buffer.from("NSString"),
    Buffer.from(padding),
    Buffer.from([marker, 0x84, 0x01, 0x2b]),
    Buffer.from([textBuffer.length]),
    textBuffer,
  ]);
}

describe("extractTextFromAttributedBody", () => {
  it("returns null for null input", () => {
    expect(extractTextFromAttributedBody(null)).toBeNull();
  });

  it("returns null for empty buffer", () => {
    expect(extractTextFromAttributedBody(Buffer.from(""))).toBeNull();
  });

  it("returns null when NSString marker is not found", () => {
    expect(extractTextFromAttributedBody(Buffer.from("random data without marker"))).toBeNull();
  });

  it("extracts text from valid attributedBody blob", () => {
    const blob = buildBlob("Hello World", { padding: [0x00, 0x00] });
    expect(extractTextFromAttributedBody(blob)).toBe("Hello World");
  });

  it("extracts text with alternate marker (0x95)", () => {
    const blob = buildBlob("Test message", { marker: 0x95, padding: [0x00] });
    expect(extractTextFromAttributedBody(blob)).toBe("Test message");
  });

  it("filters out strings starting with NS", () => {
    const blob = buildBlob("NSAttributedString");
    expect(extractTextFromAttributedBody(blob)).toBeNull();
  });

  it("filters out strings starting with _NS", () => {
    const blob = buildBlob("_NSAttributedString");
    expect(extractTextFromAttributedBody(blob)).toBeNull();
  });

  it("filters out strings containing AttributeName", () => {
    const blob = buildBlob("SomeAttributeNameValue");
    expect(extractTextFromAttributedBody(blob)).toBeNull();
  });

  it("removes object replacement character and returns [attachment] if empty", () => {
    const blob = buildBlob("\ufffc");
    expect(extractTextFromAttributedBody(blob)).toBe("[attachment]");
  });

  it("removes object replacement character from mixed content", () => {
    const blob = buildBlob("Check this out\ufffc");
    expect(extractTextFromAttributedBody(blob)).toBe("Check this out");
  });

  it("handles multi-byte length encoding (0x81)", () => {
    const text = "A".repeat(200);
    const blob = Buffer.concat([
      Buffer.from("NSString"),
      Buffer.from([0x94, 0x84, 0x01, 0x2b]),
      Buffer.from([0x81, 200, 0]), // Multi-byte length
      Buffer.from(text),
    ]);
    expect(extractTextFromAttributedBody(blob)).toBe(text);
  });

  it("trims whitespace from extracted text", () => {
    const blob = buildBlob("  Hello with spaces  ");
    expect(extractTextFromAttributedBody(blob)).toBe("Hello with spaces");
  });
});
