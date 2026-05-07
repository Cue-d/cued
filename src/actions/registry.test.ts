import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadActionExecutor } from "./executor-loader.js";
import {
  ActionDefinitionRegistry,
  defaultActionDefinitionsPath,
  defaultCuedSkillRoots,
} from "./registry.js";

describe("action definition registry", () => {
  const tempDirs: string[] = [];
  const originalCuedSkillRoot = process.env.CUED_SKILL_ROOT;
  const originalCuedSkillRoots = process.env.CUED_SKILL_ROOTS;
  const originalCuedHome = process.env.CUED_HOME;

  afterEach(() => {
    if (originalCuedSkillRoot === undefined) {
      delete process.env.CUED_SKILL_ROOT;
    } else {
      process.env.CUED_SKILL_ROOT = originalCuedSkillRoot;
    }
    if (originalCuedSkillRoots === undefined) {
      delete process.env.CUED_SKILL_ROOTS;
    } else {
      process.env.CUED_SKILL_ROOTS = originalCuedSkillRoots;
    }
    if (originalCuedHome === undefined) {
      delete process.env.CUED_HOME;
    } else {
      process.env.CUED_HOME = originalCuedHome;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("loads bundled Cued action definitions", () => {
    const registry = ActionDefinitionRegistry.load(defaultActionDefinitionsPath());

    expect(
      registry
        .list()
        .map((definition) => `${definition.type}@${definition.version}:${definition.module}`),
    ).toEqual([
      "contact.enrichment.recommend@1:actions/contact-enrichment-recommend.cjs",
      "contact.followup.recommend@1:actions/contact-followup-recommend.cjs",
      "contact.introduction.recommend@1:actions/contact-introduction-recommend.cjs",
      "contact.memory.add@1:actions/contact-memory-add.cjs",
      "contact.memory.stale@1:actions/contact-memory-stale.cjs",
      "contact.merge@1:actions/contact-merge.cjs",
      "contact.message.draft@1:actions/contact-message-draft.cjs",
      "conversation.followup.recommend@1:actions/conversation-followup-recommend.cjs",
      "conversation.summary.draft@1:actions/conversation-summary-draft.cjs",
    ]);
    expect(registry.get("contact.merge", "1")?.skillName).toBe("cued");
    expect(
      registry.validatePayload("contact.merge", "1", {
        primaryContactId: "contact-1",
        secondaryContactId: "contact-2",
        reason: "same normalized phone",
      }),
    ).toEqual({ ok: true, errors: [] });
    expect(registry.get("contact.merge", "1")?.postExecution).toEqual({
      rebuildProjection: true,
    });
    expect(registry.get("contact.memory.add", "1")?.postExecution).toEqual({
      rebuildProjection: false,
    });
    for (const definition of registry.list()) {
      expect(loadActionExecutor(definition), definition.module).not.toBeNull();
    }
  });

  it("rejects unknown actions and invalid payloads", () => {
    const registry = ActionDefinitionRegistry.load(defaultActionDefinitionsPath());

    expect(registry.validatePayload("unknown.action", "1", {})).toEqual({
      ok: false,
      errors: ["Unknown action definition: unknown.action@1"],
    });
    expect(
      registry.validatePayload("contact.merge", "1", { primaryContactId: "contact-1" }),
    ).toEqual({
      ok: false,
      errors: ["Missing required payload field 'secondaryContactId'."],
    });
    expect(
      registry.validatePayload("contact.memory.add", "1", {
        contactId: "contact-1",
        body: "Works on Cued",
        evidence: "message-1",
      }),
    ).toEqual({
      ok: false,
      errors: ["Payload field 'evidence' must be object."],
    });
  });

  it("rejects duplicate definitions", () => {
    const dir = mkdtempSync(join(tmpdir(), "cued-actions-registry-"));
    tempDirs.push(dir);
    const path = join(dir, "actions");
    mkdirSync(path);
    writeFileSync(
      join(path, "one.json"),
      JSON.stringify({
        type: "contact.merge",
        version: "1",
        description: "Merge contacts",
        module: "actions/contact-merge.cjs",
        payload: { required: {}, optional: {} },
      }),
    );
    writeFileSync(
      join(path, "two.json"),
      JSON.stringify({
        type: "contact.merge",
        version: "1",
        description: "Merge contacts again",
        module: "actions/contact-merge-duplicate.cjs",
        payload: { required: {}, optional: {} },
      }),
    );

    expect(() => ActionDefinitionRegistry.load(path)).toThrow(
      "Duplicate action definition: contact.merge@1",
    );
  });

  it("loads definitions and executors from an explicit skill root", () => {
    const skillRoot = mkdtempSync(join(tmpdir(), "cued-external-skill-"));
    tempDirs.push(skillRoot);
    const actionsDir = join(skillRoot, "actions");
    mkdirSync(actionsDir);
    writeFileSync(join(skillRoot, "SKILL.md"), "---\nname: cued-test\n---\n");
    writeFileSync(
      join(actionsDir, "test.echo.json"),
      JSON.stringify({
        type: "test.echo",
        version: "1",
        description: "Echo test action",
        module: "actions/test-echo.cjs",
        payload: { required: {}, optional: {} },
      }),
    );
    writeFileSync(
      join(actionsDir, "test-echo.cjs"),
      "module.exports = { execute: () => ({ result: { ok: true }, effects: [] }) };\n",
    );
    process.env.CUED_SKILL_ROOT = skillRoot;

    const definition = ActionDefinitionRegistry.load().get("test.echo", "1");
    expect(definition?.skillRoot).toBe(skillRoot);
    expect(definition?.skillName).toBe(basename(skillRoot));
    expect(definition?.sourcePath).toBe(join(actionsDir, "test.echo.json"));
    expect(definition ? loadActionExecutor(definition) : null).not.toBeNull();
  });

  it("reloads modified local executor modules", () => {
    const skillRoot = mkdtempSync(join(tmpdir(), "cued-reloadable-skill-"));
    tempDirs.push(skillRoot);
    const actionsDir = join(skillRoot, "actions");
    mkdirSync(actionsDir);
    writeFileSync(join(skillRoot, "SKILL.md"), "---\nname: reloadable\n---\n");
    writeFileSync(
      join(actionsDir, "test.reload.json"),
      JSON.stringify({
        type: "test.reload",
        version: "1",
        description: "Reloadable test action",
        module: "actions/test-reload.cjs",
        payload: { required: {}, optional: {} },
      }),
    );
    const modulePath = join(actionsDir, "test-reload.cjs");
    writeFileSync(
      modulePath,
      "module.exports = { execute: () => ({ result: { version: 1 }, effects: [] }) };\n",
    );
    process.env.CUED_SKILL_ROOT = skillRoot;

    const definition = ActionDefinitionRegistry.load().get("test.reload", "1");
    const firstExecutor = definition ? loadActionExecutor(definition) : null;
    expect((firstExecutor as unknown as () => { result: { version: number } })().result).toEqual({
      version: 1,
    });

    writeFileSync(
      modulePath,
      "module.exports = { execute: () => ({ result: { version: 2 }, effects: [] }) };\n",
    );
    const secondExecutor = definition ? loadActionExecutor(definition) : null;
    expect((secondExecutor as unknown as () => { result: { version: number } })().result).toEqual({
      version: 2,
    });
  });

  it("loads definitions from multiple explicit skill roots", () => {
    const firstRoot = mkdtempSync(join(tmpdir(), "cued-external-skill-a-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "cued-external-skill-b-"));
    tempDirs.push(firstRoot, secondRoot);
    for (const [root, type] of [
      [firstRoot, "test.first"],
      [secondRoot, "test.second"],
    ] as const) {
      const actionsDir = join(root, "actions");
      mkdirSync(actionsDir);
      writeFileSync(join(root, "SKILL.md"), `---\nname: ${type}\n---\n`);
      writeFileSync(
        join(actionsDir, `${type}.json`),
        JSON.stringify({
          type,
          version: "1",
          description: `${type} action`,
          module: "actions/execute.cjs",
          payload: { required: {}, optional: {} },
        }),
      );
      writeFileSync(
        join(actionsDir, "execute.cjs"),
        "module.exports = { execute: () => ({ result: { ok: true }, effects: [] }) };\n",
      );
    }
    process.env.CUED_SKILL_ROOTS = [firstRoot, secondRoot].join(delimiter);
    delete process.env.CUED_SKILL_ROOT;

    expect(
      ActionDefinitionRegistry.load()
        .list()
        .map((definition) => definition.type),
    ).toEqual(["test.first", "test.second"]);
  });

  it("lets daemon-local skills override bundled skills by skill name", () => {
    const homeRoot = mkdtempSync(join(tmpdir(), "cued-local-skill-home-"));
    tempDirs.push(homeRoot);
    const localSkillRoot = join(homeRoot, "skills", "cued");
    const actionsDir = join(localSkillRoot, "actions");
    mkdirSync(actionsDir, { recursive: true });
    writeFileSync(join(localSkillRoot, "SKILL.md"), "---\nname: cued\n---\n");
    writeFileSync(
      join(actionsDir, "test.local.json"),
      JSON.stringify({
        type: "test.local",
        version: "1",
        description: "Local override action",
        module: "actions/test-local.cjs",
        payload: { required: {}, optional: {} },
      }),
    );
    writeFileSync(
      join(actionsDir, "test-local.cjs"),
      "module.exports = { execute: () => ({ result: { ok: true }, effects: [] }) };\n",
    );
    process.env.CUED_HOME = homeRoot;

    expect(defaultCuedSkillRoots()[0]).toBe(localSkillRoot);
    expect(
      ActionDefinitionRegistry.load()
        .list()
        .map((definition) => definition.type),
    ).toEqual(["test.local"]);
  });

  it("rejects duplicate definitions across skill roots", () => {
    const firstRoot = mkdtempSync(join(tmpdir(), "cued-external-skill-a-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "cued-external-skill-b-"));
    tempDirs.push(firstRoot, secondRoot);
    for (const root of [firstRoot, secondRoot]) {
      const actionsDir = join(root, "actions");
      mkdirSync(actionsDir);
      writeFileSync(join(root, "SKILL.md"), "---\nname: duplicate-test\n---\n");
      writeFileSync(
        join(actionsDir, "test.echo.json"),
        JSON.stringify({
          type: "test.echo",
          version: "1",
          description: "Duplicate action",
          module: "actions/execute.cjs",
          payload: { required: {}, optional: {} },
        }),
      );
      writeFileSync(
        join(actionsDir, "execute.cjs"),
        "module.exports = { execute: () => ({ result: { ok: true }, effects: [] }) };\n",
      );
    }
    process.env.CUED_SKILL_ROOTS = [firstRoot, secondRoot].join(delimiter);
    delete process.env.CUED_SKILL_ROOT;

    expect(() => ActionDefinitionRegistry.load()).toThrow(
      "Duplicate action definition: test.echo@1",
    );
  });
});
