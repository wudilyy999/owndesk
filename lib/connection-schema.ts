import { z } from "zod"
import { connectionEndpointAllowed } from "./connection-endpoint"
const endpoint = z.url()
export const oauthSchema = z.object({
  authorizationUrl: endpoint,
  tokenUrl: endpoint,
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  scope: z.string().default(""),
})
export const connectionConfigSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("mcp_http"),
      url: endpoint,
      allowLoopback: z.boolean().default(false),
      bearer: z.string().optional(),
      oauth: oauthSchema.optional(),
    }),
    z.object({
      kind: z.literal("mcp_stdio"),
      command: z.string().min(1).max(500),
      args: z.array(z.string().max(2000)).max(30).default([]),
      env: z.record(z.string(), z.string()).default({}),
    }),
    z.object({
      kind: z.literal("google"),
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
    }),
  ])
  .refine(
    (config) =>
      config.kind !== "mcp_http" ||
      [config.url, config.oauth?.authorizationUrl, config.oauth?.tokenUrl]
        .filter((url): url is string => url !== undefined)
        .every((url) => connectionEndpointAllowed(url, config.allowLoopback)),
    "Use public HTTPS endpoints; loopback requires explicit per-connection opt-in"
  )
export const connectionInputSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(80),
  config: connectionConfigSchema,
  enabled: z.boolean().default(false),
})
export const connectionCallSchema = z
  .strictObject({
    connectionId: z.uuid(),
    tool: z.string().min(1).max(200),
    args: z.record(z.string(), z.unknown()).default({}),
  })
  .refine(
    (value) => JSON.stringify(value.args).length <= 50000,
    "Tool input exceeds 50000 characters"
  )
export type ConnectionConfig = z.infer<typeof connectionConfigSchema>
export type ConnectionTool = {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
}
export type ConnectionReference = {
  id: string
  name: string
  revision: number
  tools: ConnectionTool[]
}
