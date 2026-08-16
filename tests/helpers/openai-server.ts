import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A scripted OpenAI-compatible chat-completions endpoint on loopback.
 *
 * The point is to exercise the REAL provider package and the REAL wire format
 * — SSE framing, tool_calls deltas, json_schema responses — without a network
 * call or an API key. A mock LanguageModel would skip all of that; this only
 * skips the model's judgement, which is exactly the part a test must not
 * depend on anyway.
 */

export interface IChatRequest {
  stream: boolean
  messages: { role: string; content: unknown; tool_call_id?: string }[]
  tools?: { function?: { name?: string } }[]
  response_format?: { type?: string; json_schema?: { name?: string; schema?: unknown } }
}

/** What the scripted model should answer with. */
export interface IScriptedReply {
  /** Plain assistant text (or the JSON body for a structured-output call). */
  text?: string
  /** Tool calls to emit instead of text. */
  toolCalls?: { name: string; args: unknown }[]
}

export type Script = (request: IChatRequest) => IScriptedReply

export interface ILocalOpenAI {
  baseURL: string
  /** Every request the agent made, in order — assert the call sequence on it. */
  requests: IChatRequest[]
  close: () => Promise<void>
}

const CHUNK_HEAD = {
  id: 'chatcmpl-test',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'scripted',
}

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`

const streamBody = (reply: IScriptedReply): string => {
  const parts: string[] = []
  parts.push(sse({ ...CHUNK_HEAD, choices: [{ index: 0, delta: { role: 'assistant' } }] }))

  if (reply.toolCalls?.length) {
    reply.toolCalls.forEach((call, index) => {
      // Real providers split a tool call across chunks: the id/name arrive
      // first, then the arguments in fragments. Reproduce that, or the test
      // would not cover the provider's accumulation logic.
      parts.push(
        sse({
          ...CHUNK_HEAD,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    id: `call_${index}`,
                    type: 'function',
                    function: { name: call.name, arguments: '' },
                  },
                ],
              },
            },
          ],
        }),
      )
      const args = JSON.stringify(call.args ?? {})
      const half = Math.ceil(args.length / 2)
      for (const fragment of [args.slice(0, half), args.slice(half)]) {
        parts.push(
          sse({
            ...CHUNK_HEAD,
            choices: [
              { index: 0, delta: { tool_calls: [{ index, function: { arguments: fragment } }] } },
            ],
          }),
        )
      }
    })
    parts.push(
      sse({ ...CHUNK_HEAD, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    )
  } else {
    const text = reply.text ?? ''
    // Split text into a few deltas so the consumer's streaming path runs.
    const size = Math.max(1, Math.ceil(text.length / 3))
    for (let i = 0; i < text.length; i += size) {
      parts.push(
        sse({
          ...CHUNK_HEAD,
          choices: [{ index: 0, delta: { content: text.slice(i, i + size) } }],
        }),
      )
    }
    parts.push(sse({ ...CHUNK_HEAD, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
  }

  parts.push(sse({ ...CHUNK_HEAD, choices: [], usage: USAGE }))
  parts.push('data: [DONE]\n\n')
  return parts.join('')
}

const jsonBody = (reply: IScriptedReply): string =>
  JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'scripted',
    choices: [
      {
        index: 0,
        message: reply.toolCalls?.length
          ? {
              role: 'assistant',
              content: null,
              tool_calls: reply.toolCalls.map((call, index) => ({
                id: `call_${index}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
              })),
            }
          : { role: 'assistant', content: reply.text ?? '' },
        finish_reason: reply.toolCalls?.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: USAGE,
  })

/** Start the endpoint on an ephemeral port. `script` decides each answer. */
export const startLocalOpenAI = async (script: Script): Promise<ILocalOpenAI> => {
  const requests: IChatRequest[] = []

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (!req.url?.includes('/chat/completions')) {
        res.writeHead(404).end('not found')
        return
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}') as IChatRequest
      requests.push(parsed)
      const reply = script(parsed)
      if (parsed.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.end(streamBody(reply))
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(jsonBody(reply))
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** True when the request is a structured-output call for the named schema. */
export const wantsSchema = (req: IChatRequest, name: string): boolean =>
  JSON.stringify(req.response_format ?? {}).includes(name)

/** True when the conversation already carries a tool result. */
export const hasToolResult = (req: IChatRequest): boolean =>
  req.messages.some((m) => m.role === 'tool' || m.tool_call_id !== undefined)
