import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

/**
 * A local OpenAI-compatible chat completions endpoint for end-to-end tests.
 * It records every request and answers from a script: each queued reply is
 * used once, in order, and an empty queue answers with plain text.
 *
 * OpenCode also asks the model for a session title. Those requests are
 * answered with a fixed title without using the script.
 */

export type FakeToolCall = { name: string; arguments: Record<string, unknown> }

export type FakeReply = { text: string } | { toolCalls: FakeToolCall[] }

export type FakeModelMessage = { role: string; content: unknown; tool_call_id?: string }

export type FakeModelRequest = {
  model?: string
  messages: FakeModelMessage[]
  tools?: Array<{ type: string; function: { name: string } }>
  stream?: boolean
}

export type FakeModel = {
  url: string
  /** Chat requests for the agent's turns, without title requests. */
  requests: FakeModelRequest[]
  /** Queue replies used by the next agent turns. */
  reply(...replies: FakeReply[]): void
  /** Text of every user message the model has seen, across all turns. */
  userMessages(): string[]
  close(): Promise<void>
}

const DEFAULT_REPLY = "ok"

// Agent turns always offer tools; the title request offers none.
const isTitleRequest = (request: FakeModelRequest) => !request.tools?.length

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("")
  }
  return ""
}

export const startFakeModel = async (): Promise<FakeModel> => {
  const requests: FakeModelRequest[] = []
  const script: FakeReply[] = []
  let completion = 0

  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    `data: ${JSON.stringify({
      id: `chatcmpl-${completion}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "test",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(finishReason ? { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } } : {}),
    })}\n\n`

  const server: Server = createServer(async (request, response) => {
    let body = ""
    for await (const part of request) body += part
    if (request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ object: "list", data: [{ id: "test", object: "model" }] }))
      return
    }

    const parsed = (body ? JSON.parse(body) : { messages: [] }) as FakeModelRequest
    completion += 1
    let reply: FakeReply
    if (isTitleRequest(parsed)) {
      reply = { text: "Test session" }
    } else {
      requests.push(parsed)
      reply = script.shift() ?? { text: DEFAULT_REPLY }
    }

    response.writeHead(200, { "content-type": "text/event-stream" })
    if ("text" in reply) {
      response.write(chunk({ role: "assistant", content: reply.text }))
      response.write(chunk({}, "stop"))
    } else {
      reply.toolCalls.forEach((call, index) => {
        response.write(
          chunk({
            role: "assistant",
            tool_calls: [
              {
                index,
                id: `call_${completion}_${index}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              },
            ],
          }),
        )
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
      requests.flatMap((request) => request.messages.filter((message) => message.role === "user").map((message) => textOf(message.content))),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
