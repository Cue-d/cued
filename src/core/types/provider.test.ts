import { describe, expect, it } from "vitest";
import { normalizeRawEventProvenance } from "./provider.js";

describe("raw event provenance", () => {
  it("maps legacy captureKind values onto acquisitionMode", () => {
    const provenance = normalizeRawEventProvenance({
      captureKind: "realtime",
      sourceVersion: "linkedin-v1",
      providerApiVersion: "2026-03",
    } as Parameters<typeof normalizeRawEventProvenance>[0]);

    expect(provenance).toEqual({
      providerApiVersion: "2026-03",
      adapterVersion: null,
      acquisitionMode: "realtime",
      sourceVersion: "linkedin-v1",
    });
  });

  it("does not emit removed capture kinds in normalized provenance", () => {
    const provenance = normalizeRawEventProvenance({
      captureKind: "fixture",
      sourceVersion: "fixture-v1",
      adapterVersion: "fixture@1",
    } as Parameters<typeof normalizeRawEventProvenance>[0]);

    expect(provenance).toEqual({
      providerApiVersion: null,
      adapterVersion: "fixture@1",
      acquisitionMode: null,
      sourceVersion: "fixture-v1",
    });
  });
});
