"use client"
import { useActionState } from "react"
import { previewGoogle, updateLibrary, projectAction } from "@/app/library/actions"
export function GoogleImport({
  connections,
  people,
}: {
  people: { id: string; name: string }[]
  connections: { id: string; name: string }[]
}) {
  const [state, action, pending] = useActionState(previewGoogle, {
    drafts: [],
    message: "",
  })
  return (
    <details className="space-y-3 rounded-xl border p-4">
      <summary>从 Gmail 或 Google 日历挑选资料</summary>
      {connections.length ? (
        <>
          <form action={action} className="flex flex-wrap gap-2">
            <select name="connection" aria-label="Google 连接">
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select name="kind" aria-label="外部资料类型">
              <option value="mail">邮件正文</option>
              <option value="calendar">未来七天的日程</option>
            </select>
            <input
              name="query"
              maxLength={180}
              aria-label="邮件搜索条件"
              placeholder="邮件搜索条件（可留空）"
            />
            <button disabled={pending}>{pending ? "正在读取…" : "预览"}</button>
          </form>
          <p role="status">{state.message}</p>
          {state.drafts.map((d, i) => (
            <div key={d.origin + d.title + i}>
              <form className="grid gap-2 border-t py-2" action={updateLibrary}>
                <input type="hidden" name="action" value="save" />
                <input
                  name="title"
                  aria-label="导入标题"
                  defaultValue={d.title}
                  maxLength={180}
                />
                <textarea
                  name="body"
                  aria-label="导入正文"
                  defaultValue={[d.body, d.origin].filter(Boolean).join("\n")}
                  maxLength={8000}
                />
                <select aria-label="保存为" name="kind">
                  <option value="note">共享笔记</option>
                  <option value="followup">待跟进</option>
                </select>
                <button>保存这一条</button>
              </form>
              {d.thread && (
                <form action={projectAction} className="grid gap-2 border-t py-2">
                  <input type="hidden" name="action" value="watch" />
                  <input type="hidden" name="thread" value={d.thread} />
                  <input type="hidden" name="connection" value={d.connection} />
                  <label>
                    项目名称{" "}
                    <input name="title" required maxLength={180} defaultValue={d.title} />
                  </label>
                  <label>
                    未回复时的提醒日期 <input name="due" type="date" />
                  </label>
                  <label>
                    提醒到{" "}
                    <select name="agent">
                      <option value="">只记在清单</option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <small>
                    将此邮件会话的正文与后续回复共享给你的助手；收到新回复时结束催办。
                  </small>
                  <button>跟踪此会话</button>
                </form>
              )}
            </div>
          ))}
        </>
      ) : (
        <a className="underline" href="/settings">
          去设置连接 Google 账号
        </a>
      )}
    </details>
  )
}
