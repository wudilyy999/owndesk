"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  manualMarkdown,
  manualCompilationInputSchema,
  manualDraftSchema,
  type Manual,
  type ManualCompilation,
  type ManualDraft,
} from "@/lib/manual-schema"

const field = "block w-full rounded-lg border border-input bg-background p-2.5 text-sm"
async function api(path: string, body: unknown, method = "POST") {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error)
  return result
}

async function submitNewTask(storageKey: string, payload: Record<string, unknown>) {
  const serialized = JSON.stringify(payload)
  const saved = sessionStorage.getItem(storageKey)
  const pending = saved
    ? JSON.parse(saved)
    : { payload: serialized, clientRequestId: crypto.randomUUID() }
  if (pending.payload !== serialized)
    throw new Error("上次提交尚未确认。请保持原输入重试受理，或先到任务列表处理原任务。")
  sessionStorage.setItem(storageKey, JSON.stringify(pending))
  const result = await api("/api/tasks", {
    ...payload,
    clientRequestId: pending.clientRequestId,
  })
  sessionStorage.removeItem(storageKey)
  return result
}

export function ManualDraftForm({ source }: { source: { id: string; agentId: string } }) {
  const router = useRouter()
  const [name, setName] = useState("")
  const [purpose, setPurpose] = useState("")
  const [parameters, setParameters] = useState<
    { name: string; label: string; sourceValue: string }[]
  >([])
  const [preview, setPreview] = useState<ManualCompilation | null>(null)
  const [reviewed, setReviewed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const storageKey = `personal-agent:manual-compile:${source.id}`
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey)
      if (!saved) return
      const input = manualCompilationInputSchema.parse(
        JSON.parse(JSON.parse(saved).payload).manualCompilation
      )
      if (input.sourceTaskId !== source.id) throw new Error("本地受理记录与来源任务不符")
      setName(input.name)
      setPurpose(input.purpose)
      setParameters(input.parameters)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [source.id, storageKey])
  const change = () => {
    setPreview(null)
    setReviewed(false)
  }
  return (
    <form
      aria-label="生成操作手册"
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError("")
        try {
          const input = {
            sourceTaskId: source.id,
            name,
            purpose,
            parameters,
            reviewed: true,
          }
          if (!preview) {
            setPreview(await api("/api/manuals/preview", input))
            return
          }
          if (!reviewed) throw new Error("请先审阅将发送给模型的依据")
          const payload = {
            agentId: source.agentId,
            goal: `生成操作手册：${name}`,
            manualCompilation: input,
            budget: { maxSteps: 4 },
          }
          const result = await submitNewTask(storageKey, payload)
          router.push(`/?task=${encodeURIComponent(result.taskId)}`)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }}
    >
      <label className="block space-y-1.5">
        手册名称
        <input
          className={field}
          required
          maxLength={100}
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            change()
          }}
        />
      </label>
      <label className="block space-y-1.5">
        要保留的做法
        <textarea
          className={field}
          required
          maxLength={2000}
          rows={3}
          placeholder="描述适用场景和目标，例如：进入报表页面，按月份筛选并下载 CSV。不要填写密码或验证码。"
          value={purpose}
          onChange={(e) => {
            setPurpose(e.target.value)
            change()
          }}
        />
      </label>
      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium">可替换输入（可选）</legend>
        {parameters.map((parameter, index) => (
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_2fr_auto]" key={index}>
            {(["name", "label", "sourceValue"] as const).map((key) => (
              <input
                key={key}
                required
                className={field}
                aria-label={`${index + 1} ${key}`}
                placeholder={
                  {
                    name: "参数名，如 month",
                    label: "名称，如月份",
                    sourceValue: "本次实际值，用于匹配；不会发送原值",
                  }[key]
                }
                value={parameter[key]}
                onChange={(e) => {
                  setParameters((all) =>
                    all.map((p, i) => (i === index ? { ...p, [key]: e.target.value } : p))
                  )
                  change()
                }}
              />
            ))}
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setParameters((all) => all.filter((_, i) => i !== index))
                change()
              }}
            >
              移除
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={parameters.length >= 8}
          onClick={() => {
            setParameters((all) => [...all, { name: "", label: "", sourceValue: "" }])
            change()
          }}
        >
          添加输入
        </Button>
      </fieldset>
      <p className="text-sm leading-6 text-muted-foreground">
        先预览清洗后的操作依据，再请求模型生成草稿。原截图、页面全文、终端命令及未声明的输入值不发送。模型生成会产生
        API 费用；保存手册还需要单独审阅。
      </p>
      {preview && (
        <div className="space-y-3 border-l-2 border-primary/30 pl-4">
          <details open>
            <summary className="cursor-pointer text-sm">将发送给模型的依据</summary>
            <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-3 text-xs break-all whitespace-pre-wrap">
              {JSON.stringify(preview, null, 2)}
            </pre>
          </details>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            我已审阅上述内容，允许请求模型生成草稿。
          </label>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm break-words text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || (!!preview && !reviewed)}>
        {busy ? "处理中…" : preview ? "生成手册草稿" : "预览生成依据"}
      </Button>
    </form>
  )
}

export function ManualEditor({ id, draft }: { id: string; draft: ManualDraft }) {
  const router = useRouter()
  const [value, setValue] = useState(draft)
  const [reviewed, setReviewed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const storageKey = `personal-agent:manual-edit:${id}`
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey)
      if (saved) setValue(manualDraftSchema.parse(JSON.parse(saved)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [storageKey])
  function edit(key: keyof ManualDraft, text: string) {
    const next = { ...value, [key]: text }
    setValue(next)
    setReviewed(false)
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <form
      aria-label="审阅操作手册"
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError("")
        try {
          await api("/api/manuals", { draftTaskId: id, reviewed, draft: value })
          sessionStorage.removeItem(storageKey)
          router.refresh()
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setBusy(false)
        }
      }}
    >
      <label className="block space-y-1.5">
        手册名称
        <input
          className={field}
          required
          maxLength={100}
          value={value.name}
          onChange={(e) => edit("name", e.target.value)}
        />
      </label>
      <label className="block space-y-1.5">
        何时使用
        <textarea
          className={field}
          required
          maxLength={500}
          rows={2}
          value={value.description}
          onChange={(e) => edit("description", e.target.value)}
        />
      </label>
      <label className="block space-y-1.5">
        操作步骤与结果检查
        <textarea
          className={`${field} leading-7`}
          required
          maxLength={12000}
          rows={14}
          value={value.body}
          onChange={(e) => edit("body", e.target.value)}
        />
      </label>
      <label className="flex items-start gap-2 text-sm leading-6">
        <input
          className="mt-1"
          type="checkbox"
          checked={reviewed}
          onChange={(e) => setReviewed(e.target.checked)}
        />
        我已审阅并移除秘密和过期坐标，允许 Agent
        在相关新任务中按需参考。原任务成功不代表手册已验证。
      </label>
      {error && (
        <p role="alert" className="text-sm break-words text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={!reviewed || busy}>
        {busy ? "保存中…" : "保存并启用手册"}
      </Button>
    </form>
  )
}

export function ManualActions({
  manual,
  agents,
}: {
  manual: Manual
  agents: { id: string; name: string }[]
}) {
  const router = useRouter()
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "")
  const [goal, setGoal] = useState("")
  const [desktop, setDesktop] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const storageKey = `personal-agent:manual-run:${manual.id}`
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey)
      if (!saved) return
      const input = JSON.parse(JSON.parse(saved).payload)
      setAgentId(input.agentId)
      setGoal(input.goal)
      setDesktop(input.workstationChannel === "desktop")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [storageKey])
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError("")
            try {
              await api(
                "/api/manuals",
                { id: manual.id, enabled: !manual.enabled },
                "PATCH"
              )
              router.refresh()
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause))
            } finally {
              setBusy(false)
            }
          }}
        >
          {manual.enabled ? "停用手册" : "启用手册"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([manualMarkdown(manual)], { type: "text/markdown;charset=utf-8" })
            )
            const link = document.createElement("a")
            link.href = url
            link.download = "SKILL.md"
            link.click()
            URL.revokeObjectURL(url)
          }}
        >
          下载 SKILL.md
        </Button>
      </div>
      {manual.enabled && (
        <details>
          <summary className="cursor-pointer text-sm underline underline-offset-4">
            用这份手册开始新任务
          </summary>
          <form
            className="mt-4 space-y-3"
            onSubmit={async (event) => {
              event.preventDefault()
              setBusy(true)
              setError("")
              try {
                const result = await submitNewTask(storageKey, {
                  agentId,
                  goal,
                  manualId: manual.id,
                  ...(desktop ? { workstationChannel: "desktop" } : {}),
                })
                router.push(`/?task=${encodeURIComponent(result.taskId)}`)
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause))
              } finally {
                setBusy(false)
              }
            }}
          >
            <label className="block space-y-1.5">
              执行 Agent
              <select
                className={field}
                required
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5">
              本次目标和输入
              <textarea
                className={field}
                rows={3}
                required
                maxLength={16000}
                placeholder={
                  manual.parameters.map((p) => `${p.label}（${p.name}）`).join("、") ||
                  "填写这次要完成的事"
                }
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={desktop}
                onChange={(e) => setDesktop(e.target.checked)}
              />
              仅使用桌面截图和键鼠操作
            </label>
            <p className="text-sm text-muted-foreground">
              会创建新任务并请求模型，重新观察电脑、执行操作和检查结果；不会重放旧点击或沿用旧授权。
            </p>
            <Button type="submit" disabled={busy || !agentId}>
              {busy ? "受理中…" : "开始新任务"}
            </Button>
          </form>
        </details>
      )}
      {error && (
        <p role="alert" className="text-sm break-words text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
