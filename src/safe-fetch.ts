import { lookup as dnsLookup } from 'node:dns/promises'
import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { Readable, Transform } from 'node:stream'
import zlib from 'node:zlib'

// A fetch that is safe to hand to a model.
//
// What it defends against: a model (or text it was shown) steering a request at something the
// operator never meant to expose - cloud metadata, localhost services, the internal network -
// or at a host that is not on the operator's list. The checks are on the path of the request
// itself, not a pre-flight that could be raced:
//
//  - DNS is resolved by OUR lookup, called by the socket's connect. The addresses that were
//    validated are the addresses that are connected to, so a name that resolves to a public
//    address for a check and to 127.0.0.1 for the connect (DNS rebinding) has nowhere to hide.
//    A name with ANY unacceptable address is refused whole (fail closed).
//  - Every redirect hop goes through the same checks again, and may not downgrade https.
//  - Special-purpose ranges are refused by default: loopback, private, link-local (cloud
//    metadata included), CGNAT, multicast, reserved, documentation; IPv4 hidden inside IPv6
//    (mapped, NAT64, 6to4, compatible) is unwrapped and judged as the IPv4 it is.
//  - Cloud metadata endpoints and never-routable ranges stay refused even when private networks
//    are allowed.
//  - Bounded: scheme, port, method, redirects, time, and the size of what is read AFTER
//    decompression (a small gzip cannot unpack into the whole heap).
//
// What it does not do: it is not a sandbox for what the fetched TEXT says - that is still data
// the model reads. A host that is allowed is trusted to be reached.

export type EgressErrorCode =
  | 'disabled'
  | 'bad-url'
  | 'bad-protocol'
  | 'bad-port'
  | 'bad-method'
  | 'credentials-in-url'
  | 'denied-host'
  | 'not-allowed-host'
  | 'denied-address'
  | 'dns'
  | 'bad-redirect'
  | 'too-many-redirects'
  | 'too-large'
  | 'timeout'

// Thrown for every refusal, with a message the model can read and act on.
export class EgressError extends Error {
  readonly code: EgressErrorCode
  constructor(code: EgressErrorCode, message: string) {
    super(message)
    this.name = 'EgressError'
    this.code = code
  }

  toJSON(): string {
    return this.message
  }
}

export interface IResolvedAddress {
  address: string
  family: 4 | 6
}

export interface IEgressPolicy {
  // Hosts the agent may reach. Empty / absent = any host that passes the other checks. Patterns:
  // "example.com" (that host only), "*.example.com" (its subdomains, not the apex), an IP or a
  // CIDR ("203.0.113.7", "198.51.100.0/24") for IP-literal URLs.
  allow?: string[]
  // Always refused; wins over `allow`. Same patterns. An IP / CIDR here is also checked against
  // what a NAME resolves to.
  deny?: string[]
  // Let requests reach private, loopback and link-local addresses (default false). Cloud
  // metadata endpoints and never-routable ranges stay refused regardless.
  allowPrivateNetwork?: boolean
  // Default ['https'].
  protocols?: ('https' | 'http')[]
  // Default [443] (and 80 once 'http' is allowed).
  ports?: number[]
  // Default ['GET', 'HEAD'].
  methods?: string[]
  // Default 3.
  maxRedirects?: number
  // Cap on the (decompressed) body, in bytes. Default 2_000_000.
  maxResponseBytes?: number
  // Whole request, headers and body. Default 15_000.
  timeoutMs?: number
  // Resolver; default the system's (dns.lookup, all addresses). The seam for tests and for a
  // resolver of your own (DoH, split-horizon).
  lookup?: (hostname: string) => Promise<IResolvedAddress[]>
}

export interface IResolvedEgressPolicy {
  allow: string[]
  deny: string[]
  allowPrivateNetwork: boolean
  protocols: ('https' | 'http')[]
  ports: number[]
  methods: string[]
  maxRedirects: number
  maxResponseBytes: number
  timeoutMs: number
  lookup: (hostname: string) => Promise<IResolvedAddress[]>
}

export const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000

const systemLookup = async (hostname: string): Promise<IResolvedAddress[]> => {
  const all = await dnsLookup(hostname, { all: true, verbatim: true })
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }))
}

export const resolveEgressPolicy = (policy: IEgressPolicy = {}): IResolvedEgressPolicy => {
  const protocols = policy.protocols?.length ? [...new Set(policy.protocols)] : ['https' as const]
  const ports = policy.ports?.length
    ? [...new Set(policy.ports)]
    : protocols.includes('http')
      ? [443, 80]
      : [443]
  return {
    allow: (policy.allow ?? []).map(normalizePattern).filter(Boolean),
    deny: (policy.deny ?? []).map(normalizePattern).filter(Boolean),
    allowPrivateNetwork: policy.allowPrivateNetwork === true,
    protocols,
    ports,
    methods: (policy.methods?.length ? policy.methods : ['GET', 'HEAD']).map((m) =>
      m.toUpperCase(),
    ),
    maxRedirects: Math.max(0, policy.maxRedirects ?? 3),
    maxResponseBytes: Math.max(1, policy.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES),
    timeoutMs: Math.max(1, policy.timeoutMs ?? 15_000),
    lookup: policy.lookup ?? systemLookup,
  }
}

// ── addresses ────────────────────────────────────────────────────────────────

type Bytes = number[]

const parseV4 = (s: string): Bytes | undefined => {
  const parts = s.split('.')
  if (parts.length !== 4) {
    return undefined
  }
  const out: Bytes = []
  for (const p of parts) {
    // Canonical only: "010" may mean 8 to some parsers and 10 to others.
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) {
      return undefined
    }
    const n = Number(p)
    if (n > 255) {
      return undefined
    }
    out.push(n)
  }
  return out
}

const parseV6 = (s: string): Bytes | undefined => {
  if (isIP(s) !== 6 || s.includes('%')) {
    return undefined
  }
  let tail: Bytes = []
  let text = s
  const lastColon = text.lastIndexOf(':')
  if (text.slice(lastColon + 1).includes('.')) {
    const v4 = parseV4(text.slice(lastColon + 1))
    if (!v4) {
      return undefined
    }
    tail = v4
    text = `${text.slice(0, lastColon + 1)}0:0`
  }
  const [head, rest] = text.split('::')
  const toGroups = (part: string | undefined): number[] =>
    part ? part.split(':').map((g) => parseInt(g, 16)) : []
  const a = toGroups(head)
  const b = rest === undefined ? [] : toGroups(rest)
  const missing = 8 - a.length - b.length
  if (rest === undefined ? a.length !== 8 : missing < 0) {
    return undefined
  }
  const groups = rest === undefined ? a : [...a, ...Array<number>(missing).fill(0), ...b]
  const out: Bytes = []
  for (const g of groups) {
    out.push((g >> 8) & 0xff, g & 0xff)
  }
  if (tail.length) {
    out.splice(12, 4, ...tail)
  }
  return out.length === 16 ? out : undefined
}

export const parseIp = (s: string): { family: 4 | 6; bytes: Bytes } | undefined => {
  const v4 = parseV4(s)
  if (v4) {
    return { family: 4, bytes: v4 }
  }
  const v6 = parseV6(s)
  return v6 ? { family: 6, bytes: v6 } : undefined
}

const inRange = (bytes: Bytes, base: Bytes, bits: number): boolean => {
  for (let i = 0; i < base.length && bits > 0; i += 1, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff
    if ((bytes[i] & mask) !== (base[i] & mask)) {
      return false
    }
  }
  return true
}

const v4Range = (cidr: string): [Bytes, number] => {
  const [ip, bits] = cidr.split('/')
  return [parseV4(ip) as Bytes, Number(bits ?? 32)]
}
const v6Range = (cidr: string): [Bytes, number] => {
  const [ip, bits] = cidr.split('/')
  return [parseV6(ip) as Bytes, Number(bits ?? 128)]
}

// Refused whatever the policy says: never a legitimate destination for a model's request.
const NEVER_V4 = [
  '0.0.0.0/8', // "this network"
  '100.100.100.200/32', // Alibaba Cloud metadata
  '169.254.169.254/32', // AWS / GCP / Azure / OpenStack metadata
  '192.0.0.0/24', // IETF protocol assignments (192.0.0.192 is Oracle metadata)
  '192.0.2.0/24', // documentation
  '192.88.99.0/24', // 6to4 relay anycast
  '198.51.100.0/24', // documentation
  '203.0.113.0/24', // documentation
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved + broadcast
].map(v4Range)
// Refused unless private networks are allowed.
const PRIVATE_V4 = [
  '10.0.0.0/8',
  '100.64.0.0/10', // carrier-grade NAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local
  '172.16.0.0/12',
  '192.168.0.0/16',
  '198.18.0.0/15', // benchmarking
].map(v4Range)
const NEVER_V6 = [
  '::/128', // unspecified
  '100::/64', // discard-only
  '2001:db8::/32', // documentation
  'fd00:ec2::254/128', // AWS IPv6 metadata
  'ff00::/8', // multicast
  '64:ff9b:1::/48', // local-use NAT64
].map(v6Range)
const PRIVATE_V6 = [
  '::1/128', // loopback
  'fc00::/7', // unique local
  'fe80::/10', // link-local
  'fec0::/10', // site-local (deprecated)
].map(v6Range)
const GLOBAL_V6 = v6Range('2000::/3')
const TEREDO = v6Range('2001::/32')

export type AddressClass = 'public' | 'private' | 'never'

// Judge one address. IPv4 hidden in IPv6 is judged as that IPv4 - a mapped 127.0.0.1 is still
// loopback.
export const classifyAddress = (address: string): AddressClass => {
  const ip = parseIp(address)
  if (!ip) {
    return 'never'
  }
  if (ip.family === 4) {
    if (NEVER_V4.some(([b, n]) => inRange(ip.bytes, b, n))) {
      return 'never'
    }
    return PRIVATE_V4.some(([b, n]) => inRange(ip.bytes, b, n)) ? 'private' : 'public'
  }
  const b = ip.bytes
  const embedded = (offset: number): AddressClass =>
    classifyAddress(b.slice(offset, offset + 4).join('.'))
  // "::" is unspecified and "::1" loopback - not IPv4-compatible addresses.
  if (b.slice(0, 15).every((x) => x === 0) && b[15] <= 1) {
    return b[15] === 1 ? 'private' : 'never'
  }
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible)
  if (inRange(b, v6Range('::ffff:0:0/96')[0], 96) || inRange(b, v6Range('::/96')[0], 96)) {
    return embedded(12)
  }
  // 64:ff9b::/96 (NAT64): the gateway reaches the embedded IPv4.
  if (inRange(b, v6Range('64:ff9b::/96')[0], 96)) {
    return embedded(12)
  }
  // 2002::/16 (6to4): the IPv4 is bytes 2..5.
  if (b[0] === 0x20 && b[1] === 0x02) {
    return embedded(2)
  }
  if (inRange(b, TEREDO[0], TEREDO[1])) {
    return 'never' // tunnels with an obfuscated IPv4 inside
  }
  if (NEVER_V6.some(([base, n]) => inRange(b, base, n))) {
    return 'never'
  }
  if (PRIVATE_V6.some(([base, n]) => inRange(b, base, n))) {
    return 'private'
  }
  // Only global unicast is a destination; anything else is unassigned or special.
  return inRange(b, GLOBAL_V6[0], GLOBAL_V6[1]) ? 'public' : 'never'
}

// ── patterns ─────────────────────────────────────────────────────────────────

const stripDot = (host: string): string => host.replace(/\.+$/, '')

export const normalizeHost = (host: string): string =>
  stripDot(
    host
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, ''),
  )

const normalizePattern = (p: string): string => {
  const s = p.trim().toLowerCase()
  return s.startsWith('*.') ? `*.${normalizeHost(s.slice(2))}` : normalizeHost(s)
}

const isAddressPattern = (p: string): boolean =>
  p.includes('/') || Boolean(parseIp(p.replace(/\/\d+$/, '')))

const addressMatches = (address: string, pattern: string): boolean => {
  const [base, bits] = pattern.split('/')
  const ip = parseIp(address)
  const range = parseIp(base)
  if (!ip || !range || ip.family !== range.family) {
    return false
  }
  return inRange(
    ip.bytes,
    range.bytes,
    bits === undefined ? (range.family === 4 ? 32 : 128) : Number(bits),
  )
}

// Does `host` (a name or an IP literal) match `pattern`?
export const hostMatches = (host: string, pattern: string): boolean => {
  const h = normalizeHost(host)
  const p = normalizePattern(pattern)
  if (isAddressPattern(p)) {
    return parseIp(h) !== undefined && addressMatches(h, p)
  }
  if (p.startsWith('*.')) {
    const apex = p.slice(2)
    return h.length > apex.length + 1 && h.endsWith(`.${apex}`)
  }
  return h === p
}

// ── checks ───────────────────────────────────────────────────────────────────

const assertAddress = (address: string, policy: IResolvedEgressPolicy, host: string): void => {
  const klass = classifyAddress(address)
  if (klass === 'never' || (klass === 'private' && !policy.allowPrivateNetwork)) {
    throw new EgressError(
      'denied-address',
      `egress denied: ${host} is, or resolves to, a non-public address (${klass === 'never' ? 'reserved or metadata range' : 'private network'})`,
    )
  }
  for (const p of policy.deny) {
    if (isAddressPattern(p) && addressMatches(address, p)) {
      throw new EgressError('denied-address', `egress denied: ${host} resolves to a denied address`)
    }
  }
}

// Everything decidable from the URL alone. Resolved addresses are judged by the lookup, at connect.
export const checkEgressUrl = (url: URL, policy: IResolvedEgressPolicy, method = 'GET'): void => {
  if (!policy.methods.includes(method.toUpperCase())) {
    throw new EgressError('bad-method', `egress denied: method ${method} is not allowed`)
  }
  const protocol = url.protocol.replace(':', '')
  if (protocol !== 'https' && protocol !== 'http') {
    throw new EgressError('bad-protocol', `egress denied: only http(s) URLs, not ${url.protocol}`)
  }
  if (!policy.protocols.includes(protocol)) {
    throw new EgressError(
      'bad-protocol',
      `egress denied: ${protocol} is not allowed (allowed: ${policy.protocols.join(', ')})`,
    )
  }
  if (url.username || url.password) {
    throw new EgressError(
      'credentials-in-url',
      'egress denied: credentials inside a URL are not allowed',
    )
  }
  const port = Number(url.port || (protocol === 'https' ? 443 : 80))
  if (!policy.ports.includes(port)) {
    throw new EgressError(
      'bad-port',
      `egress denied: port ${port} is not allowed (allowed: ${policy.ports.join(', ')})`,
    )
  }
  const host = normalizeHost(url.hostname)
  if (!host) {
    throw new EgressError('bad-url', 'egress denied: the URL has no host')
  }
  for (const p of policy.deny) {
    if (hostMatches(host, p)) {
      throw new EgressError('denied-host', `egress denied: ${host} is on the deny list`)
    }
  }
  if (policy.allow.length > 0 && !policy.allow.some((p) => hostMatches(host, p))) {
    throw new EgressError('not-allowed-host', `egress denied: ${host} is not on the allow list`)
  }
  // An IP literal never reaches the lookup, so it is judged here.
  if (parseIp(host)) {
    assertAddress(host, policy, host)
  } else if (isIP(host)) {
    throw new EgressError('bad-url', `egress denied: ${host} is not a canonical IP address`)
  }
}

// A redirect may move between hosts (each hop is checked again) but never from https to http.
export const checkRedirect = (from: URL, to: URL): void => {
  if (from.protocol === 'https:' && to.protocol === 'http:') {
    throw new EgressError(
      'bad-protocol',
      'egress denied: a redirect may not downgrade https to http',
    )
  }
}

// The lookup the socket connects with. See the header: validation and connect use the same answer.
const guardedLookup =
  (policy: IResolvedEgressPolicy) =>
  (
    hostname: string,
    options: unknown,
    callback: (err: Error | null, address: string | IResolvedAddress[], family?: number) => void,
  ): void => {
    void (async () => {
      try {
        const host = normalizeHost(hostname)
        const found = await policy.lookup(host)
        if (found.length === 0) {
          throw new EgressError('dns', `egress failed: ${host} did not resolve`)
        }
        // Fail closed: one bad address condemns the name.
        for (const a of found) {
          assertAddress(a.address, policy, host)
        }
        const opts = (typeof options === 'object' && options ? options : {}) as {
          all?: boolean
          family?: number
        }
        const want = typeof options === 'number' ? options : opts.family
        const list = want === 4 || want === 6 ? found.filter((a) => a.family === want) : found
        if (list.length === 0) {
          throw new EgressError('dns', `egress failed: ${host} has no IPv${want} address`)
        }
        if (opts.all) {
          callback(null, list)
        } else {
          callback(null, list[0].address, list[0].family)
        }
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)), '', 0)
      }
    })()
  }

// ── the request ──────────────────────────────────────────────────────────────

const REDIRECT = new Set([301, 302, 303, 307, 308])
const HOP_BY_HOP = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const CROSS_ORIGIN_STRIP = ['authorization', 'cookie', 'proxy-authorization']

const headersOf = (
  init: ConstructorParameters<typeof Headers>[0] | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {}
  new Headers(init).forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      out[key.toLowerCase()] = value
    }
  })
  return out
}

const decoderFor = (res: IncomingMessage): NodeJS.ReadableStream => {
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase()
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    return res.pipe(zlib.createGunzip())
  }
  if (encoding === 'deflate') {
    return res.pipe(zlib.createInflate())
  }
  if (encoding === 'br') {
    return res.pipe(zlib.createBrotliDecompress())
  }
  return res
}

// Counts what comes out (after decompression) and fails past the cap.
const capped = (max: number): Transform => {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length
      if (seen > max) {
        done(
          new EgressError('too-large', `egress failed: the response is larger than ${max} bytes`),
        )
        return
      }
      done(null, chunk)
    },
  })
}

const sendOnce = (
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Uint8Array | undefined,
  signal: AbortSignal,
  policy: IResolvedEgressPolicy,
): Promise<IncomingMessage> =>
  new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:'
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const req = (secure ? https : http).request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: { 'accept-encoding': 'identity', ...headers },
        // A new connection per request: nothing is reused across a policy decision.
        agent: false,
        lookup: guardedLookup(policy) as never,
        ...(secure && !isIP(hostname) ? { servername: hostname } : {}),
        signal,
      },
      resolve,
    )
    req.on('error', reject)
    req.end(body ? Buffer.from(body) : undefined)
  })

const toResponse = (
  res: IncomingMessage,
  method: string,
  url: URL,
  policy: IResolvedEgressPolicy,
): Response => {
  const status = res.statusCode ?? 502
  const headers = new Headers()
  for (const [key, value] of Object.entries(res.headers)) {
    // The body below is already decoded and of a different length.
    if (key === 'content-encoding' || key === 'content-length' || value === undefined) {
      continue
    }
    for (const v of Array.isArray(value) ? value : [value]) {
      headers.append(key, v)
    }
  }
  const declared = Number(res.headers['content-length'])
  if (
    Number.isFinite(declared) &&
    declared > policy.maxResponseBytes &&
    !res.headers['content-encoding']
  ) {
    res.destroy()
    throw new EgressError(
      'too-large',
      `egress failed: the response is larger than ${policy.maxResponseBytes} bytes`,
    )
  }
  const noBody = method === 'HEAD' || status === 204 || status === 205 || status === 304
  let response: Response
  if (noBody) {
    res.resume()
    response = new Response(null, { status, statusText: res.statusMessage, headers })
  } else {
    const decoded = decoderFor(res)
    const stream = capped(policy.maxResponseBytes)
    // A failure anywhere in the chain (a broken connection, a corrupt gzip) reaches the reader
    // of the body instead of leaving it waiting.
    res.on('error', (err) => stream.destroy(err))
    decoded.on('error', (err) => stream.destroy(err))
    decoded.pipe(stream)
    response = new Response(Readable.toWeb(stream) as ReadableStream, {
      status,
      statusText: res.statusMessage,
      headers,
    })
  }
  Object.defineProperty(response, 'url', { value: url.href })
  return response
}

export type SafeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

// A `fetch` bound to a policy. Drop-in for places that take a `fetch` (an MCP transport's, say).
export const createSafeFetch = (policy: IEgressPolicy = {}): SafeFetch => {
  const p = resolveEgressPolicy(policy)
  return async (input, init = {}) => {
    let url: URL
    try {
      url = new URL(String(input))
    } catch {
      throw new EgressError(
        'bad-url',
        `egress denied: "${String(input).slice(0, 80)}" is not a URL`,
      )
    }
    let method = (init.method ?? 'GET').toUpperCase()
    let headers = headersOf(init.headers)
    let body: Uint8Array | undefined =
      typeof init.body === 'string'
        ? new TextEncoder().encode(init.body)
        : init.body instanceof Uint8Array
          ? init.body
          : undefined
    const timeout = AbortSignal.timeout(p.timeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    const mode = init.redirect ?? 'follow'

    for (let hop = 0; ; hop += 1) {
      checkEgressUrl(url, p, method)
      let res: IncomingMessage
      try {
        res = await sendOnce(url, method, headers, body, signal, p)
      } catch (err) {
        if (timeout.aborted && !init.signal?.aborted) {
          throw new EgressError(
            'timeout',
            `egress failed: no complete answer within ${p.timeoutMs} ms`,
          )
        }
        throw err
      }
      const location = res.headers.location
      if (REDIRECT.has(res.statusCode ?? 0) && location && mode !== 'manual') {
        res.destroy()
        if (mode === 'error') {
          throw new EgressError(
            'bad-redirect',
            'egress denied: the server redirected and redirects are off',
          )
        }
        if (hop >= p.maxRedirects) {
          throw new EgressError(
            'too-many-redirects',
            `egress failed: more than ${p.maxRedirects} redirects`,
          )
        }
        let next: URL
        try {
          next = new URL(location, url)
        } catch {
          throw new EgressError('bad-redirect', 'egress failed: the redirect target is not a URL')
        }
        checkRedirect(url, next)
        if (next.origin !== url.origin) {
          headers = Object.fromEntries(
            Object.entries(headers).filter(([k]) => !CROSS_ORIGIN_STRIP.includes(k)),
          )
        }
        const status = res.statusCode as number
        if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
          method = 'GET'
          body = undefined
        }
        url = next
        continue
      }
      return toResponse(res, method, url, p)
    }
  }
}
