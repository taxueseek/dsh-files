// Paste-text surface tests: session routing, min-length gate, byte cap, name
// sanitization, content dedup, and the loopback guard.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createPasteTextHandler, type PasteTextOptions } from '../src/paste.ts'

async function withServer(options: PasteTextOptions, fn: (base: string) => Promise<void>): Promise<void> {
  const handler = createPasteTextHandler(options)
  const server = createServer((req, res) => {
    void handler(req as IncomingMessage, res as ServerResponse)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

const LONG_TEXT = 'line one\n' + 'x'.repeat(4000) + '\nlast line'

test('paste-text stores long text per session under the session cwd', async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), 'dsh-files-paste-'))
  const sessions = new Map([['session-a', sessionDir]])
  await withServer(
    {
      maxBytes: 1024 * 1024,
      minChars: 100,
      defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-paste-fallback-')),
      sessionCwd: (id) => sessions.get(id)
    },
    async (base) => {
      const res = await fetch(`${base}/api/paste-text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-id': 'session-a' },
        body: JSON.stringify({ text: LONG_TEXT })
      })
      assert.equal(res.status, 200)
      const payload = (await res.json()) as { path: string; bytes: number; lines: number; chars: number }
      assert.equal(payload.lines, 3)
      assert.equal(payload.chars, LONG_TEXT.length)
      assert.ok(payload.path.startsWith(join(sessionDir, '.dsh-filess', 'session-a')))
      const files = await readdir(join(sessionDir, '.dsh-filess', 'session-a'))
      assert.equal(files.length, 1)
      const stored = await readFile(payload.path, 'utf8')
      assert.equal(stored, LONG_TEXT)
    }
  )
})

test('paste-text rejects text shorter than minChars', async () => {
  await withServer(
    {
      maxBytes: 1024 * 1024,
      minChars: 200,
      defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-paste-fallback-')),
      sessionCwd: () => 'cwd'
    },
    async (base) => {
      const res = await fetch(`${base}/api/paste-text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'short' })
      })
      assert.equal(res.status, 400)
    }
  )
})

test('paste-text rejects oversized UTF-8 payloads', async () => {
  await withServer(
    {
      maxBytes: 100,
      minChars: 1,
      defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-paste-fallback-')),
      sessionCwd: () => 'cwd'
    },
    async (base) => {
      const res = await fetch(`${base}/api/paste-text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '汉'.repeat(200) })
      })
      assert.equal(res.status, 413)
    }
  )
})

test('unknown session is rejected when a session resolver exists', async () => {
  await withServer(
    {
      maxBytes: 1024 * 1024,
      minChars: 1,
      defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-paste-fallback-')),
      sessionCwd: () => undefined
    },
    async (base) => {
      const res = await fetch(`${base}/api/paste-text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-id': 'ghost' },
        body: JSON.stringify({ text: 'x'.repeat(500) })
      })
      assert.equal(res.status, 403)
    }
  )
})

test('identical pasted text deduplicates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-files-paste-fallback-'))
  await withServer(
    { maxBytes: 1024 * 1024, minChars: 10, defaultDir: dir, sessionCwd: () => dir },
    async (base) => {
      const body = JSON.stringify({ text: 'a'.repeat(500) })
      const first = await fetch(`${base}/api/paste-text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body
      })
      const second = await fetch(`${base}/api/paste-text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body
      })
      assert.equal(first.status, 200)
      assert.equal(second.status, 200)
      const a = (await first.json()) as { deduplicated?: boolean }
      const b = (await second.json()) as { deduplicated?: boolean }
      assert.equal(a.deduplicated, undefined)
      assert.equal(b.deduplicated, true)
    }
  )
})

test('paste-text is refused for non-loopback hosts', async () => {
  await withServer(
    { maxBytes: 1024 * 1024, minChars: 1, defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-paste-fallback-')), sessionCwd: () => 'cwd' },
    async (_base) => {
      // Direct handler call with a hostile Host header.
      const handler = createPasteTextHandler({
        maxBytes: 1024 * 1024,
        minChars: 1,
        defaultDir: await mkdtemp(join(tmpdir(), 'dsh-files-paste-fallback-')),
        sessionCwd: () => 'cwd'
      })
      const req = {
        method: 'POST',
        headers: { host: 'evil.example.com' },
        socket: {}
      } as unknown as IncomingMessage
      const res = {
        writeHead: (status: number) => {
          assert.equal(status, 403)
        },
        end: () => undefined
      } as unknown as ServerResponse
      await handler(req, res)
    }
  )
})
