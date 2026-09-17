import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  mergeCompatibilityMarkers,
  parseCompatibilityMarker,
  serializeCompatibilityMarker,
  type CompatibilityMarkerV1,
} from "./compatibility-marker.ts";

export type CompatibilityMarkerPaths = {
  markerPath: string;
  lockPath: string;
};

export const readCompatibilityMarkerFile = (
  markerPath: string,
): CompatibilityMarkerV1 | null => {
  if (!fs.existsSync(markerPath)) return null;
  return parseCompatibilityMarker(fs.readFileSync(markerPath));
};

export const withCompatibilityMarkerLock = <T>(
  lockPath: string,
  operation: () => T,
): T => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lockFd = fs.openSync(lockPath, "wx", 0o600);
  try {
    return operation();
  } finally {
    fs.closeSync(lockFd);
    fs.rmSync(lockPath, { force: true });
  }
};
export const withCompatibilityMarkerLockAsync = async <T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> => {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lockFd = fs.openSync(lockPath, "wx", 0o600);
  try {
    return await operation();
  } finally {
    fs.closeSync(lockFd);
    fs.rmSync(lockPath, { force: true });
  }
};


export const writeCompatibilityMarkerFileDurably = (
  markerPath: string,
  marker: CompatibilityMarkerV1,
): void => {
  const directory = path.dirname(markerPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryFd: number | undefined;
  try {
    temporaryFd = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(temporaryFd, serializeCompatibilityMarker(marker));
    fs.fsyncSync(temporaryFd);
    fs.closeSync(temporaryFd);
    temporaryFd = undefined;
    fs.renameSync(temporaryPath, markerPath);
    const directoryFd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } finally {
    if (temporaryFd !== undefined) fs.closeSync(temporaryFd);
    fs.rmSync(temporaryPath, { force: true });
  }
};

export const updateCompatibilityMarkerFile = (
  paths: CompatibilityMarkerPaths,
  candidate: CompatibilityMarkerV1,
): CompatibilityMarkerV1 =>
  withCompatibilityMarkerLock(paths.lockPath, () => {
    const existing = readCompatibilityMarkerFile(paths.markerPath);
    const next = existing
      ? mergeCompatibilityMarkers(existing, candidate)
      : { ...candidate, generation: candidate.generation + 1 };
    writeCompatibilityMarkerFileDurably(paths.markerPath, next);
    return next;
  });
