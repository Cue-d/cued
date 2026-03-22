import { describe, expect, it } from "vitest";
import { normalizeRawEventProvenance } from "./provider.js";

describe("raw event provenance", () => {
  it("preserves the supported provenance fields", () => {
    const provenance = normalizeRawEventProvenance({
      acquisitionMode: "realtime",
      providerApiVersion: "2026-03",
    } as Parameters<typeof normalizeRawEventProvenance>[0]);

    expect(provenance).toEqual({
      providerApiVersion: "2026-03",
      adapterVersion: null,
      acquisitionMode: "realtime",
    });
  });

  it("returns null when provenance is empty", () => {
    const provenance = normalizeRawEventProvenance(
      {} as Parameters<typeof normalizeRawEventProvenance>[0],
    );

    expect(provenance).toBeNull();
  });
});
