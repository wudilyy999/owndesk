import { z } from "zod"
import { requireOwner, requireSameOrigin } from "@/lib/auth"
import { errorResponse, HttpError } from "@/lib/errors"
import { pluginConfigSchema, pluginNameSchema } from "@/lib/agent-zero"
import {
  installedAgentZeroPlugins,
  pluginCatalog,
  installAgentZeroPlugin,
  configureAgentZeroPlugin,
} from "@/lib/agent-zero-plugins"

export const runtime = "nodejs"
const headers = { "Cache-Control": "private, no-store" }
export async function GET(request: Request) {
  try {
    await requireOwner(request.headers)
    return Response.json(
      new URL(request.url).searchParams.has("catalog")
        ? await pluginCatalog()
        : await installedAgentZeroPlugins(),
      { headers }
    )
  } catch (error) {
    return errorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request)
    await requireOwner(request.headers)
    const body = await request.text()
    if (body.length > 12000) throw new HttpError(413, "Plugin request too large")
    const input = z
      .object({
        repository: z.string().max(300),
        ref: z.string().min(1).max(200).default("HEAD"),
        expectedName: pluginNameSchema.optional(),
      })
      .parse(JSON.parse(body))
    return Response.json(
      await installAgentZeroPlugin(input.repository, input.ref, input.expectedName),
      { headers }
    )
  } catch (error) {
    return errorResponse(error)
  }
}

export async function PATCH(request: Request) {
  try {
    requireSameOrigin(request)
    await requireOwner(request.headers)
    const body = await request.text()
    if (body.length > 12000) throw new HttpError(413, "Plugin request too large")
    const input = z
      .object({ id: pluginNameSchema, enabled: z.boolean(), config: pluginConfigSchema })
      .parse(JSON.parse(body))
    return Response.json(
      await configureAgentZeroPlugin(input.id, input.enabled, input.config),
      { headers }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
