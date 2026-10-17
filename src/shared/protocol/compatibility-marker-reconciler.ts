import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import semver from "semver";
import {
  readCompatibilityMarkerFile,
  withCompatibilityMarkerLock,
  writeCompatibilityMarkerFileDurably,
  type CompatibilityMarkerPaths,
} from "./compatibility-marker-file.ts";
import {
  mergeCompatibilityMarkers,
  parseCompatibilityMarker,
  serializeCompatibilityMarker,
  type CompatibilityMarkerV1,
} from "./compatibility-marker.ts";

export type CompatibilityReconcileOptions = CompatibilityMarkerPaths & {
  dbPath: string;
  currentVersion: string;
  now?: number;
  candidate?: CompatibilityMarkerV1;
  afterFileWrite?: () => void;
};

type MarkerCopy = {
  exists: boolean;
  marker: CompatibilityMarkerV1 | null;
  error: unknown | null;
};

const readFileCopy = (markerPath: string): MarkerCopy => {
  if (!fs.existsSync(markerPath)) return { exists: false, marker: null, error: null };
  try {
    return { exists: true, marker: readCompatibilityMarkerFile(markerPath), error: null };
  } catch (error) {
    return { exists: true, marker: null, error };
  }
};

const readDatabaseCopy = (dbPath: string): MarkerCopy => {
  if (!fs.existsSync(dbPath)) return { exists: false, marker: null, error: null };
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = database
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'compatibility_marker_v1'`,
      )
      .get();
    if (!table) return { exists: false, marker: null, error: null };
    const row = database
      .prepare(`SELECT marker_bytes FROM compatibility_marker_v1 WHERE singleton = 1`)
      .get() as { marker_bytes: Uint8Array } | undefined;
    if (!row) return { exists: false, marker: null, error: null };
    try {
      return {
        exists: true,
        marker: parseCompatibilityMarker(row.marker_bytes),
        error: null,
      };
    } catch (error) {
      return { exists: true, marker: null, error };
    }
  } finally {
    database.close();
  }
};

const writeDatabaseCopy = (
  dbPath: string,
  marker: CompatibilityMarkerV1,
): void => {
  const database = new DatabaseSync(dbPath);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`CREATE TABLE IF NOT EXISTS compatibility_marker_v1 (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        marker_bytes BLOB NOT NULL
      )`);
      database
        .prepare(
          `INSERT INTO compatibility_marker_v1 (singleton, marker_bytes) VALUES (1, ?)
           ON CONFLICT(singleton) DO UPDATE SET marker_bytes = excluded.marker_bytes`,
        )
        .run(serializeCompatibilityMarker(marker));
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
};

const assertVersionIsSupported = (
  marker: CompatibilityMarkerV1,
  currentVersion: string,
  now: number,
): void => {
  if (semver.valid(currentVersion) !== currentVersion) {
    throw new Error(`Invalid daemon version: ${currentVersion}`);
  }
  if (semver.lt(currentVersion, marker.minimumDaemonVersion)) {
    throw new Error(
      `STORAGE_VERSION_UNSUPPORTED: requires ${marker.minimumDaemonVersion}`,
    );
  }
  if (
    now >= marker.serviceSupportNotBefore &&
    semver.lt(currentVersion, marker.serviceSupportFloor)
  ) {
    throw new Error(`SUPPORT_EXPIRED: requires ${marker.serviceSupportFloor}`);
  }
};

const markersEqual = (
  left: CompatibilityMarkerV1,
  right: CompatibilityMarkerV1,
): boolean =>
  serializeCompatibilityMarker(left).equals(serializeCompatibilityMarker(right));

export const reconcileCompatibilityMarker = (
  options: CompatibilityReconcileOptions,
): CompatibilityMarkerV1 =>
  withCompatibilityMarkerLock(options.lockPath, () => {
    const fileCopy = readFileCopy(options.markerPath);
    const databaseCopy = readDatabaseCopy(options.dbPath);
    const validCopies = [fileCopy.marker, databaseCopy.marker].filter(
      (marker): marker is CompatibilityMarkerV1 => marker !== null,
    );

    if (validCopies.length === 0 && (fileCopy.exists || databaseCopy.exists)) {
      throw new Error("COMPATIBILITY_MARKER_CORRUPT: no valid marker copy");
    }
    if (validCopies.length === 0 && !options.candidate) {
      throw new Error("COMPATIBILITY_MARKER_MISSING: initial marker required");
    }

    const candidateCopies = options.candidate
      ? [...validCopies, options.candidate]
      : validCopies;
    const copiesAlreadyMatch =
      !options.candidate &&
      fileCopy.marker !== null &&
      databaseCopy.marker !== null &&
      markersEqual(fileCopy.marker, databaseCopy.marker);
    const effective = copiesAlreadyMatch
      ? fileCopy.marker!
      : candidateCopies.length === 1 && validCopies.length === 0
        ? { ...candidateCopies[0]!, generation: candidateCopies[0]!.generation + 1 }
        : mergeCompatibilityMarkers(
            candidateCopies[0]!,
            ...candidateCopies.slice(1),
          );

    assertVersionIsSupported(effective, options.currentVersion, options.now ?? Date.now());
    if (copiesAlreadyMatch) return effective;

    writeCompatibilityMarkerFileDurably(options.markerPath, effective);
    options.afterFileWrite?.();
    writeDatabaseCopy(options.dbPath, effective);
    return effective;
  });
