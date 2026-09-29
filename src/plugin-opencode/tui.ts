import type { TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import { jsx } from "@opentui/solid/jsx-runtime";
import { PremindDaemonClient } from "../client/daemon-client.ts";
import { renderCurrentStatus } from "../shared/status-view.ts";
import type { StatusSignal } from "../shared/status-signal.ts";

const statusRow = /^(.* · )([✗!○…✓◆?] .+) — (https:\/\/github\.com\/\S+|link unavailable)$/;

export const parseStatusRow = (line: string) => {
  const match = statusRow.exec(line);
  if (!match) return null;
  const [, prefix, signal, url] = match;
  const kind: Record<string, StatusSignal> = {
    "✗": "error", "!": "warning", "○": "muted", "…": "warning",
    "✓": "success", "◆": "merged", "?": "unknown",
  };
  return { prefix: prefix!, signal: signal!, url: url!, kind: kind[signal![0]!] ?? "unknown" };
};

export const statusColor = (theme: TuiThemeCurrent, kind: StatusSignal) => ({
  error: theme.error, warning: theme.warning, success: theme.success,
  merged: theme.accent, muted: theme.textMuted, unknown: theme.textMuted,
})[kind];

export function coloredStatusLines(text: string, theme: TuiThemeCurrent) {
  return text.split("\n").map((line) => {
    const row = parseStatusRow(line);
    if (!row) return jsx("text", { children: line || " " });
    return jsx("text", { children: [
      row.prefix,
      jsx("span", { ...(!("NO_COLOR" in process.env) ? { fg: statusColor(theme, row.kind) } : {}), children: row.signal }),
      " — ",
      row.url === "link unavailable" ? row.url : jsx("a", { href: row.url, children: row.url }),
    ] });
  });
}

const plugin: TuiPluginModule & { id: string } = {
  id: "premind.status-tui",
  async tui(api) {
    const daemon = new PremindDaemonClient({ ensureDaemon: async () => undefined, maxRetries: 0 });
    api.command.register(() => [{
      title: "Premind status", value: "premind:status", category: "Premind",
      slash: { name: "premind:status" },
      onSelect() {
        const current = api.route.current;
        const sessionId = current.name === "session" && "params" in current && typeof current.params?.sessionID === "string"
          ? current.params.sessionID : undefined;
        void daemon.debugStatus().then((status) => {
          const summary = renderCurrentStatus(status, sessionId);
          api.ui.dialog.replace(() => api.ui.Dialog({
            size: "large", onClose: () => api.ui.dialog.clear(),
            children: jsx("scrollbox", { height: 20, children: jsx("box", {
              flexDirection: "column", children: coloredStatusLines(summary, api.theme.current),
            }) }),
          }));
        }).catch(() => api.ui.toast({ variant: "error", message: "premind unavailable · /premind:doctor" }));
      },
    }]);
  },
};

export default plugin;
