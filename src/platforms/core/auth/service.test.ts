import { describe, expect, it } from "vitest";
import { IntegrationAuthService } from "./service.js";

describe("IntegrationAuthService", () => {
  it("includes the capabilities subcommand in usage text", () => {
    expect(IntegrationAuthService.usageText()).toContain("status | capabilities | refresh");
  });
});
