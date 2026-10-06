import type { TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import { PremindDaemonClient } from "../client/daemon-client.ts";
import { getCurrentStatusLines, type CurrentStatusLine } from "../shared/status-view.ts";
import type { StatusSignal } from "../shared/status-signal.ts";

export const statusColor = (theme: TuiThemeCurrent, kind: StatusSignal) => ({
  error: theme.error,
  warning: theme.warning,
  success: theme.success,
  merged: theme.accent,
  muted: theme.textMuted,
  unknown: theme.textMuted,
})[kind];

export function coloredStatusLines(lines: CurrentStatusLine[], theme: TuiThemeCurrent) {
  return lines.map((line) => {
    if (typeof line === "string") {
      return jsx("text", { children: line || " " });
    }

    const color = "NO_COLOR" in process.env ? {} : { fg: statusColor(theme, line.signal.kind) };
    const link = line.link === "link unavailable"
      ? line.link
      : jsx("a", { href: line.link, children: line.link });

    return jsx("text", {
      children: [
        line.prefix,
        jsx("span", { ...color, children: line.signal.text }),
        " — ",
        link,
      ],
    });
  });
}

const plugin: TuiPluginModule & { id: string } = {
  id: "premind.status-tui",
  async tui(api) {
    const daemon = new PremindDaemonClient({
      ensureDaemon: async () => undefined,
      maxRetries: 0,
    });

    api.command.register(() => [{
      title: "Premind status",
      value: "premind:status",
      category: "Premind",
      slash: { name: "premind:status" },
      onSelect() {
        const route = api.route.current;
        let sessionId: string | undefined;
        if (route.name === "session" && "params" in route) {
          const routeSessionId = route.params?.sessionID;
          if (typeof routeSessionId === "string") sessionId = routeSessionId;
        }

        void daemon.debugStatus({ includeSnapshots: true }).then((status) => {
          const lines = getCurrentStatusLines(status, sessionId);
          api.ui.dialog.replace(() => api.ui.Dialog({
            size: "large",
            onClose: () => api.ui.dialog.clear(),
            children: jsx("scrollbox", {
              height: 20,
              children: jsx("box", {
                flexDirection: "column",
                children: coloredStatusLines(lines, api.theme.current),
              }),
            }),
          }));
        }).catch(() => {
          api.ui.toast({ variant: "error", message: "premind unavailable · /premind:doctor" });
        });
      },
    }]);
  },
};

export default plugin;
