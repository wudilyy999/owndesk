import { listDemonstrations } from "@/lib/demonstrations"
import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"
import Link from "next/link"
import { requireOwner } from "@/lib/auth"
import { HttpError } from "@/lib/errors"
import { getTask } from "@/lib/tasks"
import { listAgents } from "@/lib/agents"
import { listManualDrafts, listManuals } from "@/lib/manuals"
import { ManualActions, ManualDraftForm, ManualEditor } from "@/components/manuals"

const verificationLabels: Record<string, string> = {
  human_demonstrated: "人工示范与用户审阅",
  model_reported: "模型报告完成",
  program_checked: "程序已核对",
  human_confirmed: "用户已确认",
  see_artifacts: "详见交付文件检查",
}

export default async function ManualsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string | string[] }>
}) {
  let owner
  try {
    owner = await requireOwner(await headers())
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) redirect("/login")
    throw error
  }
  const id = (await searchParams).source
  if (Array.isArray(id) || (id && id.length > 100)) notFound()
  const source = id ? await getTask(owner.userId, id) : null
  const [manuals, drafts, agents, demonstrations] = await Promise.all([
    listManuals(owner.userId),
    listManualDrafts(owner.userId),
    listAgents(),
    listDemonstrations(owner.userId),
  ])
  const eligible =
    source?.status === "completed" &&
    !source.result?.manualDraft &&
    !source.result?.workflow
  const availableAgents = agents
    .filter((agent) => agent.model !== "fixture/durable-report")
    .map(({ id, name }) => ({ id, name }))
  return (
    <main className="mx-auto max-w-4xl space-y-8 p-5 sm:p-10">
      <nav className="flex flex-wrap gap-5 text-sm underline underline-offset-4">
        <Link href="/">返回任务</Link>
        <Link href="/workflows">固定操作流程</Link>
        <Link href="/manuals">刷新手册</Link>
      </nav>
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">操作手册</h1>
        <p className="max-w-2xl text-sm leading-7 text-muted-foreground">
          留下成功任务的做法，审阅保存后让 Agent
          在相关任务中按需参考。每次使用都会重新观察当前电脑；固定、已验证的自动执行流程继续单独保留。
        </p>
      </header>
      {demonstrations
        .filter((row) => row.status === "draft")
        .map((row) => (
          <section key={row.id} className="space-y-4 rounded border p-5">
            <h2 className="font-medium">示范手册：{row.name}</h2>
            <ManualEditor id={row.id} draft={row.draft} demonstration />
          </section>
        ))}
      {source && (
        <section className="space-y-5 rounded-2xl border border-border bg-surface p-5 sm:p-6">
          <h2 className="text-lg font-medium">从成功任务生成草稿</h2>
          <Link
            className="block text-sm break-all underline"
            href={`/?task=${encodeURIComponent(source.id)}`}
          >
            查看来源任务
          </Link>
          {eligible ? (
            <ManualDraftForm source={{ id: source.id, agentId: source.agentId }} />
          ) : (
            <p className="text-sm text-muted-foreground">
              请选择已完成的电脑任务；手册草稿和流程编译任务不能作为操作来源。
            </p>
          )}
        </section>
      )}
      <section className="space-y-5">
        <h2 className="text-lg font-medium">待审阅草稿</h2>
        {!drafts.some((draft) => !manuals.some((manual) => manual.id === draft.id)) && (
          <p className="text-sm text-muted-foreground">
            在已完成任务中选择“生成操作手册”，先审阅依据，再生成草稿。
          </p>
        )}
        {drafts
          .filter((draft) => !manuals.some((manual) => manual.id === draft.id))
          .map((draft) => (
            <article
              key={draft.id}
              className="space-y-4 rounded-2xl border border-border bg-surface p-5 sm:p-6"
            >
              <header className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-medium">{draft.name}</h3>
                <Link
                  className="text-sm underline"
                  href={`/?task=${encodeURIComponent(draft.id)}`}
                >
                  查看生成任务与费用
                </Link>
              </header>
              {draft.status === "completed" && draft.draft ? (
                <ManualEditor id={draft.id} draft={draft.draft} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {["needs_review", "waiting_user", "waiting_human"].includes(
                    draft.status
                  )
                    ? "生成已暂停，请在原任务中处理确认或复核。"
                    : ["failed", "cancelled"].includes(draft.status)
                      ? "草稿尚未生成，原任务与费用记录已保留。"
                      : "正在生成草稿，完成后刷新本页审阅。"}
                </p>
              )}
            </article>
          ))}
      </section>
      <section className="space-y-5">
        <h2 className="text-lg font-medium">已保存手册</h2>
        {!manuals.length && (
          <p className="text-sm text-muted-foreground">
            保存后的手册会出现在这里。新任务只先看到名称与用途，相关时再加载完整步骤。
          </p>
        )}
        {manuals.map((manual) => (
          <article
            key={manual.id}
            className="space-y-4 rounded-2xl border border-border bg-surface p-5 sm:p-6"
          >
            <header className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-medium">{manual.name}</h3>
              <span className="text-sm text-muted-foreground">
                {manual.enabled ? "可按需参考" : "已停用"}
              </span>
            </header>
            <p className="text-sm leading-6">{manual.description}</p>
            <p className="text-xs text-muted-foreground">
              用户已审阅；跨任务执行效果尚未认证。来源检查等级：
              {verificationLabels[manual.sourceVerification]}
              {manual.humanInvolvement
                ? "。来源包含人工接管，新的私有准备需重新确认。"
                : "。"}
            </p>
            <Link
              href={
                manual.sourceKind === "demonstration"
                  ? "/manuals"
                  : `/?task=${encodeURIComponent(manual.sourceTaskId)}`
              }
              className="text-sm underline"
            >
              {manual.sourceKind === "demonstration" ? "人工示范来源" : "查看原始任务"}
            </Link>
            <details>
              <summary className="cursor-pointer text-sm">查看操作步骤</summary>
              <pre className="mt-3 max-h-96 overflow-auto rounded bg-muted p-4 font-sans text-sm leading-7 break-words whitespace-pre-wrap">
                {manual.body}
              </pre>
            </details>
            <ManualActions manual={manual} agents={availableAgents} />
          </article>
        ))}
      </section>
    </main>
  )
}
