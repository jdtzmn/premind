import { createDaemonLauncher } from "../client/daemon-launcher.ts";
import { PREMIND_SOCKET_PATH } from "../shared/constants.ts";
import { writePluginRuntimeState } from "./debug-state.ts";

export const ensureDaemonRunning = (socketPath = PREMIND_SOCKET_PATH) =>
  createDaemonLauncher({
    socketPath,
    onDiagnostic: ({ phase, daemonStarted, ...daemonDiagnostics }) => {
      writePluginRuntimeState({
        phase,
        daemonStarted,
        daemonDiagnostics,
      });
    },
  })();
