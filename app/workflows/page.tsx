import { CrossAppWorkflow } from "@/components/cross-app-workflow"
import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"
import Link from "next/link"
import { requireOwner } from "@/lib/auth"
import { HttpError } from "@/lib/errors"
import { getTask } from "@/lib/tasks"
import { listWorkflowVersions } from "@/lib/workflows"
import { WorkflowCompilationForm } from "@/components/workflow-compilation"
import { WorkflowRunForm } from "@/components/workflow-run"
import { WorkflowExport, WorkflowImport } from "@/components/workflow-sharing"
import { listAgents } from "@/lib/agents"

const labels = {
  draft: "编译中",
  verifying: "候选 · 待验证",
  ready: "可复用",
  retired: "已停用",
  rejected: "验证未通过",
}
export default async function WorkflowsPage({
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
  const versions = await listWorkflowVersions(owner.userId)
  const agentRows = await listAgents()
  const eligible =
    source?.status === "completed" &&
    !!source.completionContract.directoryTree &&
    source.result?.verification &&
    (source.result.verification as { grade?: string }).grade === "program_checked"
  return (
    <main className="mx-auto max-w-4xl space-y-8 p-5 sm:p-10">
      <nav className="flex gap-5 text-sm underline underline-offset-4">
        <Link href="/">返回任务</Link>
        <Link href="/workflows">刷新流程</Link>
        <Link href="/manuals">操作手册</Link>
      </nav>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">电脑操作流程</h1>
        <p className="text-sm text-muted-foreground">
          从已检查通过的操作中提炼方法，保留参数、步骤和固定检查条件。
        </p>
      </header>
      <CrossAppWorkflow agents={agentRows.map(({ id, name }) => ({ id, name }))} />
      <WorkflowImport />
      {source && (
        <section className="space-y-5 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6">
          <h2 className="text-lg font-medium">保存为流程</h2>
          <Link
            className="block text-sm break-all underline"
            href={`/?task=${encodeURIComponent(source.id)}`}
          >
            来源任务：{source.id}
          </Link>
          {eligible ? (
            <WorkflowCompilationForm
              source={{
                id: source.id,
                agentId: source.agentId,
                completionContract: source.completionContract,
              }}
            />
          ) : (
            <p>当前仅支持单段、宿主目录树检查通过的任务。</p>
          )}
        </section>
      )}
      <section className="space-y-6">
        <h2 className="text-lg font-medium">已保存的版本</h2>
        {!versions.length && (
          <p className="text-sm text-muted-foreground">
            还没有流程。从已完成的目录整理任务中选择“保存为流程”。
          </p>
        )}
        {versions.map((version) => (
          <article
            key={version.id}
            className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6"
          >
            <header className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-medium">
                {version.name} / v{version.revision}
              </h3>
              <span className="text-sm">
                {version.status === "draft" && version.importedPackage
                  ? "导入草稿 · 待独立验证"
                  : version.status === "draft" && version.plan?.repairOrigin
                    ? "修订草稿 · 待独立验证"
                    : version.status === "draft" &&
                        ["needs_review", "waiting_user"].includes(
                          version.compilationStatus ?? ""
                        )
                      ? "编译暂停 · 待处理"
                      : version.status === "draft" &&
                          ["failed", "cancelled"].includes(
                            version.compilationStatus ?? ""
                          )
                        ? "编译未完成"
                        : labels[version.status]}
              </span>
            </header>
            <div className="flex flex-wrap gap-4 text-sm underline">
              {version.sourceTaskId && (
                <Link href={`/?task=${encodeURIComponent(version.sourceTaskId)}`}>
                  来源任务
                </Link>
              )}
              {version.compilationTaskId && (
                <Link href={`/?task=${encodeURIComponent(version.compilationTaskId)}`}>
                  {version.plan?.repairOrigin ? "修订与费用" : "编译与费用"}
                </Link>
              )}
            </div>
            {version.importedPackage && (
              <p className="text-sm break-all text-muted-foreground">
                外部流程包：{version.importedPackage.packageId}
                。原环境声明与本机验证结果分别记录。
              </p>
            )}
            {version.plan ? (
              <>
                <p className="text-sm">{version.plan.description}</p>
                <p className="text-sm break-words text-muted-foreground">
                  参数：
                  {version.plan.parameters
                    .map((p) => `${p.label}（${p.name}）`)
                    .join("、")}
                </p>
                <ol className="list-decimal space-y-2 pl-6 text-sm">
                  {version.plan.steps.map((step) => (
                    <li key={step.id}>
                      {step.label}
                      <span className="ml-2 text-muted-foreground">{step.operation}</span>
                    </li>
                  ))}
                </ol>
                <details>
                  <summary className="cursor-pointer text-sm">
                    查看固定计划与检查合同
                  </summary>
                  <pre className="mt-3 max-h-96 overflow-auto rounded bg-muted p-3 text-xs break-all whitespace-pre-wrap">
                    {JSON.stringify(version.plan, null, 2)}
                  </pre>
                </details>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                编译任务尚未保存有效候选。请查看任务状态或失败原因。
              </p>
            )}
            {version.status === "verifying" && (
              <p className="text-sm text-muted-foreground">
                候选尚未验证。请用新参数独立验证，当前禁止作为已就绪流程运行。
              </p>
            )}
            {version.plan &&
              (version.status === "verifying" ||
                version.status === "ready" ||
                (version.status === "draft" &&
                  (!!version.plan.repairOrigin || !!version.importedPackage))) && (
                <WorkflowRunForm
                  version={{
                    id: version.id,
                    name: version.name,
                    status: version.status,
                    parameters: version.plan.parameters,
                  }}
                  agents={agentRows.map(({ id, name }) => ({ id, name }))}
                />
              )}
            {version.status === "ready" && <WorkflowExport versionId={version.id} />}
          </article>
        ))}
      </section>
    </main>
  )
}
