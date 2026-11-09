import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import zlib from 'node:zlib'
import {
  checkEgressUrl,
  checkRedirect,
  classifyAddress,
  createSafeFetch,
  EgressError,
  hostMatches,
  resolveEgressPolicy,
  type IEgressPolicy,
} from '../src/index.ts'

// The egress guard is a security boundary, so it is tested like one: a table of addresses that
// must NEVER be reached, the checks in isolation, and then real requests over loopback sockets
// to prove what actually goes on the wire (and what does not).

// ── addresses ────────────────────────────────────────────────────────────────

test('classifyAddress: public addresses are public', () => {
  for (const ip of [
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '172.15.255.255', // just outside 172.16/12
    '172.32.0.0',
    '100.63.255.255', // just outside CGNAT
    '100.128.0.0',
    '169.253.1.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '2a00:1450:4001:81b::200e',
  ]) {
    assert.equal(classifyAddress(ip), 'public', ip)
  }
})

test('classifyAddress: private ranges are private (reachable only when the operator allows it)', () => {
  for (const ip of [
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '100.64.0.1', // CGNAT
    '100.127.255.255',
    '169.254.1.1', // link-local
    '198.18.0.1', // benchmarking
    '::1',
    'fc00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'fec0::1',
  ]) {
    assert.equal(classifyAddress(ip), 'private', ip)
  }
})

test('classifyAddress: metadata endpoints and never-routable ranges are NEVER reachable', () => {
  for (const ip of [
    '169.254.169.254', // AWS / GCP / Azure / OpenStack
    '100.100.100.200', // Alibaba
    '192.0.0.192', // Oracle
    'fd00:ec2::254', // AWS IPv6
    '0.0.0.0',
    '0.1.2.3',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '192.0.2.1',
    '198.51.100.7',
    '203.0.113.9',
    '::',
    'ff02::1',
    '2001:db8::1',
    '100::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
  ]) {
    assert.equal(classifyAddress(ip), 'never', ip)
  }
})

test('classifyAddress: IPv4 hidden inside IPv6 is judged as the IPv4 it is', () => {
  // Mapped, compatible, NAT64 and 6to4 all carry an IPv4 - loopback and metadata do not get a
  // free pass for being written in another notation.
  assert.equal(classifyAddress('::ffff:127.0.0.1'), 'private')
  assert.equal(classifyAddress('::ffff:7f00:1'), 'private')
  assert.equal(classifyAddress('::ffff:10.1.2.3'), 'private')
  assert.equal(classifyAddress('::ffff:169.254.169.254'), 'never')
  assert.equal(classifyAddress('::ffff:a9fe:a9fe'), 'never')
  assert.equal(classifyAddress('::ffff:8.8.8.8'), 'public')
  assert.equal(classifyAddress('::127.0.0.1'), 'private')
  assert.equal(classifyAddress('64:ff9b::7f00:1'), 'private')
  assert.equal(classifyAddress('64:ff9b::a9fe:a9fe'), 'never')
  assert.equal(classifyAddress('64:ff9b::808:808'), 'public')
  assert.equal(classifyAddress('2002:7f00:1::'), 'private') // 6to4 of 127.0.0.1
  assert.equal(classifyAddress('2002:a9fe:a9fe::1'), 'never') // 6to4 of the metadata address
  assert.equal(classifyAddress('2002:0808:0808::1'), 'public')
})

test('classifyAddress: what is not an address, or not global unicast, is refused', () => {
  for (const junk of [
    '',
    'localhost',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '01.2.3.4',
    '1.2.3.04',
    '::g',
    'fe80::1%eth0',
  ]) {
    assert.equal(classifyAddress(junk), 'never', JSON.stringify(junk))
  }
  assert.equal(classifyAddress('4000::1'), 'never', 'outside 2000::/3')
})

// ── host patterns ────────────────────────────────────────────────────────────

test('hostMatches: exact, subdomain wildcard, IP and CIDR - case and trailing dot ignored', () => {
  assert.equal(hostMatches('Example.COM', 'example.com'), true)
  assert.equal(hostMatches('example.com.', 'example.com'), true)
  assert.equal(hostMatches('www.example.com', 'example.com'), false, 'exact means exact')
  assert.equal(hostMatches('www.example.com', '*.example.com'), true)
  assert.equal(hostMatches('a.b.example.com', '*.example.com'), true, 'any depth')
  assert.equal(hostMatches('example.com', '*.example.com'), false, 'the apex is not a subdomain')
  assert.equal(
    hostMatches('evilexample.com', '*.example.com'),
    false,
    'a suffix is not a subdomain',
  )
  assert.equal(hostMatches('example.com.evil.net', 'example.com'), false)
  assert.equal(hostMatches('203.0.113.7', '203.0.113.7'), true)
  assert.equal(hostMatches('203.0.113.8', '203.0.113.7'), false)
  assert.equal(hostMatches('198.51.100.200', '198.51.100.0/24'), true)
  assert.equal(hostMatches('198.51.101.1', '198.51.100.0/24'), false)
  assert.equal(hostMatches('example.com', '198.51.100.0/24'), false, 'a name is not an address')
  assert.equal(hostMatches('::1', '::1'), true)
  assert.equal(hostMatches('[::1]', '::1'), true)
})

// ── the URL checks ───────────────────────────────────────────────────────────

const refuses = (url: string, policy: IEgressPolicy, code: string, method = 'GET') => {
  assert.throws(
    () => checkEgressUrl(new URL(url), resolveEgressPolicy(policy), method),
    (err: unknown) => err instanceof EgressError && err.code === code,
    `${method} ${url} -> ${code}`,
  )
}
const accepts = (url: string, policy: IEgressPolicy, method = 'GET') =>
  assert.doesNotThrow(() => checkEgressUrl(new URL(url), resolveEgressPolicy(policy), method), url)

test('checkEgressUrl: https only, no credentials, standard port, GET/HEAD - unless widened', () => {
  accepts('https://example.com/a?b=1', {})
  refuses('http://example.com/', {}, 'bad-protocol')
  refuses('ftp://example.com/', {}, 'bad-protocol')
  refuses('file:///etc/passwd', {}, 'bad-protocol')
  refuses('gopher://example.com/', {}, 'bad-protocol')
  refuses('https://user:pw@example.com/', {}, 'credentials-in-url')
  refuses('https://user@example.com/', {}, 'credentials-in-url')
  refuses('https://example.com:8443/', {}, 'bad-port')
  refuses('https://example.com/', {}, 'bad-method', 'POST')
  accepts('https://example.com/', {}, 'HEAD')

  accepts('http://example.com/', { protocols: ['https', 'http'] })
  accepts('http://example.com:80/', { protocols: ['http'] })
  accepts('https://example.com:8443/', { ports: [8443] })
  refuses('https://example.com/', { ports: [8443] }, 'bad-port')
  accepts('https://example.com/', { methods: ['POST'] }, 'POST')
})

test('checkEgressUrl: deny beats allow; an allow list is exclusive; IP literals are judged', () => {
  accepts('https://docs.example.com/', { allow: ['*.example.com'] })
  refuses('https://example.org/', { allow: ['*.example.com'] }, 'not-allowed-host')
  refuses('https://example.com/', { allow: ['*.example.com'] }, 'not-allowed-host')
  refuses(
    'https://docs.example.com/',
    { allow: ['*.example.com'], deny: ['docs.example.com'] },
    'denied-host',
  )
  refuses('https://x.example.com/', { deny: ['*.example.com'] }, 'denied-host')

  // An IP literal never reaches DNS, so the URL check is where it is stopped.
  refuses('https://127.0.0.1/', {}, 'denied-address')
  refuses('https://[::1]/', {}, 'denied-address')
  refuses('https://169.254.169.254/latest/meta-data/', {}, 'denied-address')
  refuses('https://[::ffff:169.254.169.254]/', {}, 'denied-address')
  refuses('https://10.1.2.3/', {}, 'denied-address')
  // The URL parser normalizes the tricks people try: decimal, hex and octal IPv4.
  refuses('https://2130706433/', {}, 'denied-address')
  refuses('https://0x7f.0.0.1/', {}, 'denied-address')
  refuses('https://0177.0.0.1/', {}, 'denied-address')
  refuses('https://127.1/', {}, 'denied-address')
  // Private networks opt-in; the never-routable still no.
  accepts('https://10.1.2.3/', { allowPrivateNetwork: true })
  accepts('https://127.0.0.1/', { allowPrivateNetwork: true })
  refuses('https://169.254.169.254/', { allowPrivateNetwork: true }, 'denied-address')
  refuses('https://[fd00:ec2::254]/', { allowPrivateNetwork: true }, 'denied-address')
  // An IP / CIDR on the deny list holds even when private networks are open.
  refuses('https://10.1.2.3/', { allowPrivateNetwork: true, deny: ['10.0.0.0/8'] }, 'denied-host')
  accepts('https://10.1.2.3/', { allowPrivateNetwork: true, allow: ['10.0.0.0/8'] })
  refuses(
    'https://10.1.2.3/',
    { allowPrivateNetwork: true, allow: ['192.168.0.0/16'] },
    'not-allowed-host',
  )
})

test('checkRedirect: never from https to http', () => {
  assert.throws(
    () => checkRedirect(new URL('https://a.example/'), new URL('http://a.example/')),
    (err: unknown) => err instanceof EgressError && err.code === 'bad-protocol',
  )
  assert.doesNotThrow(() =>
    checkRedirect(new URL('http://a.example/'), new URL('https://a.example/')),
  )
  assert.doesNotThrow(() =>
    checkRedirect(new URL('https://a.example/'), new URL('https://b.example/')),
  )
})

// ── real requests over loopback ──────────────────────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse) => void
interface ILocal {
  port: number
  hits: { url: string; headers: IncomingMessage['headers'] }[]
  close: () => Promise<void>
}
const serve = async (handler: Handler): Promise<ILocal> => {
  const hits: ILocal['hits'] = []
  const server: Server = createServer((req, res) => {
    hits.push({ url: req.url ?? '', headers: req.headers })
    handler(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
// Names that resolve to loopback, with no real DNS involved.
const loopbackNames =
  (...names: string[]) =>
  async (host: string) => {
    if (names.includes(host)) {
      return [{ address: '127.0.0.1', family: 4 as const }]
    }
    throw new Error(`unexpected lookup of ${host}`)
  }
// A policy for exercising the mechanics against the local server (the defaults would, rightly,
// refuse loopback).
const local = (port: number, extra: IEgressPolicy = {}): IEgressPolicy => ({
  allowPrivateNetwork: true,
  protocols: ['http'],
  ports: [port],
  lookup: loopbackNames('app.test', 'other.test'),
  ...extra,
})
const code = (c: string) => (err: unknown) => err instanceof EgressError && err.code === c

test('safe fetch: by default a request to localhost never leaves the process', async () => {
  const srv = await serve((_q, res) => res.end('secret'))
  try {
    const f = createSafeFetch({
      protocols: ['http'],
      ports: [srv.port],
      lookup: loopbackNames('app.test'),
    })
    // By name (resolves to loopback) and by literal - both refused, the server saw nothing.
    await assert.rejects(f(`http://app.test:${srv.port}/`), code('denied-address'))
    await assert.rejects(f(`http://127.0.0.1:${srv.port}/`), code('denied-address'))
    await assert.rejects(f(`http://[::1]:${srv.port}/`), code('denied-address'))
    await assert.rejects(f(`http://[::ffff:127.0.0.1]:${srv.port}/`), code('denied-address'))
    assert.equal(srv.hits.length, 0, 'not a single byte reached the server')
  } finally {
    await srv.close()
  }
})

test('safe fetch: the answer DNS gave is the answer that is judged - a bad address condemns the name', async () => {
  let asked = 0
  const f = createSafeFetch({
    allowPrivateNetwork: true,
    lookup: async () => {
      asked += 1
      return [
        { address: '93.184.216.34', family: 4 }, // fine
        { address: '169.254.169.254', family: 4 }, // metadata, hiding in the answer
      ]
    },
  })
  await assert.rejects(f('https://innocent.example/'), code('denied-address'))
  assert.equal(asked, 1, 'one lookup, used both to judge and to connect')

  // Private is allowed here, metadata is not - even alone, even by a name.
  const g = createSafeFetch({
    allowPrivateNetwork: true,
    lookup: async () => [{ address: '169.254.169.254', family: 4 }],
  })
  await assert.rejects(g('https://innocent.example/'), code('denied-address'))
  // A name that does not resolve is a plain failure, not a pass.
  const h = createSafeFetch({ lookup: async () => [] })
  await assert.rejects(h('https://nowhere.example/'), code('dns'))
})

test('safe fetch: a NAME that resolves into a denied range is refused, whatever the name says', async () => {
  const f = createSafeFetch({
    deny: ['93.184.216.0/24', '2606:4700::/32'],
    lookup: async (host) =>
      host === 'v6.example'
        ? [{ address: '2606:4700:4700::1111', family: 6 }]
        : [{ address: '93.184.216.34', family: 4 }],
  })
  await assert.rejects(f('https://friendly.example/'), code('denied-address'))
  await assert.rejects(f('https://v6.example/'), code('denied-address'))
})

test('safe fetch: connects to the validated address and keeps the name (Host), over a real socket', async () => {
  const srv = await serve((_q, res) => res.end('hello from the server'))
  try {
    const f = createSafeFetch(local(srv.port))
    const res = await f(`http://app.test:${srv.port}/page?q=1`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'hello from the server')
    assert.equal(res.url, `http://app.test:${srv.port}/page?q=1`)
    assert.equal(srv.hits[0].url, '/page?q=1')
    assert.equal(srv.hits[0].headers.host, `app.test:${srv.port}`)
    assert.equal(srv.hits[0].headers['accept-encoding'], 'identity')
  } finally {
    await srv.close()
  }
})

test('safe fetch: HEAD, 204, 304 and error statuses come back as they are', async () => {
  const srv = await serve((req, res) => {
    if (req.url === '/empty') return void res.writeHead(204).end()
    if (req.url === '/same') return void res.writeHead(304).end()
    if (req.url === '/gone')
      return void res.writeHead(404, { 'content-type': 'text/plain' }).end('no such page')
    res.writeHead(200, { 'content-type': 'text/plain', 'x-thing': 'yes' }).end('body')
  })
  try {
    const f = createSafeFetch(local(srv.port))
    const base = `http://app.test:${srv.port}`
    assert.equal((await f(`${base}/empty`)).status, 204)
    assert.equal((await f(`${base}/same`)).status, 304)
    const gone = await f(`${base}/gone`)
    assert.deepEqual([gone.status, gone.ok, await gone.text()], [404, false, 'no such page'])
    const head = await f(`${base}/`, { method: 'HEAD' })
    assert.deepEqual(
      [head.status, head.headers.get('x-thing'), await head.text()],
      [200, 'yes', ''],
    )
    await assert.rejects(f(`${base}/`, { method: 'POST', body: 'x' }), code('bad-method'))
  } finally {
    await srv.close()
  }
})

test('safe fetch: redirects are followed - and every hop is judged again', async () => {
  const srv = await serve((req, res) => {
    const to = (location: string) => void res.writeHead(302, { location }).end()
    switch (req.url) {
      case '/a':
        return to('/b')
      case '/b':
        return void res.end('landed')
      case '/to-denied-ip':
        return to(`http://127.0.0.2:${srv.port}/`)
      case '/to-other-name':
        return to(`http://other.test:${srv.port}/b`)
      case '/loop':
        return to('/loop')
      case '/relative-chain':
        return to('a')
      default:
        return void res.end('?')
    }
  })
  try {
    const base = `http://app.test:${srv.port}`
    const f = createSafeFetch(local(srv.port))
    const ok = await f(`${base}/a`)
    assert.equal(await ok.text(), 'landed')
    assert.equal(ok.url, `${base}/b`, 'the final URL, not the first')

    // A hop to an address on the deny list, a name outside the allow list, too many hops.
    const deny = createSafeFetch(local(srv.port, { deny: ['127.0.0.2'] }))
    await assert.rejects(deny(`${base}/to-denied-ip`), code('denied-host'))
    const allow = createSafeFetch(local(srv.port, { allow: ['app.test'] }))
    await assert.rejects(allow(`${base}/to-other-name`), code('not-allowed-host'))
    await assert.rejects(f(`${base}/loop`), code('too-many-redirects'))
    const none = createSafeFetch(local(srv.port, { maxRedirects: 0 }))
    await assert.rejects(none(`${base}/a`), code('too-many-redirects'))
    // redirect: 'manual' hands the 3xx back untouched; 'error' refuses it.
    const manual = await f(`${base}/a`, { redirect: 'manual' })
    assert.deepEqual([manual.status, manual.headers.get('location')], [302, '/b'])
    await assert.rejects(f(`${base}/a`, { redirect: 'error' }), code('bad-redirect'))
    // A relative Location resolves against the current URL.
    assert.equal((await f(`${base}/relative-chain`)).url, `${base}/b`)
  } finally {
    await srv.close()
  }
})

test('safe fetch: credentials do not follow a redirect to another origin', async () => {
  const srv = await serve((req, res) => {
    if (req.url === '/cross')
      return void res.writeHead(302, { location: `http://other.test:${srv.port}/echo` }).end()
    if (req.url === '/same') return void res.writeHead(302, { location: '/echo' }).end()
    res.end('ok')
  })
  try {
    const f = createSafeFetch(local(srv.port))
    const headers = { authorization: 'Bearer secret', cookie: 'sid=1', 'x-keep': 'yes' }
    await f(`http://app.test:${srv.port}/cross`, { headers })
    const crossed = srv.hits.at(-1)?.headers
    assert.equal(crossed?.authorization, undefined)
    assert.equal(crossed?.cookie, undefined)
    assert.equal(crossed?.['x-keep'], 'yes', 'only the credentials are dropped')

    srv.hits.length = 0
    await f(`http://app.test:${srv.port}/same`, { headers })
    assert.equal(srv.hits.at(-1)?.headers.authorization, 'Bearer secret', 'same origin keeps them')
  } finally {
    await srv.close()
  }
})

test('safe fetch: the size cap is enforced on what is read - declared, streamed and decompressed', async () => {
  const srv = await serve((req, res) => {
    if (req.url === '/declared') {
      res.writeHead(200, { 'content-length': '5000000' })
      return void res.end('x'.repeat(10))
    }
    if (req.url === '/streamed') {
      res.writeHead(200)
      const chunk = 'y'.repeat(10_000)
      let sent = 0
      const timer = setInterval(() => {
        res.write(chunk)
        sent += chunk.length
        if (sent >= 500_000) {
          clearInterval(timer)
          res.end()
        }
      }, 1)
      return
    }
    if (req.url === '/bomb') {
      // ~10 MB of zeros in a few KB.
      const gz = zlib.gzipSync(Buffer.alloc(10_000_000))
      res.writeHead(200, { 'content-encoding': 'gzip' })
      return void res.end(gz)
    }
    if (req.url === '/gz') {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' })
      return void res.end(zlib.gzipSync('squeezed text'))
    }
    if (req.url === '/corrupt') {
      res.writeHead(200, { 'content-encoding': 'gzip' })
      return void res.end(Buffer.from('this is not gzip at all'))
    }
    res.end('small')
  })
  try {
    const base = `http://app.test:${srv.port}`
    const f = createSafeFetch(local(srv.port, { maxResponseBytes: 100_000 }))
    await assert.rejects(f(`${base}/declared`), code('too-large'))
    const streamed = await f(`${base}/streamed`)
    await assert.rejects(streamed.arrayBuffer(), code('too-large'))
    const bomb = await f(`${base}/bomb`)
    await assert.rejects(bomb.arrayBuffer(), code('too-large'))
    // A normal compressed answer is decoded.
    assert.equal(await (await f(`${base}/gz`)).text(), 'squeezed text')
    // A corrupt stream fails the read - it does not hang it.
    const corrupt = await f(`${base}/corrupt`)
    await assert.rejects(corrupt.arrayBuffer())
    assert.equal(await (await f(`${base}/small`)).text(), 'small')
  } finally {
    await srv.close()
  }
})

test('safe fetch: a server that never answers is cut off at the timeout; the caller can abort too', async () => {
  const srv = await serve(() => {
    /* never answers */
  })
  try {
    const base = `http://app.test:${srv.port}`
    const f = createSafeFetch(local(srv.port, { timeoutMs: 200 }))
    const t0 = Date.now()
    await assert.rejects(f(`${base}/`), code('timeout'))
    assert.ok(Date.now() - t0 < 3000)

    const g = createSafeFetch(local(srv.port, { timeoutMs: 20_000 }))
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    await assert.rejects(
      g(`${base}/`, { signal: ac.signal }),
      (err: unknown) => !(err instanceof EgressError),
    )
  } finally {
    await srv.close()
  }
})

test('safe fetch: input that is not a plain http(s) URL is refused before anything happens', async () => {
  const f = createSafeFetch({ allowPrivateNetwork: true, protocols: ['http'], ports: [1] })
  await assert.rejects(f('not a url'), code('bad-url'))
  await assert.rejects(f('http://example.com:1@evil.example/'), code('credentials-in-url'))
  await assert.rejects(f('javascript:alert(1)'), code('bad-protocol'))
  await assert.rejects(f('data:text/plain,hi'), code('bad-protocol'))
})
