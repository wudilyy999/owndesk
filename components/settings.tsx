"use client"
// SourceBadge and SecretInput reused from the pinned MIT upstream's pinned settings form (MIT).
import { useEffect, useState } from "react"
import Link from "next/link"
import { KeyRoundIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { providers, type ProviderId } from "@/lib/providers/catalog"
import type { SettingView } from "@/lib/config"
import { cn } from "@/lib/utils"
import { MemoryPanel } from "@/components/memory"
import { TelegramPanel } from "@/components/telegram"
import { VaultPanel } from "@/components/vault"
import { AgentZeroPlugins } from "@/components/agent-zero-plugins"

function SourceBadge({
  setting,
  unset = "未设置",
}: {
  setting: SettingView
  unset?: string
}) {
  if (!setting.source)
    return <span className="font-mono text-[10px] text-faint">{unset}</span>
  const tone =
    setting.source === "local"
      ? "border-rigel/30 text-rigel"
      : setting.source === "env"
        ? "border-ok/30 text-ok"
        : "text-faint"
  const label =
    setting.source === "local"
      ? "已保存"
      : setting.source === "env"
        ? "环境变量"
        : "default"
  return (
    <span
      title={setting.env ? `Environment variable: ${setting.env}` : undefined}
      className={cn("rounded-sm border px-1.5 py-px font-mono text-[10px]", tone)}
    >
      {label}
    </span>
  )
}

function SecretInput({
  setting,
  value,
  onChange,
  placeholder,
}: {
  setting: SettingView
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <div className="relative">
      <KeyRoundIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={
          setting.value ? `${setting.value}  （留空保留）` : (placeholder ?? "Paste key")
        }
        className="h-8 w-full rounded-lg border border-input bg-transparent pr-2.5 pl-8 font-mono text-[12px] outline-none placeholder:text-faint focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 dark:bg-input/30"
      />
    </div>
  )
}

type EditableAgent = {
  id: string
  name: string
  role: string
  model: string
  instructions: string
}
export function Settings({
  initialSettings,
  agents,
}: {
  initialSettings: SettingView[]
  agents: EditableAgent[]
}) {
  const [settings, setSettings] = useState(initialSettings)
  const [provider, setProvider] = useState<ProviderId>(
    providers.find((p) =>
      initialSettings.some(
        (setting) => setting.key === `provider.${p.id}.apiKey` && setting.set
      )
    )?.id ?? "custom"
  )
  const [key, setKey] = useState(""),
    [endpoint, setEndpoint] = useState("")
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("")
  const [editing, setEditing] = useState("new")
  const [agentRows, setAgentRows] = useState(agents)
  const [identity, setIdentity] = useState({
    name: "",
    role: "",
    model: "",
    instructions: "",
  })
  const view = (name: string) => settings.find((setting) => setting.key === name)!
  const meta = providers.find((p) => p.id === provider)!
  useEffect(() => {
    setKey("")
    setEndpoint(view(`provider.${provider}.baseUrl`).value ?? "")
  }, [provider])
  useEffect(() => {
    const row = agentRows.find((agent) => agent.id === editing)
    setIdentity(
      row
        ? {
            name: row.name,
            role: row.role,
            model: row.model,
            instructions: row.instructions,
          }
        : { name: "", role: "", model: "", instructions: "" }
    )
  }, [editing, agentRows])
  async function save(values: { key: string; value: string | null }[]) {
    setBusy(true)
    setMessage("")
    setError("")
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      setSettings((previous) =>
        previous.map(
          (setting) =>
            result.find((updated: SettingView) => updated.key === setting.key) ?? setting
        )
      )
      setKey("")
      setMessage("配置已保存。新任务使用最新配置，已受理任务保留自己的配置快照。")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="mx-auto max-w-3xl space-y-7 px-6 py-10">
      <header>
        <Link href="/" className="text-sm underline underline-offset-4">
          返回工作现场
        </Link>
        <h1 className="mt-5 text-2xl font-semibold">模型与 Agent</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          配置模型后创建一个
          Agent。它会在服务器的独立桌面里工作，密钥加密保存，发送模型请求时使用。
        </p>
      </header>
      {error && (
        <p
          role="alert"
          className="rounded border border-destructive/30 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <form
        className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6"
        onSubmit={(event) => {
          event.preventDefault()
          void save([
            { key: `provider.${provider}.baseUrl`, value: endpoint || null },
            ...(key.trim() ? [{ key: `provider.${provider}.apiKey`, value: key }] : []),
          ])
        }}
      >
        <h2 className="text-lg font-medium">模型服务</h2>
        <fieldset disabled={busy} className="space-y-4">
          <label className="block space-y-2 text-sm">
            服务商
            <select
              aria-label="模型服务商"
              className="block w-full rounded border border-input bg-background px-3 py-2"
              value={provider}
              onChange={(event) => setProvider(event.target.value as ProviderId)}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-2 text-sm">
            <span>
              API Key <SourceBadge setting={view(`provider.${provider}.apiKey`)} />
            </span>
            <SecretInput
              setting={view(`provider.${provider}.apiKey`)}
              value={key}
              onChange={setKey}
              placeholder={meta.requiresKey ? "输入 API Key" : "此服务可不填密钥"}
            />
          </label>
          <label className="block space-y-2 text-sm">
            <span>
              API 地址 <SourceBadge setting={view(`provider.${provider}.baseUrl`)} />
            </span>
            <Input
              aria-label="API 地址"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder={meta.defaultBaseUrl || "https://your-provider.example/v1"}
            />
          </label>
          <p className="text-xs leading-5 text-muted-foreground">
            保留密钥输入框为空会沿用已有密钥。自定义与本地服务需要填写可达地址；本地模型需要已启动且支持相应工具或视觉能力。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit">保存服务配置</Button>
            {view(`provider.${provider}.apiKey`).source === "local" && (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  save([{ key: `provider.${provider}.apiKey`, value: null }])
                }
              >
                移除已保存密钥
              </Button>
            )}
          </div>
        </fieldset>
      </form>
      <form
        className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6"
        onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          void save([
            { key: "model.default", value: String(form.get("model")) || null },
            { key: "agent.maxSteps", value: String(form.get("maxSteps")) },
          ])
        }}
      >
        <h2 className="text-lg font-medium">默认模型与步骤限制</h2>
        <label className="block space-y-2 text-sm">
          默认模型
          <Input
            key={view("model.default").value}
            name="model"
            aria-label="默认模型"
            defaultValue={view("model.default").value ?? ""}
            placeholder={`${provider}/模型名称`}
          />
        </label>
        <label className="block space-y-2 text-sm">
          每任务步骤上限
          <Input
            name="maxSteps"
            aria-label="每任务步骤上限"
            type="number"
            min={1}
            max={200}
            defaultValue={view("agent.maxSteps").value ?? "40"}
            required
          />
        </label>
        <p className="text-xs leading-5 text-muted-foreground">
          模型使用 provider/model
          格式。任务达到步骤限制会等待你追加额度，不会把未完成工作标成成功。
        </p>
        <Button type="submit" disabled={busy}>
          保存默认配置
        </Button>
      </form>
      <form
        className="space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6"
        onSubmit={async (event) => {
          event.preventDefault()
          setBusy(true)
          setError("")
          setMessage("")
          try {
            const response = await fetch(
              editing === "new" ? "/api/agents" : `/api/agents/${editing}`,
              {
                method: editing === "new" ? "POST" : "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(identity),
              }
            )
            const result = await response.json()
            if (!response.ok) throw new Error(result.error)
            const updated = {
              id: result.id,
              name: result.name,
              role: result.role,
              model: result.model ?? "",
              instructions: result.instructions ?? "",
            }
            setAgentRows((previous) => [
              ...previous.filter((agent) => agent.id !== updated.id),
              updated,
            ])
            setEditing(updated.id)
            setMessage("Agent 已保存。返回工作现场后可以选择它并下达任务。")
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          } finally {
            setBusy(false)
          }
        }}
      >
        <h2 className="text-lg font-medium">创建与编辑 Agent</h2>
        <fieldset disabled={busy} className="space-y-4">
          <label className="block space-y-2 text-sm">
            选择 Agent
            <select
              aria-label="编辑 Agent"
              className="block w-full rounded border border-input bg-background px-3 py-2"
              value={editing}
              onChange={(event) => setEditing(event.target.value)}
            >
              <option value="new">创建新 Agent</option>
              {agentRows.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-2 text-sm">
            名称
            <Input
              aria-label="Agent 名称"
              value={identity.name}
              onChange={(event) => setIdentity({ ...identity, name: event.target.value })}
              required
              maxLength={40}
            />
          </label>
          <label className="block space-y-2 text-sm">
            职责
            <Input
              aria-label="Agent 职责"
              value={identity.role}
              onChange={(event) => setIdentity({ ...identity, role: event.target.value })}
              required
              maxLength={120}
            />
          </label>
          <label className="block space-y-2 text-sm">
            专用模型
            <Input
              aria-label="Agent 专用模型"
              value={identity.model}
              onChange={(event) =>
                setIdentity({ ...identity, model: event.target.value })
              }
              placeholder="留空使用默认模型"
            />
          </label>
          <label className="block space-y-2 text-sm">
            长期指令
            <Textarea
              aria-label="Agent 长期指令"
              value={identity.instructions}
              onChange={(event) =>
                setIdentity({ ...identity, instructions: event.target.value })
              }
              maxLength={6000}
            />
          </label>
          <Button type="submit">{editing === "new" ? "创建 Agent" : "保存 Agent"}</Button>
        </fieldset>
      </form>
      {editing !== "new" && <MemoryPanel key={editing} agentId={editing} />}
      <AgentZeroPlugins />
      <TelegramPanel agents={agentRows} />
      <VaultPanel />
    </main>
  )
}
