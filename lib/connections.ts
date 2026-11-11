import { randomUUID } from "node:crypto"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import { pool } from "@/db"
import { env } from "@/lib/env"
import { encryptSecret, decryptSecret } from "@/lib/secrets"
import { HttpError } from "@/lib/errors"
import {
  connectionInputSchema,
  type ConnectionConfig,
  type ConnectionReference,
  type ConnectionTool,
} from "./connection-schema"
import { connectionFetch } from "./connection-fetch"
import { googleTools, callGoogle } from "./google-connection"

type ConnectionRow = {
  id: string
  owner_id: string
  name: string
  kind: string
  enabled: boolean
  revision: number
  tools: ConnectionTool[]
  config_cipher: string
  tokens_cipher: string | null
  oauth_session_cipher: string | null
}
const binding = (id: string, part: string) => `connection:${env.INSTALL_ID}:${id}:${part}`
const encode = (id: string, part: string, value: unknown) =>
  encryptSecret(JSON.stringify(value), binding(id, part))
const decode = <T>(id: string, part: string, value: string) =>
  JSON.parse(decryptSecret(value, binding(id, part))) as T
export async function connectionRow(ownerId: string, id: string) {
  const {
    rows: [row],
  } = await pool.query<ConnectionRow>(
    "SELECT * FROM app_connections WHERE owner_id=$1 AND id=$2",
    [ownerId, id]
  )
  if (!row) throw new HttpError(404, "Connection not found")
  return row
}
export async function listConnections(ownerId: string) {
  return (
    await pool.query(
      'SELECT id,name,kind,enabled,revision,tools,tokens_cipher IS NOT NULL AS authorized,updated_at AS "updatedAt" FROM app_connections WHERE owner_id=$1 ORDER BY name,id',
      [ownerId]
    )
  ).rows
}
export async function saveConnection(ownerId: string, raw: unknown) {
  const input = connectionInputSchema.parse(raw),
    id = input.id ?? randomUUID()
  if (input.id) {
    await connectionRow(ownerId, id)
    await pool.query(
      "UPDATE app_connections SET name=$3,kind=$4,config_cipher=$5,enabled=$6,revision=revision+1,tools='[]',tokens_cipher=NULL,oauth_session_cipher=NULL,updated_at=now() WHERE id=$1 AND owner_id=$2",
      [
        id,
        ownerId,
        input.name,
        input.config.kind,
        encode(id, "config", input.config),
        input.enabled,
      ]
    )
  } else
    await pool.query(
      "INSERT INTO app_connections(id,owner_id,name,kind,config_cipher,enabled,tools,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'[]',now(),now())",
      [
        id,
        ownerId,
        input.name,
        input.config.kind,
        encode(id, "config", input.config),
        input.enabled,
      ]
    )
  return { id }
}
export async function setConnectionEnabled(
  ownerId: string,
  id: string,
  enabled: boolean
) {
  await connectionRow(ownerId, id)
  await pool.query(
    "UPDATE app_connections SET enabled=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2",
    [id, ownerId, enabled]
  )
}
export async function disconnectConnection(ownerId: string, id: string, remove = false) {
  await connectionRow(ownerId, id)
  if (remove)
    await pool.query("DELETE FROM app_connections WHERE id=$1 AND owner_id=$2", [
      id,
      ownerId,
    ])
  else
    await pool.query(
      "UPDATE app_connections SET enabled=false,tokens_cipher=NULL,oauth_session_cipher=NULL,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_id=$2",
      [id, ownerId]
    )
}
const oauthConfig = (config: ConnectionConfig) =>
  config.kind === "google"
    ? {
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        scope:
          "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events",
      }
    : config.kind === "mcp_http"
      ? config.oauth
      : undefined
const metadata = (config: NonNullable<ReturnType<typeof oauthConfig>>) => ({
  issuer: new URL(config.authorizationUrl).origin,
  authorization_endpoint: config.authorizationUrl,
  token_endpoint: config.tokenUrl,
  response_types_supported: ["code"],
  token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
})
const clientInformation = (config: NonNullable<ReturnType<typeof oauthConfig>>) => ({
  client_id: config.clientId,
  ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
})
const redirectUri = (id: string) => `${env.APP_URL}/api/connections/${id}/oauth`
export async function authorizeConnection(ownerId: string, id: string) {
  const row = await connectionRow(ownerId, id),
    config = decode<ConnectionConfig>(id, "config", row.config_cipher),
    oauth = oauthConfig(config)
  if (!oauth) throw new HttpError(400, "Connection does not use OAuth")
  const state = randomUUID(),
    { authorizationUrl, codeVerifier } = await startAuthorization(
      oauth.authorizationUrl,
      {
        metadata: metadata(oauth),
        clientInformation: clientInformation(oauth),
        redirectUrl: redirectUri(id),
        scope: oauth.scope,
        state,
      }
    )
  if (config.kind === "google") {
    authorizationUrl.searchParams.set("access_type", "offline")
    authorizationUrl.searchParams.set("prompt", "consent")
  }
  await pool.query(
    "UPDATE app_connections SET oauth_session_cipher=$3 WHERE id=$1 AND owner_id=$2",
    [
      id,
      ownerId,
      encode(id, "oauth", {
        state,
        codeVerifier,
        expires: Date.now() + 600000,
        revision: row.revision,
      }),
    ]
  )
  return { url: authorizationUrl.toString() }
}
export async function finishConnectionAuthorization(
  ownerId: string,
  id: string,
  state: string,
  code: string
) {
  const row = await connectionRow(ownerId, id)
  if (!row.oauth_session_cipher) throw new HttpError(409, "Start authorization again")
  const session = decode<{
    state: string
    codeVerifier: string
    expires: number
    revision: number
  }>(id, "oauth", row.oauth_session_cipher)
  if (
    session.state !== state ||
    session.expires < Date.now() ||
    session.revision !== row.revision
  )
    throw new HttpError(400, "OAuth state expired or mismatched")
  const claimed = await pool.query(
    "UPDATE app_connections SET oauth_session_cipher=NULL WHERE id=$1 AND oauth_session_cipher=$2 RETURNING id",
    [id, row.oauth_session_cipher]
  )
  if (!claimed.rowCount) throw new HttpError(409, "Authorization already used")
  const config = decode<ConnectionConfig>(id, "config", row.config_cipher),
    oauth = oauthConfig(config)!
  const tokens = await exchangeAuthorization(oauth.authorizationUrl, {
    metadata: metadata(oauth),
    clientInformation: clientInformation(oauth),
    authorizationCode: code,
    codeVerifier: session.codeVerifier,
    redirectUri: redirectUri(id),
    fetchFn: connectionFetch(config.kind === "mcp_http" && config.allowLoopback),
  })
  await saveTokens(row, tokens)
}
async function saveTokens(row: ConnectionRow, tokens: OAuthTokens) {
  const result = await pool.query(
    "UPDATE app_connections SET tokens_cipher=$3,updated_at=now() WHERE id=$1 AND revision=$2 RETURNING id",
    [
      row.id,
      row.revision,
      encode(row.id, "tokens", {
        ...tokens,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      }),
    ]
  )
  if (!result.rowCount)
    throw new HttpError(409, "Connection changed during authorization")
}
async function accessToken(row: ConnectionRow, config: ConnectionConfig) {
  if (!row.tokens_cipher) return config.kind === "mcp_http" ? config.bearer : undefined
  let tokens = decode<OAuthTokens & { expiresAt: number }>(
    row.id,
    "tokens",
    row.tokens_cipher
  )
  if (tokens.expiresAt < Date.now() + 30000) {
    const oauth = oauthConfig(config)
    if (!oauth || !tokens.refresh_token)
      throw new HttpError(401, "Reconnect this app in Settings")
    const next = await refreshAuthorization(oauth.authorizationUrl, {
      metadata: metadata(oauth),
      clientInformation: clientInformation(oauth),
      refreshToken: tokens.refresh_token,
      fetchFn: connectionFetch(config.kind === "mcp_http" && config.allowLoopback),
    })
    await saveTokens(row, next)
    tokens = { ...next, expiresAt: Date.now() + (next.expires_in ?? 3600) * 1000 }
  }
  return tokens.access_token
}
async function mcp<T>(
  config: Exclude<ConnectionConfig, { kind: "google" }>,
  token: string | undefined,
  read: (client: Client) => Promise<T>
) {
  const client = new Client({ name: "OwnDesk", version: "1.0.0" })
  const transport =
    config.kind === "mcp_stdio"
      ? new StdioClientTransport({ ...config, stderr: "pipe", maxBufferSize: 2000000 })
      : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            redirect: "error",
          },
          fetch: connectionFetch(config.allowLoopback),
          reconnectionOptions: {
            maxReconnectionDelay: 1000,
            initialReconnectionDelay: 1000,
            reconnectionDelayGrowFactor: 1,
            maxRetries: 0,
          },
        })
  try {
    await client.connect(transport, { timeout: 30000 })
    return await read(client)
  } finally {
    await client.close()
  }
}
export async function discoverConnection(ownerId: string, id: string) {
  const row = await connectionRow(ownerId, id),
    config = decode<ConnectionConfig>(id, "config", row.config_cipher)
  const tools =
    config.kind === "google"
      ? googleTools
      : await mcp(config, await accessToken(row, config), async (client) => {
          const tools: ConnectionTool[] = []
          let cursor: string | undefined
          do {
            const page = await client.listTools(cursor ? { cursor } : {}, {
              timeout: 30000,
            })
            tools.push(
              ...page.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                // Server annotations are advisory, never owner authorization.
                readOnly: false,
              }))
            )
            if (tools.length > 200)
              throw new HttpError(
                413,
                "Connection exposes more than 200 tools; configure a smaller catalog"
              )
            cursor = page.nextCursor
          } while (cursor)
          return tools
        })
  const result = await pool.query(
    "UPDATE app_connections SET tools=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$2 RETURNING id",
    [id, row.revision, JSON.stringify(tools)]
  )
  if (!result.rowCount) throw new HttpError(409, "Connection changed during discovery")
  return { tools }
}
export async function connectionSnapshot(
  ownerId: string
): Promise<ConnectionReference[]> {
  return (
    await pool.query<ConnectionReference>(
      "SELECT id,name,revision,tools FROM app_connections WHERE owner_id=$1 AND enabled=true ORDER BY name,id",
      [ownerId]
    )
  ).rows
}
export function validateConnectionArguments(
  tool: ConnectionTool,
  args: Record<string, unknown>
) {
  const result = new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args)
  if (!result.valid)
    throw new HttpError(400, `Invalid ${tool.name} arguments: ${result.errorMessage}`)
}
export async function callConnection(
  ownerId: string,
  id: string,
  revision: number,
  tool: string,
  args: Record<string, unknown>
) {
  const row = await connectionRow(ownerId, id)
  if (
    !row.enabled ||
    row.revision !== revision ||
    !row.tools.some((item) => item.name === tool)
  )
    throw new HttpError(
      409,
      "Connection or tool changed; start a new task after checking Settings"
    )
  validateConnectionArguments(
    row.tools.find((item) => item.name === tool)!,
    args
  )
  const config = decode<ConnectionConfig>(id, "config", row.config_cipher),
    token = await accessToken(row, config)
  if (config.kind === "google") {
    if (!token) throw new HttpError(401, "Authorize Google in Settings")
    return callGoogle(token, tool, args)
  }
  return mcp(config, token, (client) =>
    client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60000 })
  )
}
