import path from "node:path"
import { readFile } from "node:fs/promises"
import { and, eq } from "drizzle-orm"
import { db } from "@/db"
import { artifacts, tasks } from "@/db/schema"
import { requireOwner } from "@/lib/auth"
import { artifactDir } from "@/lib/env"
import { errorResponse, HttpError } from "@/lib/errors"

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const owner = await requireOwner(request.headers)
    const [row] = await db
      .select({ artifact: artifacts })
      .from(artifacts)
      .innerJoin(tasks, eq(artifacts.taskId, tasks.id))
      .where(
        and(eq(artifacts.id, (await context.params).id), eq(tasks.ownerId, owner.userId))
      )
    if (!row) throw new HttpError(404, "Artifact not found")
    const target = path.resolve(artifactDir, row.artifact.storagePath)
    if (!target.startsWith(artifactDir + path.sep))
      throw new Error("Artifact path escapes the configured storage directory")
    const content = await readFile(target)
    return new Response(content, {
      headers: {
        "Content-Type": row.artifact.mediaType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.artifact.name)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
