import fs from "node:fs";
import path from "node:path";
import {
  instanceDescriptorV1Schema,
  type InstanceDescriptorV1,
} from "./descriptor.ts";

// Per-instance sockets live in an owner-only directory so that another local
// user can neither connect to nor pre-create a daemon endpoint.
const RUNTIME_DIR_MODE = 0o700;
const DESCRIPTOR_FILE_MODE = 0o600;
const DESCRIPTOR_SUFFIX = ".json";

const currentUid = (): number | undefined => process.getuid?.();

/**
 * Returns `<baseDir>/premind-<uid>`, creating it owner-only. Refuses a path
 * that is a symlink, not a directory, or owned by another user.
 */
export const resolveInstanceRuntimeDir = (baseDir: string): string => {
  const uid = currentUid();
  const runtimeDir = path.join(baseDir, `premind-${uid ?? "user"}`);
  try {
    fs.mkdirSync(runtimeDir, { mode: RUNTIME_DIR_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stats = fs.lstatSync(runtimeDir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`INSECURE_RUNTIME_DIR: ${runtimeDir} is not a directory`);
  }
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(`INSECURE_RUNTIME_DIR: ${runtimeDir} is owned by another user`);
  }
  if ((stats.mode & 0o077) !== 0) fs.chmodSync(runtimeDir, RUNTIME_DIR_MODE);
  return runtimeDir;
};

/** Short, unique socket path; Unix socket paths are limited to ~104 bytes. */
export const instanceSocketPath = (runtimeDir: string, instanceId: string) =>
  path.join(runtimeDir, `d-${instanceId.slice(0, 8)}.sock`);

// macOS allows 103 usable bytes in sun_path and Linux 107; keep a margin.
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * Prefers `preferredBaseDir` (beside the historical socket) but falls back to
 * `/tmp` when an instance socket there would exceed the Unix path limit.
 */
export const instanceRuntimeBaseDir = (preferredBaseDir: string): string => {
  const longest = instanceSocketPath(
    path.join(preferredBaseDir, `premind-${currentUid() ?? "user"}`),
    "00000000",
  );
  return Buffer.byteLength(longest) <= MAX_SOCKET_PATH_BYTES
    ? preferredBaseDir
    : "/tmp";
};

export const instanceDescriptorDir = (stateDir: string) =>
  path.join(stateDir, "instances");

const descriptorPath = (stateDir: string, instanceId: string) =>
  path.join(instanceDescriptorDir(stateDir), `${instanceId}${DESCRIPTOR_SUFFIX}`);

/** Atomically publishes (or replaces) this instance's descriptor. */
export const writeInstanceDescriptor = (
  stateDir: string,
  descriptor: InstanceDescriptorV1,
): void => {
  const parsed = instanceDescriptorV1Schema.parse(descriptor);
  const directory = instanceDescriptorDir(stateDir);
  fs.mkdirSync(directory, { recursive: true, mode: RUNTIME_DIR_MODE });
  const target = descriptorPath(stateDir, parsed.instanceId);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(parsed)}\n`, {
    mode: DESCRIPTOR_FILE_MODE,
  });
  fs.renameSync(temporary, target);
};

export const removeInstanceDescriptor = (
  stateDir: string,
  instanceId: string,
): void => {
  fs.rmSync(descriptorPath(stateDir, instanceId), { force: true });
};

/**
 * Lists parseable descriptors. A descriptor is a discovery hint, never proof
 * of liveness: callers must still verify the socket through bootstrap.
 */
export const listInstanceDescriptors = (
  stateDir: string,
): InstanceDescriptorV1[] => {
  let names: string[];
  try {
    names = fs.readdirSync(instanceDescriptorDir(stateDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(DESCRIPTOR_SUFFIX))
    .flatMap((name) => {
      try {
        const raw = fs.readFileSync(
          path.join(instanceDescriptorDir(stateDir), name),
          "utf8",
        );
        const parsed = instanceDescriptorV1Schema.safeParse(JSON.parse(raw));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
};

/**
 * Removes descriptors (and their sockets) whose daemon no longer answers.
 * Sockets are only deleted inside `runtimeDir` so a hostile descriptor cannot
 * direct deletion elsewhere.
 */
export const pruneUnreachableInstances = async (
  stateDir: string,
  runtimeDir: string,
  isReachable: (socketPath: string) => Promise<boolean>,
  keepInstanceId?: string,
): Promise<number> => {
  let pruned = 0;
  for (const descriptor of listInstanceDescriptors(stateDir)) {
    if (descriptor.instanceId === keepInstanceId) continue;
    if (await isReachable(descriptor.socketPath)) continue;
    removeInstanceDescriptor(stateDir, descriptor.instanceId);
    if (path.dirname(descriptor.socketPath) === runtimeDir) {
      fs.rmSync(descriptor.socketPath, { force: true });
    }
    pruned += 1;
  }
  return pruned;
};
