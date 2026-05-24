import { describe, expect, it } from "vitest";
import { chunkArray } from "./sql-batch.js";

describe("chunkArray", () => {
  it("splits items into fixed-size chunks", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns an empty array for empty input", () => {
    expect(chunkArray([], 3)).toEqual([]);
  });
});
