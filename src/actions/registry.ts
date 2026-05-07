import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ACTION_PAYLOAD_FIELD_TYPE_VALUES = ["string", "number", "boolean", "object"] as const;
export type ActionPayloadFieldType = (typeof ACTION_PAYLOAD_FIELD_TYPE_VALUES)[number];

export interface ActionDefinition {
  type: string;
  version: string;
  description: string;
  module: string;
  skillName: string;
  skillRoot: string;
  sourcePath: string;
  postExecution: {
    rebuildProjection: boolean;
  };
  requiresApprovalDefault: boolean;
  payload: {
    required: Record<string, ActionPayloadFieldType>;
    optional: Record<string, ActionPayloadFieldType>;
  };
}

interface ActionDefinitionManifest {
  version: number;
  actions: ActionDefinition[];
}

export interface ActionPayloadValidationResult {
  ok: boolean;
  errors: string[];
}

function moduleRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function uniqueExistingSkillRoots(
  paths: string[],
  options: { bySkillName?: boolean } = {},
): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const path of paths) {
    const root = resolve(path);
    const key = options.bySkillName ? basename(root) : root;
    if (seen.has(key) || !existsSync(join(root, "SKILL.md"))) {
      continue;
    }
    seen.add(key);
    roots.push(root);
  }
  return roots;
}

function listSkillRoots(parentPath: string): string[] {
  if (!existsSync(parentPath) || !statSync(parentPath).isDirectory()) {
    return [];
  }
  return readdirSync(parentPath)
    .sort()
    .map((entry) => join(parentPath, entry))
    .filter((entryPath) => existsSync(join(entryPath, "SKILL.md")));
}

function envSkillRoots(): string[] {
  const raw = process.env.CUED_SKILL_ROOTS ?? process.env.CUED_SKILL_ROOT;
  if (!raw) {
    return [];
  }
  return raw
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function defaultCuedSkillRoots(): string[] {
  const currentRoot = moduleRoot();
  const cuedHome = process.env.CUED_HOME ?? join(homedir(), ".cued");
  const explicitRoots = uniqueExistingSkillRoots(envSkillRoots());
  if (explicitRoots.length > 0) {
    return explicitRoots;
  }

  return uniqueExistingSkillRoots(
    [
      ...listSkillRoots(join(cuedHome, "skills")),
      join(cuedHome, "skills", "cued"),
      ...listSkillRoots(join(currentRoot, "skills")),
      ...listSkillRoots(join(currentRoot, "..", "skills")),
      join(currentRoot, "skills", "cued"),
      join(currentRoot, "..", "skills", "cued"),
    ],
    { bySkillName: true },
  );
}

export function defaultCuedSkillRoot(): string {
  const roots = defaultCuedSkillRoots();
  if (roots.length === 0) {
    return join(moduleRoot(), "skills", "cued");
  }
  return roots[0]!;
}

export function defaultActionDefinitionsPath(): string {
  return join(defaultCuedSkillRoot(), "actions");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFieldType(value: unknown): value is ActionPayloadFieldType {
  return ACTION_PAYLOAD_FIELD_TYPE_VALUES.includes(value as ActionPayloadFieldType);
}

function parsePayloadShape(value: unknown, actionType: string): ActionDefinition["payload"] {
  if (!isPlainObject(value)) {
    throw new Error(`Action '${actionType}' payload definition must be an object.`);
  }
  const required = isPlainObject(value.required) ? value.required : {};
  const optional = isPlainObject(value.optional) ? value.optional : {};

  for (const [field, type] of [...Object.entries(required), ...Object.entries(optional)]) {
    if (!isFieldType(type)) {
      throw new Error(
        `Action '${actionType}' payload field '${field}' must use one of: ${ACTION_PAYLOAD_FIELD_TYPE_VALUES.join(", ")}.`,
      );
    }
  }

  return {
    required: required as Record<string, ActionPayloadFieldType>,
    optional: optional as Record<string, ActionPayloadFieldType>,
  };
}

function parseActionDefinition(
  raw: unknown,
  index: number,
  sourcePath: string,
  skillRoot: string,
): ActionDefinition {
  if (!isPlainObject(raw)) {
    throw new Error(`Action definition at index ${index} must be an object.`);
  }
  const type = typeof raw.type === "string" ? raw.type.trim() : "";
  const version = typeof raw.version === "string" ? raw.version.trim() : "";
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  const module = typeof raw.module === "string" ? raw.module.trim() : "";
  if (!type || !version || !description || !module) {
    throw new Error(
      `Action definition at index ${index} must include type, version, description, and module: ${sourcePath}`,
    );
  }

  return {
    type,
    version,
    description,
    module,
    skillName: basename(skillRoot),
    skillRoot,
    sourcePath,
    postExecution: {
      rebuildProjection:
        isPlainObject(raw.postExecution) && raw.postExecution.rebuildProjection === true,
    },
    requiresApprovalDefault: raw.requiresApprovalDefault !== false,
    payload: parsePayloadShape(raw.payload, type),
  };
}

function assertUniqueDefinitions(actions: ActionDefinition[]): void {
  const seen = new Set<string>();
  for (const definition of actions) {
    const key = `${definition.type}@${definition.version}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate action definition: ${key}`);
    }
    seen.add(key);
  }
}

function parseManifest(
  raw: unknown,
  sourcePath: string,
  skillRoot: string,
): ActionDefinitionManifest {
  if (!isPlainObject(raw)) {
    throw new Error(`Action definition manifest must be an object: ${sourcePath}`);
  }
  if (raw.version !== 1) {
    throw new Error(`Unsupported action definition manifest version in ${sourcePath}.`);
  }
  if (!Array.isArray(raw.actions)) {
    throw new Error(`Action definition manifest must include an actions array: ${sourcePath}`);
  }

  const actions = raw.actions.map((value, index) =>
    parseActionDefinition(value, index, sourcePath, skillRoot),
  );
  assertUniqueDefinitions(actions);

  return { version: 1, actions };
}

function loadActionDefinitions(path: string): ActionDefinition[] {
  if (!existsSync(path)) {
    return [];
  }
  if (statSync(path).isDirectory()) {
    const skillRoot = dirname(path);
    const actions = readdirSync(path)
      .filter((fileName) => fileName.endsWith(".json"))
      .sort()
      .map((fileName, index) => {
        const filePath = join(path, fileName);
        return parseActionDefinition(
          JSON.parse(readFileSync(filePath, "utf8")) as unknown,
          index,
          filePath,
          skillRoot,
        );
      });
    assertUniqueDefinitions(actions);
    return actions;
  }
  return parseManifest(JSON.parse(readFileSync(path, "utf8")) as unknown, path, dirname(path))
    .actions;
}

function loadDefaultActionDefinitions(): ActionDefinition[] {
  return defaultCuedSkillRoots().flatMap((skillRoot) =>
    loadActionDefinitions(join(skillRoot, "actions")),
  );
}

export class ActionDefinitionRegistry {
  private readonly definitions = new Map<string, ActionDefinition>();

  constructor(definitions: ActionDefinition[]) {
    for (const definition of definitions) {
      const key = this.key(definition.type, definition.version);
      if (this.definitions.has(key)) {
        throw new Error(`Duplicate action definition: ${key}`);
      }
      this.definitions.set(key, definition);
    }
  }

  static load(path?: string): ActionDefinitionRegistry {
    return new ActionDefinitionRegistry(
      path ? loadActionDefinitions(path) : loadDefaultActionDefinitions(),
    );
  }

  list(): ActionDefinition[] {
    return [...this.definitions.values()].sort((left, right) =>
      `${left.type}@${left.version}`.localeCompare(`${right.type}@${right.version}`),
    );
  }

  get(type: string, version = "1"): ActionDefinition | null {
    return this.definitions.get(this.key(type, version)) ?? null;
  }

  validatePayload(type: string, version: string, payload: unknown): ActionPayloadValidationResult {
    const definition = this.get(type, version);
    if (!definition) {
      return { ok: false, errors: [`Unknown action definition: ${type}@${version}`] };
    }
    if (!isPlainObject(payload)) {
      return { ok: false, errors: [`Action '${type}' payload must be a JSON object.`] };
    }

    const errors: string[] = [];
    for (const [field, expectedType] of Object.entries(definition.payload.required)) {
      if (!(field in payload)) {
        errors.push(`Missing required payload field '${field}'.`);
        continue;
      }
      if (!matchesFieldType(payload[field], expectedType)) {
        errors.push(`Payload field '${field}' must be ${expectedType}.`);
      }
    }
    for (const [field, expectedType] of Object.entries(definition.payload.optional)) {
      if (
        field in payload &&
        payload[field] !== null &&
        !matchesFieldType(payload[field], expectedType)
      ) {
        errors.push(`Payload field '${field}' must be ${expectedType}.`);
      }
    }

    return { ok: errors.length === 0, errors };
  }

  private key(type: string, version: string): string {
    return `${type}@${version}`;
  }
}

export function actionRequiresProjectionRebuild(action: {
  action_type: string;
  action_version: string;
}): boolean {
  return (
    ActionDefinitionRegistry.load().get(action.action_type, action.action_version)?.postExecution
      .rebuildProjection === true
  );
}

function matchesFieldType(value: unknown, expectedType: ActionPayloadFieldType): boolean {
  switch (expectedType) {
    case "object":
      return isPlainObject(value);
    case "string":
    case "number":
    case "boolean":
      return typeof value === expectedType;
  }
}
