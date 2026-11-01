import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { SessionInfo, SessionMessageInfo } from '@opencode/client'
import { makeLegacyClient } from './client'

const sessions = Array.from({ length: 260 }, (_, index) => makeSession(index))
const messages = Array.from({ length: 150 }, (_, index) => makeMessage(index))
let server: ReturnType<typeof Bun.serve>
let legacy: ReturnType<typeof makeLegacyClient>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/api/session') {
        const limit = Number(url.searchParams.get('limit') ?? '50')
        const offset = Number(url.searchParams.get('cursor') ?? '0')
        const page = sessions.slice(offset, offset + limit)
        const next = offset + page.length
        return Response.json({
          data: page,
          cursor: next < sessions.length ? { next: String(next) } : {},
        })
      }
      if (url.pathname === '/api/session/ses_0/message') {
        // Always serve newest-first, like the real endpoint's default order.
        const limit = Number(url.searchParams.get('limit') ?? '50')
        const offset = Number(url.searchParams.get('cursor') ?? '0')
        const newestFirst = [...messages].reverse()
        const page = newestFirst.slice(offset, offset + limit)
        const next = offset + page.length
        return Response.json({
          data: page,
          cursor: next < newestFirst.length ? { next: String(next) } : {},
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
  legacy = makeLegacyClient({
    baseUrl: server.url.origin,
    headers: {},
    fetch: globalThis.fetch,
    requestJson: async () => {
      throw new Error('fork endpoints are not used in this test')
    },
  })
})

afterAll(() => {
  server.stop(true)
})

describe('legacy client pagination', () => {
  test('follows session cursors until the requested window is filled', async () => {
    const result = await legacy.session.list({ limit: 250, roots: true })
    expect(result.data).toHaveLength(250)
    expect(result.data[0]?.id).toBe('ses_0')
    expect(result.data.at(-1)?.id).toBe('ses_249')
  })

  test('applies start as an offset across session pages', async () => {
    const result = await legacy.session.list({ limit: 20, start: 240, roots: true })
    expect(result.data.map((session) => session.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `ses_${240 + index}`),
    )
  })

  test('loads every message page in chronological order', async () => {
    const result = await legacy.session.messages({ sessionID: 'ses_0' })
    expect(result.data).toHaveLength(150)
    expect(result.data[0]?.info.id).toBe('msg_0')
    expect(result.data.at(-1)?.info.id).toBe('msg_149')
  })

  test('returns the newest messages when a limit is requested', async () => {
    const result = await legacy.session.messages({ sessionID: 'ses_0', limit: 40 })
    expect(result.data.map((message) => message.info.id)).toEqual(
      Array.from({ length: 40 }, (_, index) => `msg_${110 + index}`),
    )
  })
})

function makeSession(index: number): SessionInfo {
  return {
    id: `ses_${index}`,
    projectID: 'prj_test',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: index, updated: index },
    title: `Session ${index}`,
    location: { directory: '/tmp/opencodex-test' },
  }
}

function makeMessage(index: number): SessionMessageInfo {
  return {
    id: `msg_${index}`,
    time: { created: index },
    type: 'user',
    text: `Message ${index}`,
  }
}
