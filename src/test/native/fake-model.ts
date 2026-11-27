import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

/**
 * A local OpenAI-compatible chat completions endpoint shared by every host
 * driver. It records each agent request and answers from a script: queued
 * replies are used once, in order, and an empty queue answers "ok".
 *
 * Hosts may also send requests that are not agent turns, such as OpenCode's
 * session-title request. The host driver names those with `isAuxiliary`; they
 * are answered without using the script and are not recorded as agent turns.
 */

export type FakeToolCall = { name: string; arguments: Record<string, unknown> }

export type FakeReply = ({ text: string } | { toolCalls: FakeToolCall[] }) & {
	/** Hold the response until this settles, to keep the host's turn running. */
	waitFor?: Promise<void>
}

export type FakeModelMessage = { role: string; content: unknown; tool_call_id?: string }

export type FakeModelRequest = {
	model?: string
	messages: FakeModelMessage[]
	tools?: Array<{ type: string; function: { name: string } }>
	stream?: boolean
}

export type FakeModelOptions = {
	/** Requests the host makes outside agent turns, with the text to answer them. */
	isAuxiliary?: (request: FakeModelRequest) => string | undefined
}

export type FakeModel = {
	/** Base URL including `/v1`. */
	url: string
	/** Agent-turn requests, in arrival order. */
	requests: FakeModelRequest[]
	reply(...replies: FakeReply[]): void
	/** Text of every user message in every agent request. */
	userMessages(): string[]
	close(): Promise<void>
}

export const textOf = (content: unknown): string => {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
		.join("")
}

export async function startFakeModel(options: FakeModelOptions = {}): Promise<FakeModel> {
	const requests: FakeModelRequest[] = []
	const script: FakeReply[] = []
	let completion = 0

	const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
		`data: ${JSON.stringify({
			id: `chatcmpl-${completion}`,
			object: "chat.completion.chunk",
			created: 1,
			model: "premind-e2e",
			choices: [{ index: 0, delta, finish_reason: finishReason }],
			...(finishReason ? { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } : {}),
		})}\n\n`

	const server: Server = createServer(async (request, response) => {
		let body = ""
		for await (const part of request) body += part
		if (request.url?.endsWith("/models")) {
			response.writeHead(200, { "content-type": "application/json" })
			response.end(JSON.stringify({ object: "list", data: [{ id: "premind-e2e", object: "model" }] }))
			return
		}

		const parsed = (body ? JSON.parse(body) : { messages: [] }) as FakeModelRequest
		completion += 1
		const auxiliary = options.isAuxiliary?.(parsed)
		let reply: FakeReply
		if (auxiliary !== undefined) {
			reply = { text: auxiliary }
		} else {
			requests.push(parsed)
			reply = script.shift() ?? { text: "ok" }
		}
		await reply.waitFor

		response.writeHead(200, { "content-type": "text/event-stream" })
		if ("text" in reply) {
			response.write(chunk({ role: "assistant", content: reply.text }))
			response.write(chunk({}, "stop"))
		} else {
			reply.toolCalls.forEach((call, index) => {
				response.write(chunk({
					role: "assistant",
					tool_calls: [{
						index,
						id: `call_${completion}_${index}`,
						type: "function",
						function: { name: call.name, arguments: JSON.stringify(call.arguments) },
					}],
				}))
			})
			response.write(chunk({}, "tool_calls"))
		}
		response.write("data: [DONE]\n\n")
		response.end()
	})

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as AddressInfo

	return {
		url: `http://127.0.0.1:${port}/v1`,
		requests,
		reply: (...replies) => {
			script.push(...replies)
		},
		userMessages: () =>
			requests.flatMap((request) =>
				request.messages.filter((message) => message.role === "user").map((message) => textOf(message.content)),
			),
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections()
				server.close(() => resolve())
			}),
	}
}
