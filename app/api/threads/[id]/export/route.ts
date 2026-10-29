import { requireOwner } from "@/lib/auth"
import { errorResponse } from "@/lib/errors"
import { getThread, type ThreadTurn } from "@/lib/threads"
import { exportFilename, threadToMarkdown, type ExportMessage } from "@/lib/export"
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const owner = await requireOwner(request.headers)
    const { id } = await context.params
    let page = await getThread(owner.userId, id)
    const title = page.title,
      turns: ThreadTurn[] = [...page.turns]
    while (page.hasEarlier) {
      page = await getThread(owner.userId, id, page.turns[0].threadTurn)
      turns.unshift(...page.turns)
    }
    const messages: ExportMessage[] = turns.flatMap((turn) => [
      { role: "user", parts: [{ type: "text", text: turn.goal }] },
      {
        role: "assistant",
        parts: [
          ...turn.tools.map((tool) => ({
            type: `tool-${tool.kind}`,
            input: {},
            state: tool.status === "succeeded" ? "output-available" : "output-error",
          })),
          ...(turn.interactions ?? []).map((interaction) => ({
            type: "text",
            text: `历史人工交互：${interaction.question}\n\n拥有者处理：${interaction.decision}；${interaction.answer}`,
          })),
          {
            type: "text",
            text:
              turn.reply ??
              `本轮状态：${turn.status}${turn.error ? `；${turn.error}` : ""}`,
          },
          ...turn.artifacts.map((file) => ({
            type: "text",
            text: `成果：${file.name}（${file.verification.grade}）；下载：/api/artifacts/${file.id}`,
          })),
        ],
      },
    ])
    return new Response(
      threadToMarkdown({ title, owner: owner.user.name, members: [], messages }),
      {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${exportFilename(title)}"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      }
    )
  } catch (error) {
    return errorResponse(error)
  }
}
