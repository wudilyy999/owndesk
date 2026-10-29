"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import type { CompletionContract } from "@/db/schema"
import { workflowCompilationInputSchema } from "@/lib/workflow-schema"

export function WorkflowCompilationForm({
  source,
}: {
  source: { id: string; agentId: string; completionContract: CompletionContract }
}) {
  const tree = source.completionContract.directoryTree!
  const router = useRouter()
  const [name, setName] = useState("创建并重命名目录")
  const [parameters, setParameters] = useState(
    [
      {
        name: "parentName",
        label: "父目录名",
        sourceValue: tree.root.split("/").at(-1)!,
      },
      ...tree.absent.map((value, index) => ({
        name: index ? `draftName${index}` : "draftName",
        label: "初始目录名",
        sourceValue: value,
      })),
      ...tree.directories.map((value, index) => ({
        name: index ? `readyName${index}` : "readyName",
        label: "最终目录名",
        sourceValue: value,
      })),
    ]
      .filter(
        (parameter, index, all) =>
          !parameter.sourceValue.includes("/") &&
          all.findIndex((p) => p.sourceValue === parameter.sourceValue) === index
      )
      .slice(0, 8)
      .map((parameter) => ({ ...parameter, enabled: true }))
  )
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const pending = useRef<{ key: string; payload: string } | null>(null)
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(`personal-agent:compile:${source.id}`)
      if (!saved) return
      const value: unknown = JSON.parse(saved)
      if (
        !value ||
        typeof value !== "object" ||
        !("key" in value) ||
        typeof value.key !== "string" ||
        !("payload" in value) ||
        typeof value.payload !== "string"
      )
        throw new Error("本地提交记录损坏，请清理本站会话存储后重试")
      const compilation = workflowCompilationInputSchema.parse(
        JSON.parse(value.payload).workflowCompilation
      )
      if (compilation.sourceTaskId !== source.id)
        throw new Error("本地提交记录与来源任务不符")
      pending.current = { key: value.key, payload: value.payload }
      setName(compilation.name)
      setParameters((all) =>
        all.map((parameter) => {
          const selected = compilation.parameters.find(
            (p) => p.sourceValue === parameter.sourceValue
          )
          return selected
            ? { ...selected, enabled: true }
            : { ...parameter, enabled: false }
        })
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [source.id])
  return (
    <form
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError("")
        try {
          const payload = {
            agentId: source.agentId,
            goal: `提炼流程：${name}`,
            workflowCompilation: {
              sourceTaskId: source.id,
              name,
              parameters: parameters
                .filter((p) => p.enabled)
                .map(({ enabled: _, ...parameter }) => parameter),
            },
            completionContract: source.completionContract,
            budget: { maxSteps: 4 },
          }
          const serialized = JSON.stringify(payload)
          const storageKey = `personal-agent:compile:${source.id}`
          const saved = sessionStorage.getItem(storageKey)
          if (saved) {
            const value: unknown = JSON.parse(saved)
            if (
              !value ||
              typeof value !== "object" ||
              !("key" in value) ||
              typeof value.key !== "string" ||
              !("payload" in value) ||
              typeof value.payload !== "string"
            )
              throw new Error("本地提交记录损坏，请清理本站会话存储后重试")
            if (value.payload === serialized)
              pending.current = { key: value.key, payload: value.payload }
          }
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
      <label className="block space-y-1">
        流程名称
        <input
          required
          maxLength={100}
          className="block w-full rounded border border-input bg-background p-2"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <fieldset className="space-y-3">
        <legend className="mb-2 font-medium">可替换的目录名</legend>
        {parameters.map((parameter, index) => (
          <div key={parameter.sourceValue} className="flex flex-wrap items-center gap-3">
            <label className="flex min-w-32 items-center gap-2">
              <input
                type="checkbox"
                checked={parameter.enabled}
                onChange={(event) =>
                  setParameters((all) =>
                    all.map((p, i) =>
                      i === index ? { ...p, enabled: event.target.checked } : p
                    )
                  )
                }
              />
              {parameter.label}
            </label>
            <input
              aria-label={`${parameter.label}参数名`}
              required={parameter.enabled}
              disabled={!parameter.enabled}
              pattern="[a-z][a-zA-Z0-9]{0,39}"
              className="min-w-0 flex-1 rounded border border-input bg-background p-2"
              value={parameter.name}
              onChange={(event) =>
                setParameters((all) =>
                  all.map((p, i) =>
                    i === index ? { ...p, name: event.target.value } : p
                  )
                )
              }
            />
            <code className="w-full text-sm break-all sm:w-auto">
              来源：{parameter.sourceValue}
            </code>
          </div>
        ))}
      </fieldset>
      <section className="space-y-2 border-l-2 pl-4">
        <h3 className="font-medium">固定结果检查</h3>
        <p className="text-sm break-all">检查目录：{tree.root}</p>
        <p className="text-sm">
          应存在：{tree.directories.join("、")}；应消失：{tree.absent.join("、") || "无"}
        </p>
      </section>
      <p className="text-sm text-muted-foreground">
        模型会收到清洗后的操作轨迹与所选目录名，生成候选会产生 API
        费用。原始截图、私有输入和旧控制引用不会加入编译请求。候选经过独立执行验证后才能启用。
      </p>
      {error && (
        <p role="alert" className="text-sm break-words text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || !parameters.some((p) => p.enabled)}>
        {busy ? "受理中…" : "生成流程候选"}
      </Button>
    </form>
  )
}
