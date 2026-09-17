import { parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";
import semver from "semver";
import { z } from "zod";

export const COMPATIBILITY_MARKER_MAX_BYTES = 16 * 1024;

const canonicalSemverSchema = z.string().refine(
  (value) => semver.valid(value) === value,
  "Expected a canonical semantic version",
);

const safeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "Expected a safe integer");

export const compatibilityMarkerV1Schema = z.object({
  markerFormat: z.literal(1),
  highestDaemonVersion: canonicalSemverSchema,
  minimumDaemonVersion: canonicalSemverSchema,
  serviceSupportFloor: canonicalSemverSchema,
  serviceSupportNotBefore: safeNonnegativeIntegerSchema,
  storageEpoch: safeNonnegativeIntegerSchema.refine((value) => value > 0),
  generation: safeNonnegativeIntegerSchema,
});

export type CompatibilityMarkerV1 = z.infer<typeof compatibilityMarkerV1Schema>;

const assertNoDuplicateKeys = (node: JsonNode): void => {
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key !== "string") throw new Error("Invalid compatibility marker property");
      if (keys.has(key)) throw new Error(`Duplicate compatibility marker key: ${key}`);
      keys.add(key);
      const value = property.children?.[1];
      if (value) assertNoDuplicateKeys(value);
    }
    return;
  }
  for (const child of node.children ?? []) assertNoDuplicateKeys(child);
};

export const parseCompatibilityMarker = (
  bytes: Uint8Array,
): CompatibilityMarkerV1 => {
  if (bytes.byteLength === 0 || bytes.byteLength > COMPATIBILITY_MARKER_MAX_BYTES) {
    throw new Error("Compatibility marker size is invalid");
  }
  const buffer = Buffer.from(bytes);
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    throw new Error("Compatibility marker must not contain a BOM");
  }
  if (buffer.at(-1) !== 0x0a) {
    throw new Error("Compatibility marker must end with exactly one newline");
  }
  const body = buffer.subarray(0, -1).toString("utf8");
  if (body.endsWith("\n") || body.endsWith("\r")) {
    throw new Error("Compatibility marker contains trailing data");
  }

  const errors: ParseError[] = [];
  const root = parseTree(body, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (!root || root.type !== "object" || errors.length > 0) {
    throw new Error("Compatibility marker is not one valid JSON object");
  }
  if (root.offset !== 0 || root.length !== body.length) {
    throw new Error("Compatibility marker contains trailing data");
  }
  assertNoDuplicateKeys(root);
  return compatibilityMarkerV1Schema.parse(JSON.parse(body));
};

export const serializeCompatibilityMarker = (
  marker: CompatibilityMarkerV1,
): Buffer => {
  const parsed = compatibilityMarkerV1Schema.parse(marker);
  return Buffer.from(
    `${JSON.stringify({
      markerFormat: parsed.markerFormat,
      highestDaemonVersion: parsed.highestDaemonVersion,
      minimumDaemonVersion: parsed.minimumDaemonVersion,
      serviceSupportFloor: parsed.serviceSupportFloor,
      serviceSupportNotBefore: parsed.serviceSupportNotBefore,
      storageEpoch: parsed.storageEpoch,
      generation: parsed.generation,
    })}\n`,
    "utf8",
  );
};

const maxVersion = (left: string, right: string): string =>
  semver.gte(left, right) ? left : right;

export const mergeCompatibilityMarkers = (
  ...markers: [CompatibilityMarkerV1, ...CompatibilityMarkerV1[]]
): CompatibilityMarkerV1 => ({
  markerFormat: 1,
  highestDaemonVersion: markers.reduce(
    (version, marker) => maxVersion(version, marker.highestDaemonVersion),
    markers[0].highestDaemonVersion,
  ),
  minimumDaemonVersion: markers.reduce(
    (version, marker) => maxVersion(version, marker.minimumDaemonVersion),
    markers[0].minimumDaemonVersion,
  ),
  serviceSupportFloor: markers.reduce(
    (version, marker) => maxVersion(version, marker.serviceSupportFloor),
    markers[0].serviceSupportFloor,
  ),
  serviceSupportNotBefore: Math.max(
    ...markers.map(({ serviceSupportNotBefore }) => serviceSupportNotBefore),
  ),
  storageEpoch: Math.max(...markers.map(({ storageEpoch }) => storageEpoch)),
  generation: Math.max(...markers.map(({ generation }) => generation)) + 1,
});
