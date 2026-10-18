import { EventEmitter } from "node:events"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { NativeSandbox } from "./sandbox.ts"

/** Only the external GitHub service/credential provider is scripted. */
export async function startScriptedGitHub(sandbox: NativeSandbox) {
	const changes = new EventEmitter()
	const comments: Array<Record<string, unknown>> = []
	let snapshots = 0
	const server = createServer(async (request, response) => {
		response.setHeader("content-type", "application/json")
		response.setHeader("x-ratelimit-remaining", "5000")
		response.setHeader("x-ratelimit-reset", String(Math.floor(Date.now() / 1000) + 3600))
		response.setHeader("x-ratelimit-resource", "graphql")
		if (request.headers.authorization !== "Bearer native-fixture-no-auth") {
			response.writeHead(401); response.end(JSON.stringify({ message: "Expected synthetic fixture credential" })); return
		}
		if (request.method === "GET" && request.url === "/user") {
			response.end(JSON.stringify({ login: "native-author" })); return
		}
		if (request.method !== "POST" || request.url !== "/graphql") {
			response.writeHead(404); response.end(JSON.stringify({ message: "Unexpected fixture endpoint" })); return
		}
		let body = ""
		try {
			for await (const chunk of request) {
				body += chunk.toString()
				if (body.length > 262_144) throw new Error("GitHub fixture request too large")
			}
			const query = JSON.parse(body)
			if (typeof query.query !== "string" || !query.query.includes("PullRequestSnapshot") ||
				query.variables?.owner !== "native" || query.variables?.repo !== "fixture" || query.variables?.number !== 17) {
				throw new Error("Unexpected fixture pull request")
			}
			response.setHeader("etag", `"native-${comments.length}"`)
			response.end(JSON.stringify({ data: { repository: { pullRequest: {
				number: 17, title: "Native lifecycle fixture", url: "https://github.com/native/fixture/pull/17",
				author: { login: "native-author" }, state: "OPEN", isDraft: false,
				headRefName: "native-feature", baseRefName: "main", headRefOid: "a".repeat(40),
				mergeStateStatus: "CLEAN", reviewDecision: null, updatedAt: "2026-01-01T00:00:00Z",
				reviewRequests: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [...comments] },
				reviewThreads: { nodes: [] }, commits: { nodes: [] },
			} } } }))
			snapshots++
			changes.emit("snapshot")
		} catch {
			response.writeHead(400); response.end(JSON.stringify({ message: "Invalid fixture request" }))
		}
	})
	server.requestTimeout = 5000
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
	const address = server.address()
	if (!address || typeof address === "string") { server.close(); throw new Error("GitHub fixture did not bind TCP") }
	const baseUrl = `http://127.0.0.1:${address.port}`
	try {
		const bin = path.join(sandbox.root, "github-bin")
		mkdirSync(bin, { recursive: true })
		writeFileSync(path.join(bin, "gh"), '#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "token" ]; then printf "native-fixture-no-auth\\n"; else exit 1; fi\n', { mode: 0o700 })
		const preload = path.join(sandbox.root, "github-transport.mjs")
		// Redirect only external HTTP transport, never production policy or lifecycle.
		writeFileSync(preload, `const realFetch = globalThis.fetch;\nglobalThis.fetch = (input, init) => {\n const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);\n if (url.origin !== "https://api.github.com") throw new Error("Unexpected GitHub fixture fetch origin");\n const target = new URL(url.pathname + url.search, ${JSON.stringify(baseUrl)});\n return realFetch(input instanceof Request ? new Request(target, input) : target, init);\n};\n`)
		return {
			baseUrl, preload: pathToFileURL(preload).href,
			env: { ...sandbox.env, PATH: `${bin}${path.delimiter}${sandbox.env.PATH ?? ""}` },
			get snapshots() { return snapshots },
			publishComment(body: string) {
				const timestamp = new Date().toISOString()
				comments.push({ databaseId: comments.length + 1, body, createdAt: timestamp, updatedAt: timestamp, author: { login: "native-reviewer" } })
			},
			waitForSnapshot(count: number, timeoutMs = 45_000) {
				if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid snapshot wait")
				if (snapshots >= count) return Promise.resolve()
				return new Promise<void>((resolve, reject) => {
					const check = () => { if (snapshots >= count) finish() }
					const timer = setTimeout(() => finish(new Error(`GitHub fixture expected snapshot ${count}, received ${snapshots}`)), timeoutMs)
					const finish = (error?: Error) => { clearTimeout(timer); changes.off("snapshot", check); error ? reject(error) : resolve() }
					changes.on("snapshot", check)
				})
			},
			stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
		}
	} catch (error) { server.closeAllConnections(); server.close(); throw error }
}
