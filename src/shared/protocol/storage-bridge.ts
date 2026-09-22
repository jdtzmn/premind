import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  acquireDaemonStartLock,
  isSocketReachable,
  releaseDaemonStartLock,
} from "../daemon-startup.ts";
import { withCompatibilityMarkerLockAsync } from "./compatibility-marker-file.ts";

export const LEGACY_STORAGE_QUARANTINE_BYTES = Buffer.from(
  "PREMIND_STORAGE_QUARANTINED_V1\n",
  "utf8",
);

export type StorageBridgeOptions = {
  stateDir: string;
  legacyDbPath: string;
  modernDbPath: string;
  historicalSocketPath: string;
  compatibilityLockPath: string;
  bindGuard?: () => Promise<void>;
  afterModernPublish?: () => void;
};

const fsyncDirectory = (directory: string) => {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const isQuarantineTombstone = (filePath: string): boolean => {
  if (!fs.existsSync(filePath)) return false;
  try {
    return fs.readFileSync(filePath).equals(LEGACY_STORAGE_QUARANTINE_BYTES);
  } catch {
    return false;
  }
};

const publishQuarantineTombstone = (legacyDbPath: string): void => {
  const temporaryPath = `${legacyDbPath}.${process.pid}.${randomUUID()}.tombstone`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, LEGACY_STORAGE_QUARANTINE_BYTES);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, legacyDbPath);
    fsyncDirectory(path.dirname(legacyDbPath));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
};

export const bridgeLegacyStorage = async (
  options: StorageBridgeOptions,
): Promise<"migrated" | "already-bridged"> => {
  const daemonLock = acquireDaemonStartLock({ stateDir: options.stateDir });
  if (!daemonLock) throw new Error("LEGACY_STARTUP_BUSY: daemon start lock is held");
  try {
    return await withCompatibilityMarkerLockAsync(
      options.compatibilityLockPath,
      async () => {
        if (await isSocketReachable(options.historicalSocketPath)) {
          throw new Error("LEGACY_DAEMON_ACTIVE: historical socket is reachable");
        }
        if (
          fs.existsSync(options.modernDbPath) &&
          isQuarantineTombstone(options.legacyDbPath)
        ) {
          await options.bindGuard?.();
          return "already-bridged";
        }
        if (!fs.existsSync(options.legacyDbPath)) {
          throw new Error("LEGACY_STORAGE_MISSING: no authoritative database");
        }
        if (isQuarantineTombstone(options.legacyDbPath)) {
          throw new Error("MODERN_STORAGE_MISSING: quarantine exists without modern state");
        }

        fs.mkdirSync(path.dirname(options.modernDbPath), { recursive: true });
        if (!fs.existsSync(options.modernDbPath)) {
          const temporaryModernPath = `${options.modernDbPath}.${process.pid}.${randomUUID()}.tmp`;
          try {
            const source = new DatabaseSync(options.legacyDbPath, { readOnly: true });
            try {
              await backup(source, temporaryModernPath);
            } finally {
              source.close();
            }
            const descriptor = fs.openSync(temporaryModernPath, "r");
            try {
              fs.fsyncSync(descriptor);
            } finally {
              fs.closeSync(descriptor);
            }
            fs.renameSync(temporaryModernPath, options.modernDbPath);
            fsyncDirectory(path.dirname(options.modernDbPath));
          } finally {
            fs.rmSync(temporaryModernPath, { force: true });
          }
        }

        options.afterModernPublish?.();

        const archivePath = `${options.legacyDbPath}.bridge-v1.sqlite`;
        if (!fs.existsSync(archivePath)) fs.renameSync(options.legacyDbPath, archivePath);
        else fs.rmSync(options.legacyDbPath, { force: true });
        fs.rmSync(`${options.legacyDbPath}-wal`, { force: true });
        fs.rmSync(`${options.legacyDbPath}-shm`, { force: true });
        publishQuarantineTombstone(options.legacyDbPath);
        await options.bindGuard?.();
        return "migrated";
      },
    );
  } finally {
    releaseDaemonStartLock(daemonLock);
  }
};
