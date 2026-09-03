import { execFile as execFileCallback } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import type { ActiveWorktree } from "./worktree-binding.ts"

const execFile = promisify(execFileCallback)

export type GitCommandRunner = (command: string, args: string[], cwd: string) => Promise<string>

const runCommand: GitCommandRunner = async (command, args, cwd) => {
  const { stdout } = await execFile(command, args, { cwd })
  return stdout.trim()
}

const parseRepoFromRemote = (remote: string) => {
  const match = remote.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)
  return match?.[1]
}

/** Resolves a path inside a Git worktree to its durable Premind identity. */
export async function resolveGitWorktree(
  requestedPath: string,
  run: GitCommandRunner = runCommand,
): Promise<ActiveWorktree> {
  const root = await run("git", ["rev-parse", "--show-toplevel"], requestedPath)
  const gitDirValue = await run("git", ["rev-parse", "--git-dir"], root)
  const [branchValue, headSha] = await Promise.all([
    run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root),
    run("git", ["rev-parse", "HEAD"], root),
  ])
  const repo = await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], root)
    .catch(async () => parseRepoFromRemote(await run("git", ["remote", "get-url", "origin"], root)))
  if (!repo) throw new Error(`Unable to determine GitHub repository for worktree: ${root}`)

  return {
    root,
    gitDir: path.isAbsolute(gitDirValue) ? gitDirValue : path.resolve(root, gitDirValue),
    repo,
    branch: branchValue === "HEAD" ? null : branchValue,
    headSha,
  }
}
