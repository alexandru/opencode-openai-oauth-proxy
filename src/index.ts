import type { Hooks, PluginInput, PluginOptions, AuthOAuthResult } from "@opencode-ai/plugin"
import { createServer } from "http"
import { setTimeout as sleep } from "node:timers/promises"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProxyOptions {
  routeMap?: Record<string, string>
}

interface PkceCodes {
  verifier: string
  challenge: string
}

interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

interface IdTokenClaims {
  chatgpt_account_id?: string
  organizations?: Array<{ id: string }>
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
  }
}

interface PendingOAuth {
  pkce: PkceCodes
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const DEFAULT_ISSUER = "https://auth.openai.com"
const DEFAULT_CODEX_API = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_PORT = 1455
const OAUTH_POLLING_SAFETY_MS = 3000
const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

// ---------------------------------------------------------------------------
// Module-level state (mirrors built-in Codex plugin)
// ---------------------------------------------------------------------------

let oauthServer: ReturnType<typeof createServer> | undefined
let pendingOAuth: PendingOAuth | undefined

// ---------------------------------------------------------------------------
// URL rewriting
// ---------------------------------------------------------------------------

function resolveUrl(url: string, routeMap: Record<string, string>): string {
  for (const [source, target] of Object.entries(routeMap)) {
    if (url.startsWith(source)) return target + url.slice(source.length)
    // Handle trailing slash mismatch: source has "/" but url doesn't
    const sourceClean = source.endsWith("/") ? source.slice(0, -1) : source
    if (sourceClean.length < source.length && url === sourceClean) {
      return target.endsWith("/") ? target.slice(0, -1) : target
    }
  }
  return url
}

function resolveIssuer(routeMap: Record<string, string>): string {
  return resolveUrl(DEFAULT_ISSUER, routeMap)
}

function resolveCodexApi(routeMap: Record<string, string>): string {
  return resolveUrl(DEFAULT_CODEX_API + "/", routeMap).replace(/\/$/, "")
}

function log(label: string, ...args: unknown[]) {
  console.log(`[openai-oauth-proxy] ${label}`, ...args)
}

function pluginActive(routeMap: Record<string, string>): boolean {
  return Object.keys(routeMap).length > 0
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

async function generatePKCE(): Promise<PkceCodes> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)))
    .map((b) => chars[b % chars.length])
    .join("")
  const challenge = base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// ---------------------------------------------------------------------------
// JWT / account ID
// ---------------------------------------------------------------------------

function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId =
      claims?.chatgpt_account_id ??
      claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ??
      claims?.organizations?.[0]?.id
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractFromClaims(claims) : undefined
  }
  return undefined
}

function extractFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ??
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
    claims.organizations?.[0]?.id
  )
}

// ---------------------------------------------------------------------------
// Token exchange & refresh
// ---------------------------------------------------------------------------

function buildAuthorizeUrl(issuer: string, redirectUri: string, pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "opencode",
  })
  return `${issuer}/oauth/authorize?${params.toString()}`
}

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  pkce: PkceCodes,
  issuer: string,
): Promise<TokenResponse> {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`)
  }
  return response.json() as Promise<TokenResponse>
}

async function refreshAccessToken(refreshToken: string, issuer: string): Promise<TokenResponse> {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return response.json() as Promise<TokenResponse>
}

// ---------------------------------------------------------------------------
// OAuth callback server
// ---------------------------------------------------------------------------

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>OpenCode - Authorization Successful</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #131010; color: #f1ecec; }
      .container { text-align: center; padding: 2rem; }
      h1 { color: #f1ecec; margin-bottom: 1rem; }
      p { color: #b7b1b1; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to OpenCode.</p>
    </div>
  </body>
</html>`

const HTML_ERROR = (error: string) => `<!doctype html>
<html>
  <head>
    <title>OpenCode - Authorization Failed</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #131010; color: #f1ecec; }
      .container { text-align: center; padding: 2rem; }
      h1 { color: #fc533a; margin-bottom: 1rem; }
      p { color: #b7b1b1; }
      .error { color: #ff917b; font-family: monospace; margin-top: 1rem; padding: 1rem; background: #3c140d; border-radius: 0.5rem; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p>An error occurred during authorization.</p>
      <div class="error">${error}</div>
    </div>
  </body>
</html>`

async function startOAuthServer(issuer: string): Promise<{ redirectUri: string }> {
  if (oauthServer) {
    return { redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
  }

  oauthServer = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${OAUTH_PORT}`)

    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      const errorDescription = url.searchParams.get("error_description")

      if (error) {
        const errorMsg = errorDescription || error
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      if (!code) {
        const errorMsg = "Missing authorization code"
        pendingOAuth?.reject(new Error(errorMsg))
        pendingOAuth = undefined
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(HTML_ERROR(errorMsg))
        return
      }

      if (!pendingOAuth || state !== pendingOAuth.state) {
        pendingOAuth?.reject(new Error("Invalid state - potential CSRF attack"))
        pendingOAuth = undefined
        res.writeHead(400, { "Content-Type": "text/html" })
        res.end(HTML_ERROR("Invalid state - potential CSRF attack"))
        return
      }

      const current = pendingOAuth
      pendingOAuth = undefined

      exchangeCodeForTokens(code, `http://localhost:${OAUTH_PORT}/auth/callback`, current.pkce, issuer)
        .then((tokens) => current.resolve(tokens))
        .catch((err) => current.reject(err))

      res.writeHead(200, { "Content-Type": "text/html" })
      res.end(HTML_SUCCESS)
      return
    }

    res.writeHead(404)
    res.end("Not found")
  })

  await new Promise<void>((resolve, reject) => {
    oauthServer!.listen(OAUTH_PORT, () => resolve())
    oauthServer!.on("error", reject)
  })

  return { redirectUri: `http://localhost:${OAUTH_PORT}/auth/callback` }
}

function stopOAuthServer() {
  if (oauthServer) {
    oauthServer.close()
    oauthServer = undefined
  }
}

function waitForOAuthCallback(pkce: PkceCodes, state: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingOAuth) {
        pendingOAuth = undefined
        reject(new Error("OAuth callback timeout - authorization took too long"))
      }
    }, 5 * 60 * 1000)

    pendingOAuth = {
      pkce,
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Auth info shape (minimal local type)
// ---------------------------------------------------------------------------

type AuthInfo =
  | { type: "oauth"; refresh: string; access: string; expires: number; accountId?: string }
  | { type: "api"; key: string }
  | { type: "wellknown"; key: string; token: string }

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const OpenAIProxyAuthPlugin = async (
  input: PluginInput,
  options?: PluginOptions,
): Promise<Hooks> => {
  const opts = (options ?? {}) as ProxyOptions
  const routeMap = opts.routeMap ?? {}
  const active = pluginActive(routeMap)
  const issuer = resolveIssuer(routeMap)
  const codexApiEndpoint = resolveCodexApi(routeMap)

  if (active) {
    log("active", { issuer, codexApiEndpoint, routeMap })
  }

  return {
    config: async (_cfg) => {
      if (active) {
        log("config received — proxy routing active")
      }
    },
    auth: {
      provider: "openai",

      // ---------------------------------------------------------------
      // Auth methods
      // ---------------------------------------------------------------
      methods: [
        {
          label: active
            ? "ChatGPT Pro/Plus (browser, proxy: " + issuer + ")"
            : "ChatGPT Pro/Plus (browser, proxied)",
          type: "oauth" as const,
          authorize: async (): Promise<AuthOAuthResult> => {
            const { redirectUri } = await startOAuthServer(issuer)
            const pkce = await generatePKCE()
            const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
            const authUrl = buildAuthorizeUrl(issuer, redirectUri, pkce, state)
            const callbackPromise = waitForOAuthCallback(pkce, state)

            return {
              url: authUrl,
              instructions: "Complete authorization in your browser. This window will close automatically.",
              method: "auto",
              callback: async () => {
                const tokens = await callbackPromise
                stopOAuthServer()
                const accountId = extractAccountId(tokens)
                return {
                  type: "success",
                  refresh: tokens.refresh_token,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  accountId,
                }
              },
            }
          },
        },
        {
          label: "ChatGPT Pro/Plus (headless, proxied)",
          type: "oauth" as const,
          authorize: async (): Promise<AuthOAuthResult> => {
            const deviceResponse = await fetch(`${issuer}/api/accounts/deviceauth/usercode`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ client_id: CLIENT_ID }),
            })

            if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")

            const deviceData = (await deviceResponse.json()) as {
              device_auth_id: string
              user_code: string
              interval: string
            }
            const interval = Math.max(parseInt(deviceData.interval) || 5, 1) * 1000

            return {
              url: `${issuer}/codex/device`,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto",
              async callback() {
                while (true) {
                  const response = await fetch(`${issuer}/api/accounts/deviceauth/token`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      device_auth_id: deviceData.device_auth_id,
                      user_code: deviceData.user_code,
                    }),
                  })

                  if (response.ok) {
                    const data = (await response.json()) as {
                      authorization_code: string
                      code_verifier: string
                    }

                    const tokenResponse = await fetch(`${issuer}/oauth/token`, {
                      method: "POST",
                      headers: { "Content-Type": "application/x-www-form-urlencoded" },
                      body: new URLSearchParams({
                        grant_type: "authorization_code",
                        code: data.authorization_code,
                        redirect_uri: `${issuer}/deviceauth/callback`,
                        client_id: CLIENT_ID,
                        code_verifier: data.code_verifier,
                      }).toString(),
                    })

                    if (!tokenResponse.ok) {
                      throw new Error(`Token exchange failed: ${tokenResponse.status}`)
                    }

                    const tokens: TokenResponse = (await tokenResponse.json()) as TokenResponse

                    return {
                      type: "success",
                      refresh: tokens.refresh_token,
                      access: tokens.access_token,
                      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                      accountId: extractAccountId(tokens),
                    }
                  }

                  if (response.status !== 403 && response.status !== 404) {
                    return { type: "failed" }
                  }

                  await sleep(interval + OAUTH_POLLING_SAFETY_MS)
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api" as const,
        },
      ],

      // ---------------------------------------------------------------
      // Loader — custom fetch with proxied token refresh + API routing
      // ---------------------------------------------------------------
      loader: async (getAuth) => {
        const auth = (await getAuth()) as AuthInfo
        if (auth.type !== "oauth") return {}

        let refreshPromise:
          | Promise<{ access: string; accountId: string | undefined }>
          | undefined

        return {
          apiKey: OAUTH_DUMMY_KEY,

          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            // Strip Authorization header that AI SDK sets from dummy key
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.delete("authorization")
                init.headers.delete("Authorization")
              } else if (Array.isArray(init.headers)) {
                init.headers = init.headers.filter(
                  ([key]) => key.toLowerCase() !== "authorization",
                )
              } else {
                delete init.headers["authorization"]
                delete init.headers["Authorization"]
              }
            }

            const currentAuth = (await getAuth()) as AuthInfo
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            // Refresh token if expired
            if (!currentAuth.access || currentAuth.expires < Date.now()) {
              if (!refreshPromise) {
                refreshPromise = refreshAccessToken(currentAuth.refresh, issuer)
                  .then(async (tokens) => {
                    const accountId = extractAccountId(tokens) ?? currentAuth.accountId
                    await input.client.auth.set({
                      path: { id: "openai" },
                      body: {
                        type: "oauth",
                        refresh: tokens.refresh_token,
                        access: tokens.access_token,
                        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                        ...(accountId && { accountId }),
                      },
                    })
                    return { access: tokens.access_token, accountId }
                  })
                  .finally(() => {
                    refreshPromise = undefined
                  })
              }

              const refreshed = await refreshPromise
              currentAuth.access = refreshed.access
              currentAuth.accountId = refreshed.accountId
            }

            // Build headers with OAuth bearer token
            const headers = new Headers()
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => headers.set(key, value))
              } else if (Array.isArray(init.headers)) {
                for (const [key, value] of init.headers) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              } else {
                for (const [key, value] of Object.entries(init.headers)) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              }
            }
            headers.set("authorization", `Bearer ${currentAuth.access}`)
            if (currentAuth.accountId) {
              headers.set("ChatGPT-Account-Id", currentAuth.accountId)
            }

            // Rewrite Codex API URLs through proxy
            const parsed =
              requestInput instanceof URL
                ? requestInput
                : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)

            const url =
              parsed.pathname.includes("/v1/responses") ||
              parsed.pathname.includes("/chat/completions")
                ? new URL(codexApiEndpoint)
                : parsed

            return fetch(url, { ...init, headers })
          },
        }
      },
    },
  }
}

export default OpenAIProxyAuthPlugin
