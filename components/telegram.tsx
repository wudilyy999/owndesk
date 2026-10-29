"use client"
// Pairing steps/token input adapted from the pinned MIT upstream components/settings/telegram-panel.tsx (MIT).
// Uses the existing settings visual language and the new durable transport status API.
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import type { TelegramStatus } from "@/lib/telegram/state"

export function TelegramPanel({
  agents,
}: {
  agents: { id: string; name: string; model: string }[]
}) {
  const [panel, setPanel] = useState<TelegramStatus | null>(null)
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [rosterDraft, setRosterDraft] = useState<{
    generation: string
    agentId: string
    ids: string[]
  } | null>(null)
  const draft =
    panel &&
    rosterDraft?.generation === panel.generation &&
    rosterDraft.agentId === panel.agentId
      ? rosterDraft
      : null
  const rosterIds = draft?.ids ?? panel?.delegateAgentIds ?? []
  useEffect(() => {
    const controller = new AbortController()
    async function refresh() {
      try {
        const response = await fetch("/api/telegram", { signal: controller.signal })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error)
        setPanel(result)
      } catch (error) {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : String(error))
      }
    }
    void refresh()
    const timer = setInterval(refresh, 5000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [])
  async function change(input: Record<string, unknown>) {
    setBusy(true)
    setError("")
    try {
      const response = await fetch("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      setPanel(result)
      setRosterDraft(null)
      if (input.action === "token") setToken("")
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      aria-label="Telegram 远程入口"
      className="space-y-5 rounded-2xl border border-border bg-surface p-5 shadow-2xs sm:p-6"
    >
      <div>
        <h2 className="text-lg font-medium">Telegram 远程入口</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          在手机交办任务、接收结果和回答问题。桌面接管、文件下载与追加预算打开同一个网页完成。
        </p>
      </div>
      {error && (
        <p role="alert" aria-label="Telegram 错误" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          void change({ action: "token", token })
        }}
      >
        <label className="block space-y-2 text-sm">
          从 @BotFather 创建机器人，填入 Bot Token
          <input
            aria-label="Telegram Bot Token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={
              panel?.configured ? "已配置；填写新 Token 会解除原配对" : "123456789:…"
            }
            className="block w-full rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-sm"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !token.trim()}>
            保存 Telegram Token
          </Button>
          {panel?.configured && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void change({ action: "token", token: null })}
            >
              移除本地 Token 并解除配对
            </Button>
          )}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          Token
          加密存储。环境变量仍有配置时，移除本地值后会继续使用环境值；彻底停用需移除对应环境变量。
        </p>
      </form>
      {panel && (
        <fieldset disabled={busy} className="space-y-4">
          <p role="status" className="text-sm">
            {panel.bot
              ? `机器人：@${panel.bot.username ?? panel.bot.id}`
              : panel.configured
                ? "等待 worker 验证机器人"
                : "尚未配置机器人"}{" "}
            · {panel.paired ? `已配对 ${panel.paired.name}` : "尚未配对"}
          </p>
          {panel.error && (
            <p
              role="alert"
              aria-label="Telegram 连接错误"
              className="text-sm text-destructive"
            >
              {panel.error}
            </p>
          )}
          {panel.lastPollAt && (
            <p className="text-xs text-muted-foreground">
              上次轮询：{new Date(panel.lastPollAt).toLocaleString()}
            </p>
          )}
          {panel.configured && !panel.paired && (
            <div className="space-y-2 text-sm">
              {panel.pairCode ? (
                <>
                  <p>在 Telegram 私聊机器人，发送以下一次性口令（10 分钟有效）：</p>
                  <code
                    className="block rounded bg-muted p-3 font-mono break-all"
                    aria-label="Telegram 配对口令"
                  >
                    /pair {panel.pairCode}
                  </code>
                </>
              ) : (
                <p>生成一次性配对口令，再从你的 Telegram 私聊机器人。</p>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() => void change({ action: "rotate" })}
              >
                {panel.pairCode ? "重新生成配对口令" : "生成配对口令"}
              </Button>
            </div>
          )}
          {panel.paired && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void change({ action: "unpair" })}
            >
              解除 Telegram 配对
            </Button>
          )}
          <label className="block space-y-2 text-sm">
            手机默认 Agent
            <select
              aria-label="Telegram 默认 Agent"
              value={panel.agentId ?? ""}
              onChange={(event) =>
                void change({ action: "agent", agentId: event.target.value })
              }
              className="block w-full rounded border border-input bg-background px-3 py-2"
            >
              <option value="" disabled>
                选择 Agent
              </option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <form
            className="space-y-3 rounded-lg border p-3"
            aria-label="Telegram 交接权限"
            onSubmit={(event) => {
              event.preventDefault()
              if (draft)
                void change({
                  action: "roster",
                  generation: draft.generation,
                  agentId: draft.agentId,
                  delegateAgentIds: draft.ids,
                })
            }}
          >
            <h3 className="text-sm font-medium">手机任务允许交接的 Agent（默认关闭）</h3>
            <p className="text-xs leading-5 text-muted-foreground">
              每条已接收任务固定当时的名单，交接说明、文件及相关问答会发送到接手者的模型服务。
              修改只影响以后的消息；切换默认 Agent（含 /use）、重配对或更换 Token
              会清空名单。 /new 保留同一 Agent 的设置。停止已受理任务请使用 /stop
              或打开原任务取消。
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              {[
                ...agents.filter((agent) => agent.model !== "fixture/durable-report"),
                ...rosterIds
                  .filter(
                    (id) =>
                      !agents.some(
                        (agent) =>
                          agent.id === id && agent.model !== "fixture/durable-report"
                      )
                  )
                  .map((id) => ({ id, name: `不可用 Agent：${id}（取消勾选后保存）` })),
              ].map((agent) => (
                <label key={agent.id} className="flex items-center gap-2 break-all">
                  <input
                    type="checkbox"
                    disabled={
                      !panel.agentId ||
                      agents.find((agent) => agent.id === panel.agentId)?.model ===
                        "fixture/durable-report"
                    }
                    checked={rosterIds.includes(agent.id)}
                    onChange={(event) =>
                      setRosterDraft({
                        generation: panel.generation,
                        agentId: panel.agentId!,
                        ids: event.target.checked
                          ? [...rosterIds, agent.id]
                          : rosterIds.filter((id) => id !== agent.id),
                      })
                    }
                  />
                  {agent.name}
                </label>
              ))}
            </div>
            <Button type="submit" variant="outline" disabled={!draft}>
              保存手机交接权限
            </Button>
            <p className="text-xs text-muted-foreground">
              已保存：
              {panel.delegateAgentIds.length
                ? panel.delegateAgentIds
                    .map((id) => agents.find((agent) => agent.id === id)?.name ?? id)
                    .join("、")
                : "关闭"}
            </p>
          </form>
          <p className="text-xs leading-5 text-muted-foreground">
            只接受已配对账号的私聊。/new 新对话，/stop
            停止当前任务；回复问题通知即可作答。不要发送密码或验证码。
          </p>
          {!!panel.notices.length && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium">需要核对的通知</h3>
              {panel.notices.map((notice) => (
                <div
                  key={notice.id}
                  className="space-y-2 border-l-2 border-betelgeuse pl-3 text-sm"
                >
                  <p>
                    {notice.status === "unknown"
                      ? "发送结果未知，消息可能已经到达。"
                      : "Telegram 明确拒绝发送。"}
                  </p>
                  <p className="text-xs break-words text-muted-foreground">
                    {notice.last_error}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      void change({
                        action: "retry",
                        id: notice.id,
                        acknowledgeDuplicate: true,
                      })
                    }
                  >
                    我已核对，允许重发（可能重复）
                  </Button>
                </div>
              ))}
            </div>
          )}
        </fieldset>
      )}
    </section>
  )
}
