import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type {
  PullRequestCheck,
  PullRequestCore,
  PullRequestIssueComment,
  PullRequestReview,
  PullRequestReviewComment,
  PullRequestSnapshot,
} from "./types.js"

const execFileAsync = promisify(execFile)

type PullRequestSummary = {
  number: number
  title: string
  url: string
  draft: boolean
  state: string
}

const execGh = async (args: string[]) => {
  const { stdout } = await execFileAsync("gh", args)
  return stdout.trim()
}

const flatten = <T>(value: unknown): T[] => {
  if (!Array.isArray(value)) return []
  const items: T[] = []
  for (const entry of value) {
    if (Array.isArray(entry)) items.push(...(entry as T[]))
    else items.push(entry as T)
  }
  return items
}

export class GitHubClient {
  async findOpenPullRequestForBranch(repo: string, branch: string): Promise<PullRequestSummary | null> {
    const [owner] = repo.split("/")
    if (!owner || !branch || branch === "HEAD" || branch === "unknown") return null

    const stdout = await execGh(["api", `repos/${repo}/pulls?head=${owner}:${branch}&state=open&per_page=1`])

    const data = JSON.parse(stdout) as Array<{
      number: number
      title: string
      html_url: string
      draft: boolean
      state: string
    }>

    const first = data[0]
    if (!first) return null

    return {
      number: first.number,
      title: first.title,
      url: first.html_url,
      draft: first.draft,
      state: first.state,
    }
  }

  async fetchPullRequestSnapshot(repo: string, prNumber: number): Promise<PullRequestSnapshot> {
    const [coreText, reviewsText, issueCommentsText, reviewCommentsText, checksText] = await Promise.all([
      execGh([
        "pr",
        "view",
        String(prNumber),
        "-R",
        repo,
        "--json",
        "number,title,url,state,isDraft,headRefName,baseRefName,headRefOid,mergeStateStatus,reviewDecision,updatedAt",
      ]),
      execGh(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${prNumber}/reviews?per_page=100`]),
      execGh(["api", "--paginate", "--slurp", `repos/${repo}/issues/${prNumber}/comments?per_page=100`]),
      execGh(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${prNumber}/comments?per_page=100`]),
      execGh([
        "pr",
        "checks",
        String(prNumber),
        "-R",
        repo,
        "--json",
        "name,state,link,event,workflow",
      ]).catch(() => "[]"),
    ])

    const core = JSON.parse(coreText) as PullRequestCore
    const reviews = flatten<PullRequestReview>(JSON.parse(reviewsText))
    const issueComments = flatten<PullRequestIssueComment>(JSON.parse(issueCommentsText))
    const reviewComments = flatten<PullRequestReviewComment>(JSON.parse(reviewCommentsText))
    const checks = JSON.parse(checksText) as PullRequestCheck[]

    return {
      core,
      reviews,
      issueComments,
      reviewComments,
      checks,
      fetchedAt: Date.now(),
    }
  }
}
