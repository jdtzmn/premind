import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, test } from "node:test"
import { resolveGitWorktree, type GitCommandRunner } from "./git-resolver.ts"

const exec = promisify(execFile)
const dirs: string[] = []

const git = async (cwd: string, ...args: string[]) => {
  const { stdout } = await exec("git", args, { cwd })
  return stdout.trim()
}

const localRunner: GitCommandRunner = async (command, args, cwd) => {
  if (command === "gh") throw new Error("offline test")
  return git(cwd, ...args)
}

const createRepository = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "premind-worktree-"))
  dirs.push(root)
  await git(root, "init", "-b", "main")
  await git(root, "config", "user.name", "Premind Test")
  await git(root, "config", "user.email", "premind@example.invalid")
  await git(root, "remote", "add", "origin", "git@github.com:acme/widgets.git")
  fs.writeFileSync(path.join(root, "README.md"), "test\n")
  await git(root, "add", "README.md")
  await git(root, "commit", "-m", "initial")
  return root
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true })
})

test("resolves a descendant of a linked worktree to canonical identity", async () => {
  const root = await createRepository()
  const linked = path.join(root, "linked")
  await git(root, "worktree", "add", "-b", "feature/linked", linked)
  const descendant = path.join(linked, "src", "nested")
  fs.mkdirSync(descendant, { recursive: true })

  const resolved = await resolveGitWorktree(descendant, localRunner)
  assert.equal(resolved.root, fs.realpathSync(linked))
  assert.equal(resolved.repo, "acme/widgets")
  assert.equal(resolved.branch, "feature/linked")
  assert.match(resolved.gitDir, /\.git\/worktrees\/linked$/)
  assert.match(resolved.headSha, /^[0-9a-f]{40}$/)
})

test("represents a detached worktree without an automatic branch", async () => {
  const root = await createRepository()
  const detached = path.join(root, "detached")
  await git(root, "worktree", "add", "--detach", detached, "HEAD")

  const resolved = await resolveGitWorktree(detached, localRunner)
  assert.equal(resolved.root, fs.realpathSync(detached))
  assert.equal(resolved.repo, "acme/widgets")
  assert.equal(resolved.branch, null)
})
