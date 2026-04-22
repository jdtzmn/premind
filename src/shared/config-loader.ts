import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { premindConfigSchema, type PremindConfig } from "./schema.ts"

/**
 * Premind's config lives outside opencode.jsonc so we don't have to fight
 * opencode's strict top-level schema. The loader reads (in increasing
 * precedence):
 *
 *   1. premindConfigSchema defaults
 *   2. A user JSONC/JSON file, default ~/.config/opencode/premind.jsonc
 *   3. Environment variables of the form PREMIND_<FIELD_IN_UPPER_SNAKE>
 *
 * Malformed files and bad env values are logged (once each) and ignored —
 * premind must never fail to start because config is wrong.
 */

export type LoadPremindConfigOptions = {
  /** Absolute path to the user config file. Defaults to getDefaultUserConfigPath(). */
  userConfigPath?: string
  /** Env bag to read PREMIND_* overrides from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Warning sink. Defaults to console.warn. */
  logger?: (message: string) => void
}

/**
 * Resolve the path to the user's premind config file.
 *
 * Kept alongside opencode's own config so users find it next to what they
 * already know. Follows opencode-mem's convention.
 */
export const getDefaultUserConfigPath = (): string => {
  const home = os.homedir()
  return path.join(home, ".config", "opencode", "premind.jsonc")
}

/**
 * Load the resolved PremindConfig, applying defaults, user config, and env
 * overrides. Never throws.
 */
export const loadPremindConfig = (options: LoadPremindConfigOptions = {}): PremindConfig => {
  const userConfigPath = options.userConfigPath ?? getDefaultUserConfigPath()
  const env = options.env ?? process.env
  const logger = options.logger ?? ((msg) => console.warn(msg))

  // Step 1: start from schema defaults.
  let current = premindConfigSchema.parse({})

  // Step 2: layer user config file on top.
  const fileConfig = readUserConfigFile(userConfigPath, logger)
  if (fileConfig !== undefined) {
    const merged = { ...current, ...fileConfig }
    const parsed = premindConfigSchema.safeParse(merged)
    if (parsed.success) {
      current = parsed.data
    } else {
      logger(
        `premind: config file at ${userConfigPath} failed schema validation — using defaults. ${parsed.error.message}`,
      )
    }
  }

  // Step 3: layer env var overrides on top.
  const envOverrides = collectEnvOverrides(env, logger)
  if (envOverrides !== undefined && Object.keys(envOverrides).length > 0) {
    const merged = { ...current, ...envOverrides }
    const parsed = premindConfigSchema.safeParse(merged)
    if (parsed.success) {
      current = parsed.data
    } else {
      logger(
        `premind: env var overrides failed schema validation — using prior config. ${parsed.error.message}`,
      )
    }
  }

  return current
}

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
): "created" | "exists" | "failed" => {
  if (fs.existsSync(userConfigPath)) return "exists"
  try {
    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true })
    fs.writeFileSync(userConfigPath, CONFIG_TEMPLATE, "utf8")
    return "created"
  } catch (error) {
    logger(
      `premind: could not create config template at ${userConfigPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return "failed"
  }
}

// -----------------------------------------------------------------------------

const readUserConfigFile = (
  userConfigPath: string,
  logger: (message: string) => void,
): Record<string, unknown> | undefined => {
  // Also try the .json sibling for convenience.
  const candidates = [userConfigPath]
  if (userConfigPath.endsWith(".jsonc")) {
    candidates.push(userConfigPath.slice(0, -"c".length))
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    try {
      const raw = fs.readFileSync(candidate, "utf8")
      const stripped = stripJsoncComments(raw)
      const trimmed = stripped.trim()
      if (trimmed.length === 0) return {}
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        logger(`premind: config file at ${candidate} must be a JSON object — using defaults.`)
        return undefined
      }
      return parsed as Record<string, unknown>
    } catch (error) {
      logger(
        `premind: could not parse config file at ${candidate}: ${
          error instanceof Error ? error.message : String(error)
        } — using defaults.`,
      )
      return undefined
    }
  }
  return undefined
}

// -----------------------------------------------------------------------------
// Env var handling. The schema is the source of truth: we derive
// PREMIND_<UPPER_SNAKE> names from the schema's keys so adding a field
// automatically makes it env-overridable.

const schemaShape = premindConfigSchema.shape as Record<string, import("zod").ZodTypeAny>

const camelToUpperSnake = (name: string): string =>
  name
    .replace(/([A-Z])/g, "_$1")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase()
    .replace(/^_+/, "")

const envVarForField = (field: string): string => `PREMIND_${camelToUpperSnake(field)}`

const parseBooleanEnv = (value: string): boolean | undefined => {
  const v = value.trim().toLowerCase()
  if (v === "true" || v === "1") return true
  if (v === "false" || v === "0") return false
  return undefined
}

const parseIntegerEnv = (value: string): number | undefined => {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  // Reject any non-integer input, including "1.5", "abc", "12x".
  if (!/^-?\d+$/.test(trimmed)) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

const collectEnvOverrides = (
  env: NodeJS.ProcessEnv,
  logger: (message: string) => void,
): Record<string, unknown> | undefined => {
  const overrides: Record<string, unknown> = {}
  // Build a map of expected env var names for O(1) lookup.
  const expected = new Map<string, { field: string; zodType: import("zod").ZodTypeAny }>()
  for (const [field, zodType] of Object.entries(schemaShape)) {
    expected.set(envVarForField(field), { field, zodType })
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !key.startsWith("PREMIND_")) continue
    const match = expected.get(key)
    if (!match) continue // Unknown PREMIND_* — ignored silently.

    const coerced = coerceEnvValue(match.zodType, value)
    if (coerced === undefined) {
      logger(`premind: env var ${key}=${JSON.stringify(value)} could not be coerced — ignored.`)
      continue
    }
    overrides[match.field] = coerced
  }

  return overrides
}

const coerceEnvValue = (zodType: import("zod").ZodTypeAny, raw: string): unknown => {
  // Unwrap ZodDefault / ZodOptional to get to the underlying primitive type.
  let inner: import("zod").ZodTypeAny = zodType
  while (
    (inner as unknown as { _def: { innerType?: import("zod").ZodTypeAny } })._def.innerType
  ) {
    inner = (inner as unknown as { _def: { innerType: import("zod").ZodTypeAny } })._def.innerType
  }
  const typeName = (inner as unknown as { _def: { typeName?: string } })._def.typeName
  if (typeName === "ZodBoolean") return parseBooleanEnv(raw)
  if (typeName === "ZodNumber") return parseIntegerEnv(raw)
  if (typeName === "ZodString") return raw
  return undefined
}

// -----------------------------------------------------------------------------
// JSONC: strip // line comments and /* */ block comments, and trailing commas
// before } or ]. Keeps comments inside strings intact. Small and self-contained
// so we don't pull in a dependency for a single-file loader.

const stripJsoncComments = (input: string): string => {
  let out = ""
  let i = 0
  let inString = false
  let stringQuote = ""
  while (i < input.length) {
    const ch = input[i]
    const next = input[i + 1]

    if (inString) {
      out += ch
      if (ch === "\\" && i + 1 < input.length) {
        out += input[i + 1]
        i += 2
        continue
      }
      if (ch === stringQuote) {
        inString = false
      }
      i++
      continue
    }

    if (ch === '"' || ch === "'") {
      inString = true
      stringQuote = ch
      out += ch
      i++
      continue
    }

    if (ch === "/" && next === "/") {
      // Skip until newline (preserve the newline).
      i += 2
      while (i < input.length && input[i] !== "\n") i++
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  // Strip trailing commas: , followed by optional whitespace then } or ].
  return out.replace(/,(\s*[}\]])/g, "$1")
}

// -----------------------------------------------------------------------------
// Template written by ensureUserConfigTemplate. All example values are
// commented out so the file parses to {} and yields schema defaults.

const CONFIG_TEMPLATE = `// premind configuration
//
// This file lives outside opencode.jsonc so opencode's schema validator does
// not reject it. All settings below are commented out; uncomment to customize.
// Any field can also be overridden via environment variables of the form
// PREMIND_<FIELD_IN_UPPER_SNAKE>.

{
  // How long a session must be idle before queued PR updates are delivered.
  // Minimum 5000. Env: PREMIND_IDLE_DELIVERY_THRESHOLD_MS
  // "idleDeliveryThresholdMs": 60000
}
`
