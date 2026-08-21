// Network-guard tests: loopback regression, trusted-host matching
// (port-less vs explicit-port entries), TLS-terminated origin comparison,
// and trustedHosts entry validation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { assertTrustedAuthority, isTrustedHost, networkGuard } from '../src/guard.ts'

function req(headers: Record<string, string>, encrypted = false): IncomingMessage {
  return { headers, socket: { encrypted } } as unknown as IncomingMessage
}

test('loopback hosts pass without trustedHosts (regression)', () => {
  assert.equal(networkGuard(req({ host: '127.0.0.1:3080' })), null)
  assert.equal(networkGuard(req({ host: 'localhost:3080' })), null)
  assert.equal(networkGuard(req({ host: '[::1]:3080' })), null)
  assert.equal(networkGuard(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' })), null)
  assert.equal(networkGuard(req({ host: 'localhost:3080', origin: 'http://localhost:3080' })), null)
})

test('non-loopback hosts are rejected without trustedHosts', () => {
  assert.equal(networkGuard(req({ host: 'dsh.example.com' })), 'forbidden: non-loopback host')
  assert.equal(networkGuard(req({ host: '192.168.31.17:3080' })), 'forbidden: non-loopback host')
  assert.equal(networkGuard(req({ host: 'example.com' })), 'forbidden: non-loopback host')
})

test('port-less trusted entry matches any port', () => {
  const trusted = ['dsh.example.com']
  assert.equal(networkGuard(req({ host: 'dsh.example.com' }), trusted), null)
  assert.equal(networkGuard(req({ host: 'dsh.example.com:443' }), trusted), null)
  assert.equal(networkGuard(req({ host: 'dsh.example.com:8443', origin: 'https://dsh.example.com:8443' }), trusted), null)
  // Subdomains are not covered by a bare-host grant.
  assert.equal(networkGuard(req({ host: 'evil.dsh.example.com' }), trusted), 'forbidden: non-loopback host')
  assert.equal(networkGuard(req({ host: 'xdsh.example.com' }), trusted), 'forbidden: non-loopback host')
})

test('explicit-port trusted entry matches that port only', () => {
  const trusted = ['dsh.example.com:8443']
  assert.equal(networkGuard(req({ host: 'dsh.example.com:8443' }), trusted), null)
  assert.equal(networkGuard(req({ host: 'dsh.example.com' }), trusted), 'forbidden: non-loopback host')
  assert.equal(networkGuard(req({ host: 'dsh.example.com:9443' }), trusted), 'forbidden: non-loopback host')
})

test('https origin passes on a plain-HTTP socket (TLS terminated upstream)', () => {
  const trusted = ['dsh.example.com']
  // Caddy/frp terminate TLS: the server socket is plain HTTP, the browser
  // Origin is https. Host-part comparison must accept this.
  assert.equal(networkGuard(req({ host: 'dsh.example.com', origin: 'https://dsh.example.com', 'sec-fetch-site': 'same-origin' }), trusted), null)
  // And the loopback deployment keeps working with an https front as well.
  assert.equal(networkGuard(req({ host: '127.0.0.1:3080', origin: 'https://127.0.0.1:3080' })), null)
})

test('foreign or malformed origins are rejected', () => {
  const trusted = ['dsh.example.com']
  assert.equal(networkGuard(req({ host: 'dsh.example.com', origin: 'https://evil.com' }), trusted), 'forbidden: cross-origin')
  assert.equal(networkGuard(req({ host: 'dsh.example.com', origin: 'not a url' }), trusted), 'forbidden: cross-origin')
  assert.equal(networkGuard(req({ host: 'dsh.example.com', origin: 'https://dsh.example.com.evil.com' }), trusted), 'forbidden: cross-origin')
  assert.equal(networkGuard(req({ host: 'dsh.example.com', origin: 'https://dsh.example.com:8443' }), trusted), 'forbidden: cross-origin')
  assert.equal(networkGuard(req({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' })), 'forbidden: cross-origin')
})

test('cross-site fetch metadata is rejected (same-site stays rejected, as before)', () => {
  const trusted = ['dsh.example.com']
  assert.equal(networkGuard(req({ host: 'dsh.example.com', 'sec-fetch-site': 'cross-site' }), trusted), 'forbidden: cross-site')
  assert.equal(networkGuard(req({ host: 'dsh.example.com', 'sec-fetch-site': 'same-site' }), trusted), 'forbidden: cross-site')
  assert.equal(networkGuard(req({ host: 'dsh.example.com', 'sec-fetch-site': 'same-origin' }), trusted), null)
  assert.equal(networkGuard(req({ host: 'dsh.example.com', 'sec-fetch-site': 'none' }), trusted), null)
})

test('host header matching is case-insensitive', () => {
  const trusted = ['dsh.example.com']
  assert.equal(networkGuard(req({ host: 'Dsh.Example.Com' }), trusted), null)
  assert.equal(networkGuard(req({ host: 'Dsh.Example.Com', origin: 'https://dsh.example.com' }), trusted), null)
})

test('isTrustedHost is exact per entry', () => {
  assert.equal(isTrustedHost('dsh.example.com', ['dsh.example.com']), true)
  assert.equal(isTrustedHost('dsh.example.com:443', ['dsh.example.com']), true)
  assert.equal(isTrustedHost('dsh.example.com', ['dsh.example.com:443']), false)
  assert.equal(isTrustedHost('dsh.example.com:443', ['dsh.example.com:443']), true)
  assert.equal(isTrustedHost('dsh.example.com', []), false)
  assert.equal(isTrustedHost('garbage host with space', ['dsh.example.com']), false)
})

test('assertTrustedAuthority accepts canonical bare authorities', () => {
  assert.doesNotThrow(() => assertTrustedAuthority('dsh.example.com'))
  assert.doesNotThrow(() => assertTrustedAuthority('dsh.example.com:8443'))
  assert.doesNotThrow(() => assertTrustedAuthority('192.168.31.17'))
  assert.doesNotThrow(() => assertTrustedAuthority('Dsh.Example.Com'))
  assert.doesNotThrow(() => assertTrustedAuthority('dsh.example.com:443'))
  assert.doesNotThrow(() => assertTrustedAuthority('dsh.example.com:80'))
})

test('assertTrustedAuthority rejects typos that parsing would rewrite', () => {
  for (const entry of [
    'dsh.example.com/path',
    'user@dsh.example.com',
    ' dsh.example.com',
    'dsh.example.com ',
    'dsh.example.com:',
    'dsh.example.com:0080',
    '0x7f.0.0.1',
    '[::1',
    'dsh.example.com:port'
  ]) {
    assert.throws(() => assertTrustedAuthority(entry), /bare host\[:port\] authority/, `entry ${JSON.stringify(entry)}`)
  }
})
