export const premindHarnesses = ["pi", "claude", "opencode"] as const;

export type PremindHarness = (typeof premindHarnesses)[number];
export type CapabilityClassification = "common" | "adapter-specific";
export type CapabilityScope = "daemon" | "session";

export type HarnessCapabilitySurface = {
	commands: readonly string[];
	tools: readonly string[];
	exceptions?: {
		commands?: string;
		tools?: string;
	};
};

export type CommandCapability = {
	classification: CapabilityClassification;
	scope: CapabilityScope;
	description: string;
	harnesses: Record<PremindHarness, HarnessCapabilitySurface>;
};

export const commandCapabilities = {
	status: {
		classification: "common",
		scope: "daemon",
		description: "Inspect daemon state and pending reminder counts.",
		harnesses: {
			pi: { commands: ["premind:status"], tools: ["premind_status"] },
			claude: { commands: ["premind:status"], tools: ["status"] },
			opencode: { commands: ["premind-status"], tools: ["premind_status"] },
		},
	},
	doctor: {
		classification: "common",
		scope: "daemon",
		description: "Diagnose adapter, configuration, and daemon health.",
		harnesses: {
			pi: { commands: ["premind:doctor"], tools: ["premind_doctor"] },
			claude: { commands: ["premind:doctor"], tools: ["probe"] },
			opencode: {
				commands: ["premind:doctor"],
				tools: ["premind_probe"],
			},
		},
	},
	deliver: {
		classification: "common",
		scope: "session",
		description: "Deliver queued reminders at the earliest safe harness boundary.",
		harnesses: {
			pi: {
				commands: ["premind:deliver", "premind:flush"],
				tools: ["premind_deliver"],
			},
			claude: {
				commands: ["premind:deliver"],
				tools: [],
				exceptions: {
					tools: "Claude delivery remains owned by the Stop hook.",
				},
			},
			opencode: {
				commands: ["premind:deliver", "premind-send-now"],
				tools: ["premind_deliver", "premind_send_now"],
			},
		},
	},
	enable: {
		classification: "common",
		scope: "daemon",
		description: "Enable GitHub polling globally.",
		harnesses: {
			pi: { commands: ["premind:enable"], tools: ["premind_enable"] },
			claude: { commands: ["premind:enable"], tools: ["enable"] },
			opencode: { commands: ["premind-enable"], tools: ["premind_enable"] },
		},
	},
	disable: {
		classification: "common",
		scope: "daemon",
		description: "Disable GitHub polling globally.",
		harnesses: {
			pi: { commands: ["premind:disable"], tools: ["premind_disable"] },
			claude: { commands: ["premind:disable"], tools: ["disable"] },
			opencode: { commands: ["premind-disable"], tools: ["premind_disable"] },
		},
	},
	"set-active-checkout": {
		classification: "common",
		scope: "session",
		description: "Set the active checkout for the current session.",
		harnesses: {
			pi: {
				commands: ["premind:set-active-checkout"],
				tools: ["premind_set_active_checkout"],
			},
			claude: {
				commands: [],
				tools: ["set_active_checkout"],
				exceptions: { commands: "Claude currently exposes this as a model tool." },
			},
			opencode: {
				commands: [],
				tools: ["premind_set_active_checkout"],
				exceptions: { commands: "OpenCode currently exposes this as a model tool." },
			},
		},
	},
	subscribe: {
		classification: "common",
		scope: "session",
		description: "Subscribe the current session to a pull request.",
		harnesses: {
			pi: { commands: ["premind:subscribe"], tools: ["premind_subscribe"] },
			claude: { commands: ["premind:subscribe"], tools: ["subscribe"] },
			opencode: {
				commands: [],
				tools: ["premind_subscribe"],
				exceptions: { commands: "OpenCode currently exposes this as a model tool." },
			},
		},
	},
	unsubscribe: {
		classification: "common",
		scope: "session",
		description: "Unsubscribe the current session from a pull request.",
		harnesses: {
			pi: {
				commands: ["premind:unsubscribe"],
				tools: ["premind_unsubscribe"],
			},
			claude: { commands: ["premind:unsubscribe"], tools: ["unsubscribe"] },
			opencode: {
				commands: [],
				tools: ["premind_unsubscribe"],
				exceptions: { commands: "OpenCode currently exposes this as a model tool." },
			},
		},
	},
	prune: {
		classification: "adapter-specific",
		scope: "daemon",
		description: "Remove closed sessions and their pending reminder batches.",
		harnesses: {
			pi: { commands: ["premind:prune"], tools: [] },
			claude: { commands: [], tools: [] },
			opencode: { commands: [], tools: [] },
		},
	},
} as const satisfies Record<string, CommandCapability>;

export type CommandCapabilityId = keyof typeof commandCapabilities;

export const expectedCapabilitySurface = (
	harness: PremindHarness,
	surface: "commands" | "tools",
): string[] =>
	Object.values(commandCapabilities)
		.flatMap((capability) => capability.harnesses[harness][surface])
		.sort();

const formatSurface = (surface: HarnessCapabilitySurface): string => {
	const commands = surface.commands.map((name) => `\`/${name}\``);
	const tools = surface.tools.map((name) => `\`${name}\``);
	return [
		commands.length > 0 ? `commands ${commands.join(", ")}` : undefined,
		tools.length > 0 ? `tools ${tools.join(", ")}` : undefined,
	]
		.filter(Boolean)
		.join("<br>") || "—";
};

export const renderCommandCapabilityDocumentation = (): string => {
	const lines = [
		"# Premind Command Capabilities",
		"",
		"This matrix is generated from `src/shared/command-capabilities.ts`. Harness-visible names may differ only when they are explicitly declared here.",
		"",
		"| Capability | Classification | Scope | Pi | Claude Code | OpenCode |",
		"| --- | --- | --- | --- | --- | --- |",
	];
	for (const [capabilityId, capability] of Object.entries(commandCapabilities)) {
		lines.push(
			`| \`${capabilityId}\` | ${capability.classification} | ${capability.scope} | ${formatSurface(capability.harnesses.pi)} | ${formatSurface(capability.harnesses.claude)} | ${formatSurface(capability.harnesses.opencode)} |`,
		);
	}
	lines.push("", "## Intentional exceptions", "");
	for (const [capabilityId, capability] of Object.entries(commandCapabilities)) {
		for (const harness of premindHarnesses) {
			const surface = capability.harnesses[harness];
			if (!("exceptions" in surface)) continue;
			for (const [kind, reason] of Object.entries(surface.exceptions ?? {})) {
				lines.push(`- \`${capabilityId}\` / ${harness} / ${kind}: ${reason}`);
			}
		}
	}
	lines.push(
		"- `prune` is Pi-specific administrative maintenance and is not model-callable.",
		"- Claude status remains aggregate and redacted; Pi and OpenCode may expose session detail.",
		"- Delivery mechanics remain harness-specific even though `/premind:deliver` is canonical.",
		"",
	);
	return lines.join("\n");
};
