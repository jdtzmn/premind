import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const sessionBindingSchema = z
	.object({
		sessionHandle: z.string().uuid(),
		sessionId: z.string().startsWith("codex:"),
		cwd: z.string().min(1),
		updatedAt: z.number().int().nonnegative(),
	})
	.strict();

export type CodexSessionBinding = z.infer<typeof sessionBindingSchema>;

export type CodexSessionSummary = {
	sessionId: string;
	host: string;
	status: string;
};

const encodeSessionId = (sessionId: string) =>
	Buffer.from(sessionId, "utf8").toString("base64url");

const canonicalizeCwd = (cwd: string) => {
	const resolved = path.resolve(cwd);
	try {
		return fs.realpathSync.native(resolved);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return resolved;
		throw error;
	}
};
const bindingsDirectory = (pluginData: string) =>
	path.join(pluginData, "premind", "v1", "session-bindings");

const bindingPath = (pluginData: string, sessionId: string) =>
	path.join(bindingsDirectory(pluginData), `${encodeSessionId(sessionId)}.json`);

const readBinding = (filePath: string): CodexSessionBinding | undefined => {
	try {
		return sessionBindingSchema.parse(
			JSON.parse(fs.readFileSync(filePath, "utf8")),
		);
	} catch {
		return undefined;
	}
};

export const ensureCodexSessionBinding = (
	pluginData: string,
	sessionId: string,
	cwd: string,
	now = Date.now(),
): CodexSessionBinding => {
	const directory = bindingsDirectory(pluginData);
	fs.mkdirSync(directory, { recursive: true });
	const filePath = bindingPath(pluginData, sessionId);
	const existing = readBinding(filePath);
	const binding = sessionBindingSchema.parse({
		sessionHandle:
			existing?.sessionId === sessionId ? existing.sessionHandle : randomUUID(),
		sessionId,
		cwd: canonicalizeCwd(cwd),
		updatedAt: now,
	});
	const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
	const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
	try {
		fs.writeFileSync(descriptor, `${JSON.stringify(binding)}\n`, "utf8");
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
	fs.renameSync(temporaryPath, filePath);
	return binding;
};

export const listCodexSessionBindings = (
	pluginData: string,
): CodexSessionBinding[] => {
	const directory = bindingsDirectory(pluginData);
	try {
		return fs
			.readdirSync(directory)
			.filter((fileName) => fileName.endsWith(".json"))
			.sort()
			.flatMap((fileName) => {
				const binding = readBinding(path.join(directory, fileName));
				return binding ? [binding] : [];
			});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
};

export const resolveCodexSessionBinding = (options: {
	pluginData: string;
	sessions: readonly CodexSessionSummary[];
	sessionHandle?: string;
	cwd?: string;
}): CodexSessionBinding | undefined => {
	const liveSessionIds = new Set(
		options.sessions
			.filter(
				(session) =>
					session.host === "codex" &&
					(session.status === "active" || session.status === "paused"),
			)
			.map((session) => session.sessionId),
	);
	const bindings = listCodexSessionBindings(options.pluginData).filter(
		(binding) => liveSessionIds.has(binding.sessionId),
	);
	if (options.sessionHandle) {
		const matched = bindings.filter(
			(binding) => binding.sessionHandle === options.sessionHandle,
		);
		if (matched.length !== 1) {
			throw new Error("Unknown or inactive Premind session handle");
		}
		return matched[0];
	}
	if (!options.cwd) return undefined;
	const resolvedCwd = canonicalizeCwd(options.cwd);
	const matched = bindings.filter((binding) => binding.cwd === resolvedCwd);
	if (matched.length > 1) {
		throw new Error(
			"Multiple Codex sessions match this working directory; pass the current sessionHandle explicitly",
		);
	}
	return matched[0];
};
