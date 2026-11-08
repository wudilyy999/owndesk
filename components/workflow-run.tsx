"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  workflowExecutionInputSchema,
  type WorkflowParameter,
} from "@/lib/workflow-schema"

export function WorkflowRunForm({
  version,
  agents,
}: {
  version: {
    id: string
    name: string
    status: "draft" | "verifying" | "ready"
    parameters: WorkflowParameter[]
  }
  agents: { id: string; name: string }[]
}) {
  const router = useRouter()
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "")
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(version.parameters.map((p) => [p.name, ""]))
  )
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [allowRepair, setAllowRepair] = useState(false)
  const verifying = version.status !== "ready"
  const pending = useRef<{ key: string; payload: string } | null>(null)
  const storageKey = `personal-agent:workflow-run:${version.id}`
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey)
      if (!saved) return
      const record = JSON.parse(saved)
      if (typeof record.key !== "string" || typeof record.payload !== "string")
        throw new Error("本地流程提交记录损坏，请清理本站会话存储后重试")
      const payload = JSON.parse(record.payload)
      const execution = workflowExecutionInputSchema.parse(payload.workflowExecution)
      if (execution.versionId !== version.id || typeof payload.agentId !== "string")
        throw new Error("本地提交记录与流程版本不符")
      setAgentId(payload.agentId)
      setValues(execution.parameters)
      setAllowRepair(execution.allowRepair === true)
      pending.current = record
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [storageKey, version.id])
  return (
    <form
      aria-label={verifying ? "验证流程样例" : "运行已验证流程"}
      className="space-y-4 border-l-2 pl-4"
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError("")
        try {
          const payload = {
            agentId,
            goal: `${verifying ? "验证" : "运行"}流程：${version.name}`,
            workflowExecution: {
              versionId: version.id,
              purpose: verifying ? "verify" : "run",
              parameters: values,
              maxActions: 120,
              maxDurationSeconds: 300,
              ...(allowRepair ? { allowRepair: true } : {}),
            },
            budget: allowRepair ? { maxSteps: 1 } : { maxSteps: 1, maxCostMicros: 0 },
          }
          const serialized = JSON.stringify(payload)
          if (pending.current?.payload !== serialized)
            pending.current = { key: crypto.randomUUID(), payload: serialized }
          sessionStorage.setItem(storageKey, JSON.stringify(pending.current))
          const response = await fetch("/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...payload, clientRequestId: pending.current.key }),
          })
          const result = await response.json()
          if (!response.ok) throw new Error(result.error)
          sessionStorage.removeItem(storageKey)
          router.push(`/?task=${encodeURIComponent(result.taskId)}`)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }}
    >
      <h4 className="font-medium">{verifying ? "用新样例验证" : "运行此版本"}</h4>
      <label className="block space-y-1 text-sm">
        执行工作站
        <select
          aria-label="执行工作站"
          required
          className="block w-full rounded border border-input bg-background p-2"
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
        >
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      {version.parameters.map((parameter) => (
        <label key={parameter.name} className="block space-y-1 text-sm">
          {parameter.label}（{parameter.name}）
          <input
            required
            minLength={1}
            maxLength={180}
            value={values[parameter.name] ?? ""}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                [parameter.name]: event.target.value,
              }))
            }
            placeholder={`示例：${parameter.sourceValue}`}
            className="block w-full rounded border border-input bg-background p-2"
          />
        </label>
      ))}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={allowRepair}
          onChange={(event) => setAllowRepair(event.target.checked)}
          className="mt-1"
        />
        允许一次局部修订（界面条件失效时请求所选工作站的模型，可能产生费用；遵守全局预算）
      </label>
      <p className="text-sm text-muted-foreground">
        每次使用新的输出文件或目录名。固定步骤不请求模型；最多120个动作、5分钟。未知效果始终停止复核。修订成功后另存草稿，原版本保持不变。
        {verifying
          ? "通过3组不同参数的独立检查后启用该版本。"
          : "结果继续由固定文件或目录检查器核对。"}
      </p>
      {error && (
        <p role="alert" className="text-sm break-words text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || !agentId}>
        {busy ? "受理中…" : verifying ? "验证这个样例" : "执行流程"}
      </Button>
    </form>
  )
}
