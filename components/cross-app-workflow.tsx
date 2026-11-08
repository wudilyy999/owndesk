"use client"
import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
export function CrossAppWorkflow({ agents }: { agents: { id: string; name: string }[] }) {
  const router = useRouter(),
    [agentId, setAgentId] = useState(agents[0]?.id ?? ""),
    [source, setSource] = useState("Browser"),
    [text, setText] = useState(""),
    [reviewed, setReviewed] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false)
  const pending = useRef<{ text: string; key: string } | null>(null)
  async function post(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    return result
  }
  return (
    <section aria-label="跨应用流程" className="space-y-3 rounded border p-4">
      <h2 className="font-medium">创建跨应用流程</h2>
      <p className="text-xs">
        选择工作站生成模板，按当前软件语言填写准确窗口标题、步骤和 CSV
        验收条件。验证三个不同参数样例后即可复用。
      </p>
      <select
        aria-label="模板工作站"
        value={agentId}
        onChange={(event) => setAgentId(event.target.value)}
      >
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
      <select
        aria-label="来源应用"
        value={source}
        onChange={(event) => setSource(event.target.value)}
      >
        <option value="Browser">浏览器 → CSV</option>
        <option value="Writer">Writer → CSV</option>
      </select>
      <Button
        disabled={busy || !agentId}
        onClick={async () => {
          setBusy(true)
          setError("")
          try {
            setText(
              JSON.stringify(
                await post("/api/workflows/template", { agentId, source }),
                null,
                2
              )
            )
            setReviewed(false)
          } catch (cause) {
            setError(String(cause))
          } finally {
            setBusy(false)
          }
        }}
      >
        生成浏览器与办公模板
      </Button>
      {text && (
        <>
          <textarea
            aria-label="跨应用流程 JSON"
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setReviewed(false)
            }}
            rows={18}
            className="w-full rounded border p-2 font-mono text-xs"
          />
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            已审阅步骤、输入和结果检查
          </label>
          <Button
            disabled={busy || !reviewed}
            onClick={async () => {
              setBusy(true)
              setError("")
              try {
                if (pending.current?.text !== text)
                  pending.current = { text, key: crypto.randomUUID() }
                await post("/api/workflows/import", {
                  clientRequestId: pending.current.key,
                  reviewed: true,
                  package: JSON.parse(text),
                })
                setText("")
                router.refresh()
              } catch (cause) {
                setError(String(cause))
              } finally {
                setBusy(false)
              }
            }}
          >
            保存待验证候选
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
