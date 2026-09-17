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
			pi: {
				commands: [],
				tools: [],
				exceptions: {
					commands: "Planned parity work in issue 45.",
					tools: "Planned parity work in issue 45.",
				},
			},
			claude: { commands: ["premind:doctor"], tools: ["probe"] },
			opencode: {
				commands: [],
				tools: ["premind_probe"],
				exceptions: { commands: "Planned parity work in issue 45." },
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
			pi: {
				commands: [],
				tools: [],
				exceptions: {
					commands: "Planned parity work in issue 45.",
					tools: "Planned parity work in issue 45.",
				},
			},
			claude: { commands: ["premind:enable"], tools: ["enable"] },
			opencode: { commands: ["premind-enable"], tools: ["premind_enable"] },
		},
	},
	disable: {
		classification: "common",
		scope: "daemon",
		description: "Disable GitHub polling globally.",
		harnesses: {
			pi: {
				commands: [],
				tools: [],
				exceptions: {
					commands: "Planned parity work in issue 45.",
					tools: "Planned parity work in issue 45.",
				},
			},
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
