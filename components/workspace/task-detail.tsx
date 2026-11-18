import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { TaskRequest } from "@/components/task-request"
import { Desktop } from "@/components/desktop"
import { ReportComparison } from "@/components/report-comparison"
import type { ComparisonResult } from "@/lib/report-comparison"
import { PaymentResultEvidence } from "@/components/vault/payment-submit"
import type { PaymentResultReceipt } from "@/lib/payment-schema"

export type Summary = {
  id: string
  agentId: string
  conversationAgentId: string
  threadId: string | null
  threadTurn: number | null
  goal: string
  status: string
  createdAt: string
}
export type TaskEvent = {
  seq: number
  type: string
  payload: Record<string, unknown>
  created_at: string
}
export type Detail = Summary & {
  canSupplement: boolean
  supplements: { seq: number; text: string }[]
  thread: { id: string; title: string | null } | null
  updatedAt: string
  agentId: string
  configSnapshot: { runtime: "fixture" | "agent" }
  usage: {
    decisions: number
    known_cost_micros: string
    unknown_cost_attempts: number
    uncertain_attempts: number
  }
  cancelRequestedAt: string | null
  control: { mode: string; epoch: number; desiredMode: string | null } | null
  requests: {
    id: string
    kind: string
    status: string
    payloadVersion: number
    payload: Record<string, unknown>
  }[]
  actions: { segmentNo: number; actionNo: number; kind: string; status: string }[]
  paymentResults: PaymentResultReceipt[]
  activeSegment: number
  segments: {
    segmentNo: number
    agentId: string
    name: string
    model: string
    brief: string | null
  }[]
  error: string | null
  result: Record<string, unknown> | null
  workflowRun?: {
    versionId: string
    purpose: string
    totalSteps: number
    step: number
    phase: string
    blockedReason: string | null
    allowRepair: boolean
    repairStatus: string | null
    repairCursor: number | null
    draftVersionId: string | null
  } | null
  artifacts: { id: string; name: string; size: number; verification: { grade: string } }[]
}
export const labels: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  waiting_user: "等待你处理",
  needs_review: "待复核",
  cancelled: "已取消",
  verifying: "核对中",
}

export function TaskDetail({
  detail,
  events,
  streamState,
  inConversation,
  controlBusy,
  idleTakeover,
  toggleIdleTakeover,
  handbackNote,
  setHandbackNote,
  controlAction,
}: {
  detail: Detail
  events: TaskEvent[]
  streamState: string
  inConversation: boolean
  controlBusy: boolean
  idleTakeover: boolean
  toggleIdleTakeover: () => void
  handbackNote: string
  setHandbackNote: (note: string) => void
  controlAction: (url: string, body?: Record<string, unknown>) => Promise<void>
}) {
  const takeoverRequest = detail.requests.find(
    (request) =>
      request.kind === "takeover" && ["pending", "decided"].includes(request.status)
  )
  const active = !["completed", "cancelled", "failed"].includes(detail.status)
  return (
    <section
      aria-label="任务详情"
      className="space-y-5 rounded-2xl border border-border bg-surface p-5 shadow-xs sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-3.5">
        <h2 className="text-lg font-semibold">
          {labels[detail.status] ?? detail.status}
        </h2>
        <span className="rounded-full border border-border/70 bg-muted/60 px-2.5 py-0.5 text-xs text-muted-foreground">
          事件流：{streamState}
        </span>
      </div>
      <p className="font-mono text-xs break-all text-muted-foreground">
        任务 ID：{detail.id}
      </p>
      {detail.segments.length > 1 && (
        <section
          aria-label="Agent 交接记录"
          className="mt-4 rounded border border-border p-3 text-sm"
        >
          <h4 className="font-medium">顺序交接 · 同一个任务与总预算</h4>
          <ol className="mt-2 space-y-3">
            {detail.segments.map((segment) => (
              <li key={segment.segmentNo} className="space-y-1 break-words">
                <p>
                  第 {segment.segmentNo} 段 · {segment.name} ·{" "}
                  {segment.segmentNo === detail.activeSegment ? "当前执行段" : "已交接"}
                </p>
                <p className="text-xs text-muted-foreground">{segment.model}</p>
                {segment.brief && <p className="text-xs">交接说明：{segment.brief}</p>}
              </li>
            ))}
          </ol>
        </section>
      )}
      {active && detail.control?.mode === "human" && (
        <label className="mt-4 block space-y-2 text-sm">
          交还时的说明（可选）
          <Textarea
            aria-label="交还说明"
            value={handbackNote}
            onChange={(event) => setHandbackNote(event.target.value)}
            maxLength={4000}
            placeholder="例如已登录，请继续下载本周报表"
          />
        </label>
      )}
      {active && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {detail.control?.mode === "human" &&
          !detail.control.desiredMode &&
          takeoverRequest ? (
            <Button
              disabled={controlBusy}
              onClick={() =>
                controlAction(`/api/task-requests/${takeoverRequest.id}/respond`, {
                  decision: "handback",
                  payloadVersion: takeoverRequest.payloadVersion,
                  response: { note: handbackNote },
                })
              }
            >
              交还给 Agent
            </Button>
          ) : (
            detail.control && (
              <Button
                variant="secondary"
                disabled={
                  controlBusy ||
                  !!detail.control.desiredMode ||
                  ["quiescing", "quarantined"].includes(detail.control.mode) ||
                  !!detail.cancelRequestedAt
                }
                onClick={() =>
                  controlAction(`/api/tasks/${detail.id}/takeover`, {
                    requestId: crypto.randomUUID(),
                    reason: "拥有者请求接管桌面",
                  })
                }
              >
                {detail.control.desiredMode === "human" ||
                detail.control.mode === "quiescing"
                  ? "正在停止 Agent 输入…"
                  : "接管桌面"}
              </Button>
            )
          )}
          <Button
            variant="outline"
            disabled={controlBusy || !!detail.cancelRequestedAt}
            onClick={() => controlAction(`/api/tasks/${detail.id}/cancel`)}
          >
            {detail.cancelRequestedAt ? "正在停止实际操作…" : "取消任务"}
          </Button>
        </div>
      )}
      {!active && detail.configSnapshot.runtime !== "fixture" && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            variant={idleTakeover ? "default" : "secondary"}
            onClick={toggleIdleTakeover}
          >
            {idleTakeover ? "结束接管" : "接管桌面"}
          </Button>
        </div>
      )}
      {detail.configSnapshot.runtime !== "fixture" && (
        <Desktop
          key={detail.agentId}
          agentId={detail.agentId}
          epoch={detail.control?.epoch ?? 0}
          takeover={
            active
              ? detail.control?.mode === "human" && !detail.control.desiredMode
              : idleTakeover
          }
          enabled={
            !detail.control ||
            (["human", "agent", "idle"].includes(detail.control.mode) &&
              !detail.control.desiredMode)
          }
        />
      )}
      {active &&
        detail.requests
          .filter(
            (request) =>
              request.kind !== "takeover" &&
              ["pending", "decided"].includes(request.status)
          )
          .map((request) => (
            <TaskRequest
              key={request.id}
              request={request}
              busy={controlBusy}
              onRespond={(decision, response) =>
                controlAction(`/api/task-requests/${request.id}/respond`, {
                  decision,
                  response,
                  payloadVersion: request.payloadVersion,
                })
              }
            />
          ))}
      {!inConversation && typeof detail.result?.summary === "string" && (
        <article
          aria-label="交付结果"
          className="mt-5 rounded-xl border border-border bg-elevated/55 p-4 text-[14.5px] leading-7 break-words whitespace-pre-wrap sm:p-5"
        >
          {detail.result.summary}
        </article>
      )}
      {detail.workflowRun && (
        <section className="my-4 space-y-2 border-l-2 pl-4 text-sm">
          <h3 className="font-medium">
            {detail.workflowRun.purpose === "verify" ? "流程样例验证" : "固定流程执行"} ·
            步骤 {Math.min(detail.workflowRun.step + 1, detail.workflowRun.totalSteps)}/
            {detail.workflowRun.totalSteps}
          </h3>
          <p className="text-muted-foreground">
            {detail.workflowRun.repairStatus
              ? `局部修订：${({ requesting: "请求中", accepted: "已采用", rejected: "已停止" } as Record<string, string>)[detail.workflowRun.repairStatus]}`
              : detail.workflowRun.allowRepair
                ? "允许一次局部修订。"
                : "按固定计划执行。"}
          </p>
          {detail.workflowRun.draftVersionId && <p>修订草稿待验证。</p>}
          {detail.workflowRun.blockedReason && (
            <p className="break-words">停止原因：{detail.workflowRun.blockedReason}</p>
          )}
          <Link href="/workflows" className="underline underline-offset-4">
            查看流程版本
          </Link>
        </section>
      )}
      {detail.status === "completed" && (
        <Link
          href={
            detail.result?.manualDraft
              ? "/manuals"
              : `/manuals?source=${encodeURIComponent(detail.id)}`
          }
          className="block text-sm underline underline-offset-4"
        >
          {detail.result?.manualDraft ? "审阅操作手册草稿" : "生成操作手册"}
        </Link>
      )}
      {detail.status === "completed" &&
        !!(detail.result?.workflow || detail.result?.directoryTree) && (
          <Link
            href={
              detail.result?.workflow
                ? "/workflows"
                : `/workflows?source=${encodeURIComponent(detail.id)}`
            }
            className="block text-sm underline underline-offset-4"
          >
            {detail.result?.workflow ? "查看流程候选" : "保存为流程"}
          </Link>
        )}
      {!!detail.result?.comparison && (
        <ReportComparison result={detail.result.comparison as ComparisonResult} />
      )}
      {detail.paymentResults.map((result, index) => (
        <PaymentResultEvidence key={index} result={result} />
      ))}
      {detail.usage.decisions > 0 && (
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          {detail.usage.decisions} 个模型决定 · 已知估算费用 $
          {(Number(detail.usage.known_cost_micros) / 1000000).toFixed(6)}
          {detail.usage.unknown_cost_attempts > 0
            ? ` · ${detail.usage.unknown_cost_attempts} 次费用未知`
            : ""}
          {detail.usage.uncertain_attempts > 0
            ? ` · ${detail.usage.uncertain_attempts} 次请求未获完整回执`
            : ""}
        </p>
      )}
      <details className="my-5">
        <summary className="cursor-pointer text-sm text-muted-foreground">
          执行记录（{events.length}）
        </summary>
        <ol className="my-6 space-y-4" aria-live="polite">
          {events.map((event) => (
            <li key={event.seq} className="flex gap-4 text-sm">
              <span className="w-5 shrink-0 text-muted-foreground">{event.seq}</span>
              <div>
                <span className="font-medium">{event.type}</span>
                <p className="mt-1 break-words text-muted-foreground">
                  {String(
                    event.payload.message ??
                      event.payload.summary ??
                      event.payload.text ??
                      event.payload.goal ??
                      event.payload.error ??
                      ""
                  )}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </details>
      {detail.error && (
        <p role="alert" className="text-sm text-destructive">
          {detail.error}
        </p>
      )}
      {detail.artifacts.map((file) => (
        <div
          key={file.id}
          className="flex items-center justify-between gap-3 border-t border-border py-4"
        >
          <div>
            <a
              className="text-sm font-medium break-all underline underline-offset-4"
              href={`/api/artifacts/${file.id}`}
            >
              {file.name}
            </a>
            <p className="mt-1 text-xs text-muted-foreground">
              {file.size} 字节 ·{" "}
              {file.verification.grade === "program_checked"
                ? "程序已核对"
                : file.verification.grade === "file_copied"
                  ? "文件已提取"
                  : file.verification.grade}
            </p>
          </div>
          <a className="text-sm underline" href={`/api/artifacts/${file.id}`}>
            下载
          </a>
        </div>
      ))}
    </section>
  )
}
