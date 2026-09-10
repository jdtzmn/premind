#!/usr/bin/env node
import { runHook } from "./lib.mjs";
import { ensureDaemonRunning } from "./ensure-daemon.mjs";

await runHook("SessionStart", ensureDaemonRunning);
