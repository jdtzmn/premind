import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const run = async (command: string, args: string[], cwd: string) => {
  const { stdout } = await execFileAsync(command, args, { cwd })
  return stdout.trim()
}

const parseRepoFromRemote = (remote: string) => {
  const trimmed = remote.trim()
  const sshMatch = trimmed.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)
  if (sshMatch?.[1]) return sshMatch[1]
  return undefined
}

export async function detectGitContext(cwd: string) {
  const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd).catch(() => "unknown")

  const repoFromGh = await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd).catch(
    () => undefined,
  )

  if (repoFromGh) {
    return { repo: repoFromGh, branch }
  }

  const remote = await run("git", ["remote", "get-url", "origin"], cwd).catch(() => undefined)
  const parsedRepo = remote ? parseRepoFromRemote(remote) : undefined

  return {
    repo: parsedRepo ?? cwd,
    branch,
  }
}
