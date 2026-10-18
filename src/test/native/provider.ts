import http from "node:http"
import { once } from "node:events"

/** External model fixture only. Receipts depend solely on visible message content. */
export async function startScriptedProvider(marker: string) {
	if (marker.length < 16 || /\s/.test(marker)) throw new Error("Invalid reminder marker")
	const observations: Array<{ markerObserved: boolean }> = []
	const tools: Array<{ name: string; arguments: Record<string, unknown> }> = []
	const receipt = `premind-receipt:${marker}`
	const server = http.createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end()
			return
		}
		try {
			let body = ""
			for await (const chunk of request) {
				body += chunk.toString()
				if (body.length > 262_144) throw new Error("Request exceeds fixture limit")
			}
			const payload = JSON.parse(body)
			if (!Array.isArray(payload.messages) || payload.stream !== true || observations.length >= 32) {
				throw new Error("Unsupported fixture request")
			}
			// Deliberately do not inspect tool schemas, request metadata, model names,
			// or authentication headers: those are not model-visible reminder content.
			const content = payload.messages.map((message: { content?: unknown }) => {
				if (typeof message.content === "string") return message.content
				if (!Array.isArray(message.content)) return ""
				return message.content.filter((part: { type?: unknown }) => part?.type === "text")
					.map((part: { text?: unknown }) => typeof part.text === "string" ? part.text : "").join("\n")
			}).join("\n")
			const markerObserved = content.includes(marker)
			observations.push({ markerObserved })
			const tool = tools.shift()
			const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `fixture-${observations.length}`, type: "function", function: {
				name: tool.name, arguments: JSON.stringify(tool.arguments),
			} }] } : { role: "assistant", content: markerObserved ? receipt : "No reminder marker observed." }
			const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
			const base = { id: `fixture-${observations.length}`, object: "chat.completion.chunk", created: 1, model: "premind-native-fixture" }
			response.writeHead(200, { "content-type": "text/event-stream" })
			response.end(chunk({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) +
				chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n")
		} catch {
			response.writeHead(400).end("Invalid scripted-provider request")
		}
	})
	server.requestTimeout = 2_000
	server.headersTimeout = 2_000
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const address = server.address()
	if (!address || typeof address === "string") throw new Error("Missing provider address")
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`, receipt, observations,
		queueToolCall(name: string, args: Record<string, unknown>) {
			if (tools.length >= 8) throw new Error("Too many queued fixture tools")
			tools.push({ name, arguments: args })
		},
		stop: async () => {
			const closed = new Promise<void>((resolve) => server.close(() => resolve()))
			server.closeAllConnections()
			await closed
		},
	}
}
