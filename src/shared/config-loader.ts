import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { premindConfigSchema, type PremindConfig } from "./schema.ts";

/**
 * Premind's config lives outside opencode.jsonc so we don't have to fight
 * opencode's strict top-level schema. The loader reads (in increasing
 * precedence):
 *
 *   1. premindConfigSchema defaults
 *   2. A user JSONC/JSON file, default ~/.config/premind/premind.jsonc
 *      (with ~/.config/opencode/premind.jsonc as a v0.2 compatibility fallback)
 *   3. Environment variables of the form PREMIND_<FIELD_IN_UPPER_SNAKE>
 *
 * Malformed files and bad env values are logged (once each) and ignored —
 * premind must never fail to start because config is wrong.
 */

export type LoadPremindConfigOptions = {
  /** Absolute path to the user config file. Defaults to getDefaultUserConfigPath(). */
  userConfigPath?: string;
  /** Legacy OpenCode config path. Defaults to getLegacyUserConfigPath(). */
  legacyUserConfigPath?: string;
  /** Env bag to read PREMIND_* overrides from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Warning sink. Defaults to console.warn. */
  logger?: (message: string) => void;
};

/**
 * Resolve the path to the user's premind config file.
 *
 * This is host-neutral. The old OpenCode-specific location remains a v0.2
 * fallback so existing users can migrate without losing their settings.
 */
export const getDefaultUserConfigPath = (): string => {
  return path.join(os.homedir(), ".config", "premind", "premind.jsonc");
};

export const getLegacyUserConfigPath = (): string => {
  return path.join(os.homedir(), ".config", "opencode", "premind.jsonc");
};

/**
 * Load the resolved PremindConfig, applying defaults, user config, and env
 * overrides. Never throws.
 */
export const loadPremindConfig = (
  options: LoadPremindConfigOptions = {},
): PremindConfig => {
  const userConfigPath = options.userConfigPath ?? getDefaultUserConfigPath();
  const legacyUserConfigPath =
    options.legacyUserConfigPath ??
    (options.userConfigPath ? undefined : getLegacyUserConfigPath());
  const env = options.env ?? process.env;
  const logger = options.logger ?? ((msg) => console.warn(msg));

  // Step 1: start from schema defaults.
  let current = premindConfigSchema.parse({});

  // Step 2: layer user config file on top.
  const explicitPrimary = legacyUserConfigPath
    ? undefined
    : readConfigCandidate(userConfigPath, logger);
  const fileConfig = legacyUserConfigPath
    ? readUserConfigFile(userConfigPath, legacyUserConfigPath, logger)
    : explicitPrimary?.found
      ? explicitPrimary.config
      : undefined;
  if (fileConfig !== undefined) {
    const merged = { ...current, ...fileConfig };
    const parsed = premindConfigSchema.safeParse(merged);
    if (parsed.success) {
      current = parsed.data;
    } else {
      logger(
        `premind: config file at ${userConfigPath} failed schema validation — using defaults. ${parsed.error.message}`,
      );
    }
  }

  // Step 3: layer env var overrides on top.
  const envOverrides = collectEnvOverrides(env, logger);
  if (envOverrides !== undefined && Object.keys(envOverrides).length > 0) {
    const merged = { ...current, ...envOverrides };
    const parsed = premindConfigSchema.safeParse(merged);
    if (parsed.success) {
      current = parsed.data;
    } else {
      logger(
        `premind: env var overrides failed schema validation — using prior config. ${parsed.error.message}`,
      );
    }
  }

  return current;
};

/**
 * Create the template config file at `userConfigPath` if it doesn't exist.
 * Returns one of:
 *   - "created": wrote the template
 *   - "exists":  file already present, left untouched
 *   - "failed":  couldn't create (e.g., permission denied) — logged, swallowed
 *
 * Never throws. Callers should treat "failed" as non-fatal.
 */
export const ensureUserConfigTemplate = (
  userConfigPath: string,
  logger: (message: string) => void = (msg) => console.warn(msg),
  legacyUserConfigPath?: string,
): "created" | "exists" | "failed" => {
  if (
    hasConfigCandidate(
      userConfigPath,
      ...(legacyUserConfigPath ? [legacyUserConfigPath] : []),
    )
  )
    return "exists";
  try {
    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    fs.writeFileSync(userConfigPath, CONFIG_TEMPLATE, "utf8");
    return "created";
  } catch (error) {
    logger(
      `premind: could not create config template at ${userConfigPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return "failed";
  }
};

// -----------------------------------------------------------------------------

const configCandidates = (configPath: string) =>
  configPath.endsWith(".jsonc")
    ? [configPath, configPath.slice(0, -"c".length)]
    : [configPath];

const hasConfigCandidate = (...configPaths: string[]) =>
  configPaths.some((configPath) =>
    configCandidates(configPath).some((candidate) => fs.existsSync(candidate)),
  );

type ConfigReadResult =
  | { found: false }
  | { found: true; config?: Record<string, unknown>; path: string };

const readConfigCandidate = (
  configPath: string,
  logger: (message: string) => void,
): ConfigReadResult => {
  for (const candidate of configCandidates(configPath)) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const trimmed = stripJsoncComments(
        fs.readFileSync(candidate, "utf8"),
      ).trim();
      if (trimmed.length === 0)
        return { found: true, config: {}, path: candidate };
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        logger(`premind: config file at ${candidate} must be a JSON object.`);
        return { found: true, path: candidate };
      }
      return {
        found: true,
        config: parsed as Record<string, unknown>,
        path: candidate,
      };
    } catch (error) {
      logger(
        `premind: could not parse config file at ${candidate}: ${error instanceof Error ? error.message : String(error)}.`,
      );
      return { found: true, path: candidate };
    }
  }
  return { found: false };
};

const readUserConfigFile = (
  userConfigPath: string,
  legacyUserConfigPath: string,
  logger: (message: string) => void,
): Record<string, unknown> | undefined => {
  const primary = readConfigCandidate(userConfigPath, logger);
  // A valid empty primary file intentionally masks legacy settings. A malformed
  // primary remains recoverable during v0.2 by trying the legacy path.
  if (primary.found && primary.config !== undefined) return primary.config;

  const legacy = readConfigCandidate(legacyUserConfigPath, logger);
  if (legacy.found && legacy.config !== undefined) {
    logger(
      `premind: using legacy config at ${legacy.path}; move it to ${userConfigPath} before the v0.3 fallback removal.`,
    );
    return legacy.config;
  }
  return undefined;
};

// -----------------------------------------------------------------------------
// Env var handling. The schema is the source of truth: we derive
// PREMIND_<UPPER_SNAKE> names from the schema's keys so adding a field
// automatically makes it env-overridable.

const schemaShape = premindConfigSchema.shape as Record<
  string,
  import("zod").ZodTypeAny
>;

const camelToUpperSnake = (name: string): string =>
  name
    .replace(/([A-Z])/g, "_$1")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase()
    .replace(/^_+/, "");

const envVarForField = (field: string): string =>
  `PREMIND_${camelToUpperSnake(field)}`;

const parseBooleanEnv = (value: string): boolean | undefined => {
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
};

const parseIntegerEnv = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // Reject any non-integer input, including "1.5", "abc", "12x".
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
};

const collectEnvOverrides = (
  env: NodeJS.ProcessEnv,
  logger: (message: string) => void,
): Record<string, unknown> | undefined => {
  const overrides: Record<string, unknown> = {};
  // Build a map of expected env var names for O(1) lookup.
  const expected = new Map<
    string,
    { field: string; zodType: import("zod").ZodTypeAny }
  >();
  for (const [field, zodType] of Object.entries(schemaShape)) {
    expected.set(envVarForField(field), { field, zodType });
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !key.startsWith("PREMIND_")) continue;
    const match = expected.get(key);
    if (!match) continue; // Unknown PREMIND_* — ignored silently.

    const coerced = coerceEnvValue(match.zodType, value);
    if (coerced === undefined) {
      logger(
        `premind: env var ${key}=${JSON.stringify(value)} could not be coerced — ignored.`,
      );
      continue;
    }
    overrides[match.field] = coerced;
  }

  return overrides;
};

const coerceEnvValue = (
  zodType: import("zod").ZodTypeAny,
  raw: string,
): string | number | boolean | undefined => {
  // Zod's public instance classes are more stable than private _def metadata.
  if (zodType instanceof z.ZodBoolean) return parseBooleanEnv(raw);
  if (zodType instanceof z.ZodNumber) return parseIntegerEnv(raw);
  if (zodType instanceof z.ZodString) return raw;
  const inner =
    zodType instanceof z.ZodDefault || zodType instanceof z.ZodOptional
      ? zodType._def.innerType
      : undefined;
  return inner ? coerceEnvValue(inner, raw) : undefined;
};

// -----------------------------------------------------------------------------
// JSONC: strip // line comments and /* */ block comments, and trailing commas
// before } or ]. Keeps comments inside strings intact. Small and self-contained
// so we don't pull in a dependency for a single-file loader.

const stripJsoncComments = (input: string): string => {
  let out = "";
  let i = 0;
  let inString = false;
  let stringQuote = "";
  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringQuote) {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      // Skip until newline (preserve the newline).
      i += 2;
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/"))
        i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Strip trailing commas: , followed by optional whitespace then } or ].
  return out.replace(/,(\s*[}\]])/g, "$1");
};

// -----------------------------------------------------------------------------
// Template written by ensureUserConfigTemplate. All example values are
// commented out so the file parses to {} and yields schema defaults.

const CONFIG_TEMPLATE = `// premind configuration
//
// This file is host-neutral. All settings below are commented out; uncomment to customize.
// Any field can also be overridden via environment variables of the form
// PREMIND_<FIELD_IN_UPPER_SNAKE>.

{
  // OpenCode-only: wait before queued PR updates are delivered.
  // Claude Code delivers only at a Stop boundary. Minimum 5000. Env: PREMIND_IDLE_DELIVERY_THRESHOLD_MS
  // "idleDeliveryThresholdMs": 60000
}
`;
