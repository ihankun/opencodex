import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { SessionInfo, SessionMessageInfo } from '@opencode/client'
import { makeLegacyClient } from './client'

const sessions = Array.from({ length: 260 }, (_, index) => makeSession(index))
const messages = Array.from({ length: 150 }, (_, index) => makeMessage(index))
const requests: Array<{ method: string; url: string; body: string }> = []
let server: ReturnType<typeof Bun.serve>
let legacy: ReturnType<typeof makeLegacyClient>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body =
        request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text()
      requests.push({ method: request.method, url: `${url.pathname}${url.search}`, body })
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
      if (url.pathname === '/api/session/ses_1') {
        if (request.method === 'PATCH') return new Response(null, { status: 204 })
        return Response.json({ data: makeSession(1) })
      }
      if (url.pathname === '/api/session/ses_1/diff') {
        return Response.json({ data: [] })
      }
      if (url.pathname === '/api/session/ses_1/command') {
        return new Response(null, { status: 204 })
      }
      if (url.pathname === '/api/provider/test') {
        return Response.json({
          location: { directory: '/tmp/opencodex-test' },
          data: { id: 'test', name: 'Test', activation: 'auto', package: 'test' },
        })
      }
      if (url.pathname === '/api/experimental/mcp/test') {
        return new Response(null, { status: 204 })
      }
      if (url.pathname === '/api/integration/test/connect/key') {
        return new Response(null, { status: 204 })
      }
      if (url.pathname === '/api/fs/read/bin') {
        return new Response(new Uint8Array([0xff]))
      }
      if (url.pathname === '/api/vcs/diff') {
        return Response.json({
          location: { directory: '/tmp/opencodex-test' },
          data: [
            {
              file: url.searchParams.get('mode') ?? '',
              patch: '',
              additions: 0,
              deletions: 0,
              status: 'modified',
            },
          ],
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

describe('legacy client argument mapping', () => {
  test('maps the legacy session diff message to the V2 from query', async () => {
    await legacy.session.diff({ sessionID: 'ses_1', messageID: 'msg_1' })
    expect(requests.findLast(request => request.url.startsWith('/api/session/ses_1/diff'))?.url).toContain(
      'from=msg_1',
    )
  })

  test('forwards session metadata and unarchive state', async () => {
    await legacy.session.update({
      sessionID: 'ses_1',
      title: 'Renamed',
      metadata: { source: 'test' },
      unarchive: true,
    })
    const request = requests.findLast(item => item.method === 'PATCH' && item.url.startsWith('/api/session/ses_1'))
    expect(JSON.parse(request?.body ?? '{}')).toMatchObject({
      title: 'Renamed',
      metadata: { source: 'test' },
      archived: false,
    })
  })

  test('keeps command attachments in the V2 prompt file shape', async () => {
    await legacy.session.command({
      sessionID: 'ses_1',
      command: 'test',
      arguments: 'hello',
      parts: [{ type: 'file', url: 'file:///tmp/a.txt', mime: 'text/plain', filename: 'a.txt' }],
    })
    const request = requests.findLast(item => item.url.startsWith('/api/session/ses_1/command'))
    expect(JSON.parse(request?.body ?? '{}')).toMatchObject({
      name: 'test',
      text: 'hello',
      files: [{ uri: 'file:///tmp/a.txt', name: 'a.txt' }],
    })
  })

  test('converts legacy MCP enable and timeout fields', async () => {
    await legacy.mcp.add({
      name: 'test',
      config: { type: 'local', command: ['node'], enabled: false, timeout: 5000 },
    })
    const request = requests.findLast(item => item.url.startsWith('/api/experimental/mcp/test'))
    expect(JSON.parse(request?.body ?? '{}')).toMatchObject({
      config: {
        type: 'local',
        command: ['node'],
        disabled: true,
        timeout: { startup: 5000, catalog: 5000, execution: 5000 },
      },
    })
  })

  test('forwards provider key metadata as an integration answer', async () => {
    await legacy.auth.set({
      providerID: 'test',
      auth: { type: 'api', key: 'secret', metadata: { account: 'a' } },
    })
    const request = requests.findLast(item => item.url.startsWith('/api/integration/test/connect/key'))
    expect(JSON.parse(request?.body ?? '{}')).toMatchObject({
      key: 'secret',
      answer: { account: 'a' },
    })
  })

  test('treats invalid UTF-8 as binary content', async () => {
    const result = await legacy.file.read({ path: 'bin' })
    expect(result.data).toMatchObject({ type: 'binary' })
  })
})

describe('legacy client VCS diff modes', () => {
  test('maps legacy scopes to V2 comparisons', async () => {
    expect((await legacy.vcs.diff({ mode: 'git' })).data[0]?.file).toBe('working')
    expect((await legacy.vcs.diff({ mode: 'branch' })).data[0]?.file).toBe('branch')
    expect((await legacy.vcs.diff({ mode: 'upstream' })).data[0]?.file).toBe('committed')
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
