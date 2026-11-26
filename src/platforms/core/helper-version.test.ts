import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readHelperVersionOutput, warmHelperVersionOutput } from "./helper-version.js";

describe("helper version lookup", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A helper that prints `output` and appends a line to a log each time it is run. */
  function createHelper(output: string): { path: string; runs: () => number } {
    const dir = mkdtempSync(join(tmpdir(), "cued-helper-version-"));
    dirs.push(dir);
    const path = join(dir, "helper");
    const log = join(dir, "runs.log");
    writeFileSync(path, `#!/bin/sh\necho ran >> '${log}'\nprintf '%s' '${output}'\n`);
    chmodSync(path, 0o755);
    return {
      path,
      runs: () =>
        existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0,
    };
  }

  it("runs the helper once and answers later reads from memory", () => {
    const helper = createHelper('{"version":"1.2.3"}');

    expect(readHelperVersionOutput(helper.path)).toBe('{"version":"1.2.3"}');
    expect(readHelperVersionOutput(helper.path)).toBe('{"version":"1.2.3"}');
    expect(readHelperVersionOutput(helper.path)).toBe('{"version":"1.2.3"}');
    expect(helper.runs()).toBe(1);
  });

  it("asks again when the helper binary is replaced", () => {
    const helper = createHelper('{"version":"1.0.0"}');
    expect(readHelperVersionOutput(helper.path)).toBe('{"version":"1.0.0"}');

    writeFileSync(helper.path, "#!/bin/sh\nprintf '%s' '{\"version\":\"2.0.0-updated\"}'\n");
    chmodSync(helper.path, 0o755);
    expect(readHelperVersionOutput(helper.path)).toBe('{"version":"2.0.0-updated"}');
  });

  it("does not remember a failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-helper-version-"));
    dirs.push(dir);
    const path = join(dir, "helper");
    writeFileSync(path, "#!/bin/sh\nexit 3\n");
    chmodSync(path, 0o755);

    expect(readHelperVersionOutput(path)).toBeNull();
    expect(readHelperVersionOutput(join(dir, "missing"))).toBeNull();
  });

  it("can be warmed without blocking, after which a read spawns nothing", async () => {
    const helper = createHelper('{"version":"3.0.0"}');

    await warmHelperVersionOutput(helper.path);
    expect(helper.runs()).toBe(1);
    expect(readHelperVersionOutput(helper.path)).toBe('{"version":"3.0.0"}');
    await warmHelperVersionOutput(helper.path);
    expect(helper.runs()).toBe(1);
    await expect(warmHelperVersionOutput(null)).resolves.toBeUndefined();
  });
});
