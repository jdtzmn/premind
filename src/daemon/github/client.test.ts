import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GitHubClient } from "./client.ts";
import { GitHubHttpClient } from "./http.ts";

const authHeader = async () => "test-token";

describe("GitHubClient", () => {
  test("caches the authenticated viewer login", async () => {
    let calls = 0;
    const http = new GitHubHttpClient({
      tokenProvider: authHeader,
      fetchImpl: async (input) => {
        calls++;
        assert.equal(String(input), "https://api.github.com/user");
        return new Response(JSON.stringify({ login: "octocat" }), {
          status: 200,
        });
      },
    });
    const client = new GitHubClient({ http });

    assert.equal(await client.getViewerLogin(), "octocat");
    assert.equal(await client.getViewerLogin(), "octocat");
    assert.equal(calls, 1);
  });

  test("includes the PR author in branch discovery", async () => {
    const http = new GitHubHttpClient({
      tokenProvider: authHeader,
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            {
              number: 42,
              title: "Foreign PR",
              html_url: "https://github.com/acme/repo/pull/42",
              draft: false,
              state: "open",
              user: { login: "someone-else" },
            },
          ]),
          { status: 200 },
        ),
    });
    const client = new GitHubClient({ http });

    const result = await client.findOpenPullRequestForBranch(
      "acme/repo",
      "feature/test",
    );

    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    assert.equal(result.pr?.authorLogin, "someone-else");
  });
});
