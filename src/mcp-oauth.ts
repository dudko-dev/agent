import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * OAuth 2.1 for remote MCP servers, from Node.
 *
 * The MCP SDK owns the protocol - discovery (RFC 9728), dynamic client
 * registration (RFC 7591), PKCE, the code exchange and the refresh on 401.
 * What it does not own, and what this module supplies, is WHERE the resulting
 * tokens live between processes and HOW an operator is asked to authorize.
 *
 * Pass the result to `mcpServers[name].authProvider`.
 */

/** Where a provider persists tokens, registration and the PKCE verifier. */
export interface IOAuthStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

const DEFAULT_STORE_PATH = path.join(os.homedir(), '.agent', 'mcp-oauth.json')

/**
 * A JSON file, written 0600 in a 0700 directory (tokens are bearer credentials:
 * anything that can read the file can act as the user). Writes are serialized
 * in-process; concurrent processes sharing one file is not supported - give
 * each its own `filePath`.
 */
export class FileOAuthStore implements IOAuthStore {
  private readonly filePath: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(filePath: string = DEFAULT_STORE_PATH) {
    this.filePath = filePath
  }

  private async readAll(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as Record<string, string>
    } catch {
      // Missing or corrupt: start clean rather than wedging every later call.
      return {}
    }
  }

  // Serialize read-modify-write so two saves in the same tick can't clobber
  // each other (saveTokens and saveClientInformation often land together).
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  async get(key: string): Promise<string | undefined> {
    return this.enqueue(async () => (await this.readAll())[key])
  }

  async set(key: string, value: string): Promise<void> {
    await this.enqueue(async () => {
      const all = await this.readAll()
      all[key] = value
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
      await writeFile(this.filePath, JSON.stringify(all, null, 2), { mode: 0o600 })
      // writeFile only applies `mode` when it creates the file; an existing
      // file keeps whatever permissions it had.
      await chmod(this.filePath, 0o600).catch(() => {})
    })
  }

  async delete(key: string): Promise<void> {
    await this.enqueue(async () => {
      const all = await this.readAll()
      if (!(key in all)) {
        return
      }
      delete all[key]
      await writeFile(this.filePath, JSON.stringify(all, null, 2), { mode: 0o600 })
      await chmod(this.filePath, 0o600).catch(() => {})
    })
  }
}

/** Non-persistent store: tokens die with the process. */
export class MemoryOAuthStore implements IOAuthStore {
  private readonly map = new Map<string, string>()

  async get(key: string): Promise<string | undefined> {
    return this.map.get(key)
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
}

export interface INodeOAuthProviderOptions {
  /** The MCP endpoint being authorized. */
  serverUrl: string
  /**
   * Where the authorization server sends the operator back. For a CLI this is
   * usually a loopback URL you listen on (`http://127.0.0.1:PORT/callback`);
   * whatever you pick is what gets registered, so it must match on return.
   */
  redirectUrl: string
  /** `client_name` submitted during dynamic registration. */
  clientName?: string
  /** Fallback scope when the server advertises none. */
  scope?: string
  /** Merged over the defaults (e.g. `software_id`, `contacts`). */
  clientMetadata?: Partial<OAuthClientMetadata>
  /** Defaults to a 0600 JSON file under ~/.agent. */
  store?: IOAuthStore
  /** Treat the access token as expired this many seconds early. Default 30. */
  expirySkewSeconds?: number
  /**
   * Invoked with the URL the operator must open. Nothing is printed or spawned
   * on your behalf - a library that writes to stdout breaks piped output, and
   * one that opens a browser surprises a server process.
   */
  onAuthorizationUrl?: (url: URL) => void | Promise<void>
}

interface IStoredTokens {
  tokens: OAuthTokens
  expiresAt?: number
}

const DEFAULT_SKEW_SECONDS = 30

const namespaceFor = (serverUrl: string): string => {
  const u = new URL(serverUrl)
  return `mcp-oauth:${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

/**
 * A persistent `OAuthClientProvider`. Also exposes `isAccessTokenExpired`,
 * which `connectMcpServers` uses to refresh a known-dead token before the
 * first request instead of paying for a guaranteed 401.
 */
export class NodeOAuthProvider implements OAuthClientProvider {
  /** Set when an interactive authorization is required. */
  authorizationUrl?: URL

  readonly serverUrl: string

  private readonly store: IOAuthStore
  private readonly ns: string
  private readonly _redirectUrl: string
  private readonly _clientMetadata: OAuthClientMetadata
  private readonly skewMs: number
  private readonly onAuthorizationUrl?: (url: URL) => void | Promise<void>

  constructor(opts: INodeOAuthProviderOptions) {
    this.serverUrl = opts.serverUrl
    this.store = opts.store ?? new FileOAuthStore()
    this.ns = namespaceFor(opts.serverUrl)
    this._redirectUrl = opts.redirectUrl
    this.skewMs = (opts.expirySkewSeconds ?? DEFAULT_SKEW_SECONDS) * 1000
    this.onAuthorizationUrl = opts.onAuthorizationUrl
    this._clientMetadata = {
      client_name: opts.clientName ?? 'agent',
      redirect_uris: [this._redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Public client. A CLI cannot keep a client_secret secret; PKCE is what
      // protects the exchange.
      token_endpoint_auth_method: 'none',
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...opts.clientMetadata,
    } as OAuthClientMetadata

    if (
      !/^https:/.test(opts.serverUrl) &&
      !/^http:\/\/(localhost|127\.0\.0\.1)/.test(opts.serverUrl)
    ) {
      throw new Error(
        `MCP OAuth requires https (or a loopback host) - refusing to send tokens to "${opts.serverUrl}"`,
      )
    }
  }

  get redirectUrl(): string {
    return this._redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return this._clientMetadata
  }

  private key(suffix: string): string {
    return `${this.ns}:${suffix}`
  }

  private async readJSON<T>(suffix: string): Promise<T | undefined> {
    const raw = await this.store.get(this.key(suffix))
    if (raw === undefined) {
      return undefined
    }
    try {
      return JSON.parse(raw) as T
    } catch {
      await this.store.delete(this.key(suffix))
      return undefined
    }
  }

  async state(): Promise<string> {
    const value = randomBytes(32).toString('hex')
    await this.store.set(this.key('state'), value)
    return value
  }

  /** Single-use CSRF check for the value that comes back on the redirect. */
  async verifyState(returned: string | undefined): Promise<boolean> {
    const expected = await this.store.get(this.key('state'))
    await this.store.delete(this.key('state'))
    return expected !== undefined && returned !== undefined && expected === returned
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.readJSON<OAuthClientInformationMixed>('client')
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.store.set(this.key('client'), JSON.stringify(info))
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.readJSON<IStoredTokens>('tokens'))?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const stored: IStoredTokens = {
      tokens,
      expiresAt:
        typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : undefined,
    }
    await this.store.set(this.key('tokens'), JSON.stringify(stored))
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.store.set(this.key('verifier'), verifier)
  }

  async codeVerifier(): Promise<string> {
    const v = await this.store.get(this.key('verifier'))
    if (!v) {
      throw new Error(
        'No PKCE code verifier stored: the authorization was started by another process, or the store was cleared mid-flow',
      )
    }
    return v
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.authorizationUrl = url
    await this.onAuthorizationUrl?.(url)
  }

  /**
   * Called by the SDK when the server rejects what we hold: `'tokens'` on an
   * `invalid_grant` (dead refresh token), `'client'` / `'all'` on an
   * `invalid_client` (the AS forgot our dynamic registration).
   */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    const targets = scope === 'all' ? ['tokens', 'client', 'verifier', 'state'] : [scope]
    await Promise.all(targets.map((t) => this.store.delete(this.key(t))))
  }

  /** True when there is no access token, or it expires within the skew window. */
  async isAccessTokenExpired(): Promise<boolean> {
    const stored = await this.readJSON<IStoredTokens>('tokens')
    if (!stored?.tokens?.access_token) {
      return true
    }
    if (stored.expiresAt === undefined) {
      return false
    }
    return Date.now() + this.skewMs >= stored.expiresAt
  }

  async isAuthorized(): Promise<boolean> {
    return (await this.tokens()) !== undefined
  }

  /** Forget tokens, registration, verifier and state for this server. */
  async reset(): Promise<void> {
    this.authorizationUrl = undefined
    await this.invalidateCredentials('all')
  }
}

/** Convenience factory mirroring the rest of the package's `createX` style. */
export const createNodeOAuthProvider = (opts: INodeOAuthProviderOptions): NodeOAuthProvider =>
  new NodeOAuthProvider(opts)

export interface IOAuthRequestOptions {
  /** Custom fetch for discovery / registration / token requests. */
  fetch?: FetchLike
}

/**
 * Start (or silently renew) an authorization. `'AUTHORIZED'` means a usable
 * token is in hand - possibly obtained by exchanging a refresh token without
 * bothering anyone. `'REDIRECT'` means the operator must visit
 * `provider.authorizationUrl` and the code has to come back through
 * {@link finishMcpOAuth}.
 */
export const beginMcpOAuth = async (
  provider: NodeOAuthProvider,
  opts: IOAuthRequestOptions = {},
): Promise<'AUTHORIZED' | 'REDIRECT'> => {
  provider.authorizationUrl = undefined
  return auth(provider, { serverUrl: provider.serverUrl, fetchFn: opts.fetch })
}

/**
 * Complete the flow with the `code` (and `state`) the authorization server sent
 * back. Verifies `state`, exchanges the code with the stored PKCE verifier and
 * persists the tokens. Throws unless the exchange fully succeeded.
 */
export const finishMcpOAuth = async (
  provider: NodeOAuthProvider,
  callback: { code: string; state?: string },
  opts: IOAuthRequestOptions = {},
): Promise<void> => {
  if (!(await provider.verifyState(callback.state))) {
    throw new Error('Authorization state mismatch; refusing to exchange the code (possible CSRF)')
  }
  const result = await auth(provider, {
    serverUrl: provider.serverUrl,
    authorizationCode: callback.code,
    fetchFn: opts.fetch,
  })
  if (result !== 'AUTHORIZED') {
    throw new Error(`Token exchange did not complete (SDK returned "${result}")`)
  }
}
