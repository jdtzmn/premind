/**
 * The cross-harness contract for every Premind command and model tool.
 *
 * Every supported harness must expose each capability's canonical surface.
 * Any missing or renamed surface needs a typed exception; tests enforce this
 * for every capability, whatever its classification. See AGENTS.md
 * "Supported Harnesses".
 */
export const premindHarnesses = ["pi", "claude", "opencode", "codex"] as const;

export type PremindHarness = (typeof premindHarnesses)[number];
export type CapabilityClassification = "common" | "adapter-specific";
export type CapabilityScope = "daemon" | "session";

export type CapabilitySurfaceKind = "commands" | "tools";

export const premindHarnessLabels = {
	pi: "Pi",
	claude: "Claude Code",
	opencode: "OpenCode",
	codex: "Codex",
} as const satisfies Record<PremindHarness, string>;

/**
 * The only reasons a harness may lack a canonical surface permanently. Each
 * entry is a real limitation of the host, not a scope decision. An
 * `unsupported` exception must name one of these, and only for the harness and
 * surface it describes; tests reject anything else (#85).
 *
 * Adding an entry requires explicit user approval. If a harness can technically
 * provide a surface, implement it there instead, or record a `deferred`
 * exception that names a tracking issue.
 */
export const hostLimitations = {
	"codex-no-slash-commands": {
		harness: "codex",
		surface: "commands",
		reason: "Codex plugins expose MCP tools and skills, not slash commands.",
	},
	"claude-delivery-owned-by-stop-hook": {
		harness: "claude",
		surface: "tools",
		capabilities: ["deliver"],
		reason: "Claude delivery remains owned by the Stop hook.",
	},
	"opencode-no-skill-install": {
		harness: "opencode",
		surface: "skills",
		reason:
			"OpenCode's npm plugin cannot install into OpenCode's skill discovery directories.",
	},
} as const satisfies Record<
	string,
	{
		harness: PremindHarness;
		surface: CapabilitySurfaceKind | "skills" | "scenarios";
		/** Limit the entry to these capabilities; omit when it applies to all. */
		capabilities?: readonly string[];
		reason: string;
	}
>;

export type HostLimitationId = keyof typeof hostLimitations;

/**
 * - `unsupported`: the host cannot provide the surface. Must name an entry in
 *   `hostLimitations`.
 * - `deferred`: the host could provide it but does not yet; must name a
 *   tracking issue or PR.
 * - `host-naming`: the surface exists under a host-specific name.
 */
export type CapabilityExceptionKind = "unsupported" | "deferred" | "host-naming";

export type CapabilityException =
	| { kind: "unsupported"; limitation: HostLimitationId; reason: string }
	| {
			kind: "deferred";
			reason: string;
			/** An issue or PR reference such as `#77`. */
			tracking: string;
	  }
	| { kind: "host-naming"; reason: string };

/** Builds an `unsupported` exception from an approved host limitation. */
export const unsupported = (limitation: HostLimitationId): CapabilityException => ({
	kind: "unsupported",
	limitation,
	reason: hostLimitations[limitation].reason,
});

export type HarnessCapabilityAliases = Partial<
	Record<CapabilitySurfaceKind, readonly string[]>
>;

export type ToolParameterType = "string" | "integer" | "number" | "boolean";

export type ToolParameter = { type: ToolParameterType; required: boolean };

export type HarnessCapabilitySurface = {
	commands: readonly string[];
	tools: readonly string[];
	aliases?: HarnessCapabilityAliases;
	exceptions?: Partial<Record<CapabilitySurfaceKind, CapabilityException>>;
	/** Host-injected tool parameters beyond the canonical set, such as Codex session handles. */
	extraParameters?: Readonly<Record<string, ToolParameter & { reason: string }>>;
	/** Canonical tool parameters this harness does not accept yet. */
	parameterExceptions?: Readonly<Record<string, CapabilityException>>;
};

export type CommandCapability = {
	classification: CapabilityClassification;
	scope: CapabilityScope;
	description: string;
	canonical: Record<CapabilitySurfaceKind, readonly string[]>;
	/** Parameters every harness's model tool must accept. */
	parameters: Readonly<Record<string, ToolParameter>>;
	/**
	 * Agent-facing guidance every harness's model tool description must contain
	 * verbatim. Hosts may add a host-specific lead, never different guidance.
	 */
	toolGuidance?: string;
	harnesses: Record<PremindHarness, HarnessCapabilitySurface>;
};

const HARNESS_GAPS_ISSUE = "#77";

const claudeToolNaming: CapabilityException = {
	kind: "host-naming",
	reason: "Claude MCP tools omit the premind_ prefix.",
};

const codexHasNoCommands = unsupported("codex-no-slash-commands");

const codexSessionHandle = (required: boolean) =>
	({
		sessionHandle: {
			type: "string",
			required,
			reason: "Codex MCP processes identify the session by the handle lifecycle context supplies.",
		},
	}) as const;

const deferred = (reason: string): CapabilityException => ({
	kind: "deferred",
	reason,
	tracking: HARNESS_GAPS_ISSUE,
});

export const commandCapabilities = {
	status: {
		classification: "common",
		scope: "daemon",
		description: "Inspect daemon state and pending reminder counts.",
		canonical: { commands: ["premind:status"], tools: ["premind_status"] },
		parameters: {},
		toolGuidance:
			"Inspect Premind status, including pending reminder counts.",
		harnesses: {
			pi: { commands: ["premind:status"], tools: ["premind_status"] },
			claude: {
				commands: ["premind:status"],
				tools: ["status"],
				exceptions: { tools: claudeToolNaming },
			},
			opencode: {
				commands: ["premind-status"],
				tools: ["premind_status"],
				exceptions: {
					commands: {
						kind: "host-naming",
						reason: "OpenCode retains its established hyphenated status command.",
					},
				},
			},
			codex: {
				commands: [],
				tools: ["premind_status"],
				exceptions: { commands: codexHasNoCommands },
				extraParameters: codexSessionHandle(false),
			},
		},
	},
	doctor: {
		classification: "common",
		scope: "daemon",
		description: "Diagnose adapter, configuration, and daemon health.",
		canonical: { commands: ["premind:doctor"], tools: ["premind_doctor"] },
		parameters: {},
		toolGuidance:
			"Diagnose Premind adapter, configuration, and daemon health.",
		harnesses: {
			pi: { commands: ["premind:doctor"], tools: ["premind_doctor"] },
			claude: {
				commands: ["premind:doctor"],
				tools: ["probe"],
				exceptions: {
					tools: {
						kind: "host-naming",
						reason: "Claude retains the existing probe MCP tool name.",
					},
				},
			},
			opencode: {
				commands: ["premind:doctor"],
				tools: ["premind_probe"],
				exceptions: {
					tools: {
						kind: "host-naming",
						reason: "OpenCode retains the existing premind_probe tool name.",
					},
				},
			},
			codex: {
				commands: [],
				tools: [],
				exceptions: {
					commands: codexHasNoCommands,
					tools: deferred("Codex does not yet expose a doctor MCP tool."),
				},
			},
		},
	},
	deliver: {
		classification: "common",
		scope: "session",
		description: "Deliver queued reminders at the earliest safe harness boundary.",
		canonical: { commands: ["premind:deliver"], tools: ["premind_deliver"] },
		parameters: {},
		toolGuidance:
			"Deliver pending Premind reminders for this session at the earliest safe boundary.",
		harnesses: {
			pi: {
				commands: ["premind:deliver"],
				tools: ["premind_deliver"],
				aliases: { commands: ["premind:flush"] },
			},
			claude: {
				commands: ["premind:deliver"],
				tools: [],
				exceptions: {
					tools: unsupported("claude-delivery-owned-by-stop-hook"),
				},
			},
			opencode: {
				commands: ["premind:deliver"],
				tools: ["premind_deliver"],
				aliases: {
					commands: ["premind-send-now"],
					tools: ["premind_send_now"],
				},
			},
			codex: {
				commands: [],
				tools: [],
				exceptions: {
					commands: codexHasNoCommands,
					tools: deferred(
						"Codex does not yet expose a deliver MCP tool; lifecycle hooks may need to own delivery as Claude's Stop hook does.",
					),
				},
			},
		},
	},
	enable: {
		classification: "common",
		scope: "daemon",
		description:
			"Enable GitHub polling globally for every session; model tools require confirmGlobal: true.",
		canonical: { commands: ["premind:enable"], tools: ["premind_enable"] },
		parameters: { confirmGlobal: { type: "boolean", required: true } },
		toolGuidance:
			"This enables Premind GitHub polling globally, for every session and project. Call it only when the user explicitly asks for the global enable, and pass confirmGlobal: true. To resume only this session, use the session resume tool instead.",
		harnesses: {
			pi: { commands: ["premind:enable"], tools: ["premind_enable"] },
			claude: {
				commands: ["premind:enable"],
				tools: ["enable"],
				exceptions: { tools: claudeToolNaming },
			},
			opencode: {
				commands: ["premind-enable"],
				tools: ["premind_enable"],
				exceptions: {
					commands: {
						kind: "host-naming",
						reason: "OpenCode retains its established hyphenated enable command.",
					},
				},
			},
			codex: {
				commands: [],
				tools: [],
				exceptions: {
					commands: codexHasNoCommands,
					tools: deferred("Codex does not yet expose an enable MCP tool."),
				},
			},
		},
	},
	disable: {
		classification: "common",
		scope: "daemon",
		description:
			"Disable GitHub polling globally for every session; model tools require confirmGlobal: true.",
		canonical: { commands: ["premind:disable"], tools: ["premind_disable"] },
		parameters: { confirmGlobal: { type: "boolean", required: true } },
		toolGuidance:
			"This disables Premind GitHub polling globally, for every session and project. Call it only when the user explicitly asks for the global disable, and pass confirmGlobal: true. To pause, mute, or quiet only this session, use the session pause tool instead.",
		harnesses: {
			pi: { commands: ["premind:disable"], tools: ["premind_disable"] },
			claude: {
				commands: ["premind:disable"],
				tools: ["disable"],
				exceptions: { tools: claudeToolNaming },
			},
			opencode: {
				commands: ["premind-disable"],
				tools: ["premind_disable"],
				exceptions: {
					commands: {
						kind: "host-naming",
						reason: "OpenCode retains its established hyphenated disable command.",
					},
				},
			},
			codex: {
				commands: [],
				tools: [],
				exceptions: {
					commands: codexHasNoCommands,
					tools: deferred("Codex does not yet expose a disable MCP tool."),
				},
			},
		},
	},
	"set-active-checkout": {
		classification: "common",
		scope: "session",
		description: "Set the active checkout for the current session.",
		canonical: {
			commands: ["premind:set-active-checkout"],
			tools: ["premind_set_active_checkout"],
		},
		parameters: { path: { type: "string", required: true } },
		toolGuidance:
			"Call this at the start of any PR work, including when already in the startup checkout, and again after switching branches or worktrees before creating or following a PR.",
		harnesses: {
			pi: {
				commands: ["premind:set-active-checkout"],
				tools: ["premind_set_active_checkout"],
			},
			claude: {
				commands: [],
				tools: ["set_active_checkout"],
				exceptions: {
					commands: deferred("Claude currently exposes this only as a model tool."),
					tools: claudeToolNaming,
				},
			},
			opencode: {
				commands: [],
				tools: ["premind_set_active_checkout"],
				exceptions: {
					commands: deferred("OpenCode currently exposes this only as a model tool."),
				},
			},
			codex: {
				commands: [],
				tools: ["premind_set_active_checkout"],
				exceptions: { commands: codexHasNoCommands },
				extraParameters: codexSessionHandle(true),
			},
		},
	},
	subscribe: {
		classification: "common",
		scope: "session",
		description: "Subscribe the current session to a pull request.",
		canonical: { commands: ["premind:subscribe"], tools: ["premind_subscribe"] },
		parameters: {
			prNumber: { type: "integer", required: true },
			repo: { type: "string", required: false },
			writePolicy: { type: "string", required: false },
		},
		toolGuidance:
			"Mandatory PR tracking: Immediately call this tool after creating, opening, discovering, or beginning work on a pull request. Do this before reporting the PR URL or status to the user. Applies after gh pr create, gh stack submit, gh stack link, or any equivalent GitHub operation.",
		harnesses: {
			pi: { commands: ["premind:subscribe"], tools: ["premind_subscribe"] },
			claude: {
				commands: ["premind:subscribe"],
				tools: ["subscribe"],
				exceptions: { tools: claudeToolNaming },
			},
			opencode: {
				commands: [],
				tools: ["premind_subscribe"],
				exceptions: {
					commands: deferred("OpenCode currently exposes this only as a model tool."),
				},
				parameterExceptions: {
					writePolicy: deferred("OpenCode subscriptions do not accept an explicit write policy yet."),
				},
			},
			codex: {
				commands: [],
				tools: ["premind_subscribe"],
				exceptions: { commands: codexHasNoCommands },
				extraParameters: codexSessionHandle(true),
				parameterExceptions: {
					writePolicy: deferred("Codex subscriptions do not accept an explicit write policy yet."),
				},
			},
		},
	},
	unsubscribe: {
		classification: "common",
		scope: "session",
		description: "Unsubscribe the current session from a pull request.",
		canonical: {
			commands: ["premind:unsubscribe"],
			tools: ["premind_unsubscribe"],
		},
		parameters: {
			prNumber: { type: "integer", required: true },
			repo: { type: "string", required: false },
		},
		toolGuidance:
			"Use this only when the user asks to stop tracking a pull request.",
		harnesses: {
			pi: {
				commands: ["premind:unsubscribe"],
				tools: ["premind_unsubscribe"],
			},
			claude: {
				commands: ["premind:unsubscribe"],
				tools: ["unsubscribe"],
				exceptions: { tools: claudeToolNaming },
			},
			opencode: {
				commands: [],
				tools: ["premind_unsubscribe"],
				exceptions: {
					commands: deferred("OpenCode currently exposes this only as a model tool."),
				},
			},
			codex: {
				commands: [],
				tools: ["premind_unsubscribe"],
				exceptions: { commands: codexHasNoCommands },
				extraParameters: codexSessionHandle(true),
			},
		},
	},
	pause: {
		classification: "common",
		scope: "session",
		description:
			"Pause reminder delivery for one session while preserving its subscriptions.",
		canonical: { commands: ["premind:pause"], tools: ["premind_pause"] },
		parameters: {},
		toolGuidance:
			"Pause Premind reminders for this session only. Subscriptions, watchers, and queued PR updates are kept, and the pause lasts until the session resume tool is called. Use this, not the global disable tool, to pause, mute, or quiet Premind.",
		harnesses: {
			pi: { commands: ["premind:pause"], tools: ["premind_pause"] },
			claude: {
				commands: ["premind:pause"],
				tools: ["pause"],
				exceptions: { tools: claudeToolNaming },
			},
			opencode: { commands: ["premind:pause"], tools: ["premind_pause"] },
			codex: {
				commands: [],
				tools: ["premind_pause"],
				exceptions: { commands: codexHasNoCommands },
				extraParameters: codexSessionHandle(true),
			},
		},
	},
	resume: {
		classification: "common",
		scope: "session",
		description:
			"Resume reminder delivery for a paused session without changing subscriptions.",
		canonical: { commands: ["premind:resume"], tools: ["premind_resume"] },
		parameters: {},
		toolGuidance:
			"Resume Premind reminders for this session without changing subscriptions. Queued PR updates arrive at the next safe boundary. Use this, not the global enable tool, to undo a session pause.",
		harnesses: {
			pi: { commands: ["premind:resume"], tools: ["premind_resume"] },
			claude: {
				commands: ["premind:resume"],
				tools: ["resume"],
				exceptions: { tools: claudeToolNaming },
			},
			opencode: { commands: ["premind:resume"], tools: ["premind_resume"] },
			codex: {
				commands: [],
				tools: ["premind_resume"],
				exceptions: { commands: codexHasNoCommands },
				extraParameters: codexSessionHandle(true),
			},
		},
	},
	prune: {
		classification: "adapter-specific",
		scope: "daemon",
		description:
			"Remove closed sessions and their pending reminder batches (administrative; not model-callable).",
		canonical: { commands: ["premind:prune"], tools: [] },
		parameters: {},
		harnesses: {
			pi: { commands: ["premind:prune"], tools: [] },
			claude: {
				commands: [],
				tools: [],
				exceptions: { commands: deferred("Only Pi exposes prune today.") },
			},
			opencode: {
				commands: [],
				tools: [],
				exceptions: { commands: deferred("Only Pi exposes prune today.") },
			},
			codex: {
				commands: [],
				tools: [],
				exceptions: { commands: codexHasNoCommands },
			},
		},
	},
} as const satisfies Record<string, CommandCapability>;

export type CommandCapabilityId = keyof typeof commandCapabilities;

/** Harness-level surfaces outside the command/tool matrix. */
export const harnessSkillExceptions: Partial<
	Record<PremindHarness, CapabilityException>
> = {
	opencode: unsupported("opencode-no-skill-install"),
};

export const harnessSurface = (
	capability: CommandCapability,
	harness: PremindHarness,
): HarnessCapabilitySurface => capability.harnesses[harness];

export const expectedCapabilitySurface = (
	harness: PremindHarness,
	surface: CapabilitySurfaceKind,
): string[] =>
	Object.values(commandCapabilities as Record<string, CommandCapability>)
		.flatMap((capability) => {
			const capabilitySurface = harnessSurface(capability, harness);
			return [
				...capabilitySurface[surface],
				...(capabilitySurface.aliases?.[surface] ?? []),
			];
		})
		.sort();

/** Every exception declared in the registry, flattened for checks and docs. */
export const listCapabilityExceptions = () =>
	Object.entries(commandCapabilities as Record<string, CommandCapability>).flatMap(
		([capabilityId, capability]) =>
			premindHarnesses.flatMap((harness) =>
				Object.entries(harnessSurface(capability, harness).exceptions ?? {}).map(
					([surface, exception]) => ({
						capabilityId,
						harness,
						surface: surface as CapabilitySurfaceKind,
						exception: exception as CapabilityException,
					}),
				),
			),
	);

/** Every canonical parameter a harness is excused from accepting. */
export const listParameterExceptions = () =>
	Object.entries(commandCapabilities as Record<string, CommandCapability>).flatMap(
		([capabilityId, capability]) =>
			premindHarnesses.flatMap((harness) =>
				Object.entries(harnessSurface(capability, harness).parameterExceptions ?? {}).map(
					([parameter, exception]) => ({ capabilityId, harness, parameter, exception }),
				),
			),
	);

/** The parameters a harness's model tool for this capability must accept. */
export const expectedToolParameters = (
	capability: CommandCapability,
	harness: PremindHarness,
): Record<string, ToolParameter> => {
	const surface = harnessSurface(capability, harness);
	const expected: Record<string, ToolParameter> = {};
	for (const [name, parameter] of Object.entries(capability.parameters)) {
		if (!surface.parameterExceptions?.[name]) expected[name] = { ...parameter };
	}
	for (const [name, { type, required }] of Object.entries(surface.extraParameters ?? {})) {
		expected[name] = { type, required };
	}
	return expected;
};

const formatSurface = (surface: HarnessCapabilitySurface): string => {
	const commands = surface.commands.map((name) => `\`/${name}\``);
	const tools = surface.tools.map((name) => `\`${name}\``);
	const commandAliases = (surface.aliases?.commands ?? []).map(
		(name) => `\`/${name}\``,
	);
	const toolAliases = (surface.aliases?.tools ?? []).map(
		(name) => `\`${name}\``,
	);
	return [
		commands.length > 0 ? `commands ${commands.join(", ")}` : undefined,
		tools.length > 0 ? `tools ${tools.join(", ")}` : undefined,
		commandAliases.length > 0
			? `deprecated command aliases ${commandAliases.join(", ")}`
			: undefined,
		toolAliases.length > 0
			? `deprecated tool aliases ${toolAliases.join(", ")}`
			: undefined,
	]
		.filter(Boolean)
		.join("<br>") || "—";
};

export const renderCommandCapabilityDocumentation = (): string => {
	const harnessHeaders = premindHarnesses.map((harness) => premindHarnessLabels[harness]);
	const lines = [
		"# Premind Command Capabilities",
		"",
		"This matrix is generated from `src/shared/command-capabilities.ts`. Every harness must expose each canonical surface; any missing or renamed surface is declared below as an `unsupported`, `deferred`, or `host-naming` exception.",
		"",
		`| Capability | Classification | Scope | Canonical | ${harnessHeaders.join(" | ")} |`,
		`| --- | --- | --- | --- | ${harnessHeaders.map(() => "---").join(" | ")} |`,
	];
	for (const [capabilityId, capability] of Object.entries(
		commandCapabilities as Record<string, CommandCapability>,
	)) {
		const cells = premindHarnesses.map((harness) =>
			formatSurface(harnessSurface(capability, harness)),
		);
		lines.push(
			`| \`${capabilityId}\` | ${capability.classification} | ${capability.scope} | ${formatSurface(capability.canonical)} | ${cells.join(" | ")} |`,
		);
	}
	const exceptions = listCapabilityExceptions();
	const deferredGaps = exceptions.filter(({ exception }) => exception.kind === "deferred");
	const deferredParameters = listParameterExceptions().filter(
		({ exception }) => exception.kind === "deferred",
	);
	lines.push("", "## Deferred gaps", "");
	if (deferredGaps.length === 0 && deferredParameters.length === 0) lines.push("None.");
	const tracking = (exception: CapabilityException) =>
		exception.kind === "deferred" ? exception.tracking : "";
	for (const { capabilityId, harness, surface, exception } of deferredGaps) {
		lines.push(
			`- \`${capabilityId}\` / ${premindHarnessLabels[harness]} / ${surface}: ${exception.reason} (tracked in ${tracking(exception)})`,
		);
	}
	for (const { capabilityId, harness, parameter, exception } of deferredParameters) {
		lines.push(
			`- \`${capabilityId}\` / ${premindHarnessLabels[harness]} / parameter \`${parameter}\`: ${exception.reason} (tracked in ${tracking(exception)})`,
		);
	}
	lines.push("", "## Other exceptions", "");
	for (const { capabilityId, harness, surface, exception } of exceptions) {
		if (exception.kind === "deferred") continue;
		lines.push(
			`- \`${capabilityId}\` / ${premindHarnessLabels[harness]} / ${surface} (${exception.kind}): ${exception.reason}`,
		);
	}
	for (const [harness, exception] of Object.entries(harnessSkillExceptions)) {
		lines.push(
			`- skills / ${premindHarnessLabels[harness as PremindHarness]} (${exception.kind}): ${exception.reason}`,
		);
	}
	lines.push(
		"",
		"## Notes",
		"",
		"- Claude status remains aggregate and redacted; Pi, OpenCode, and Codex may expose session detail.",
		"- `pause` / `resume` act on one session and never change subscriptions; `enable` / `disable` act on every session, and their model tools refuse calls without `confirmGlobal: true`.",
		"- Delivery mechanics remain harness-specific even though `/premind:deliver` is canonical.",
		"",
	);
	return lines.join("\n");
};
