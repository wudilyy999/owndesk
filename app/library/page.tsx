import { GoogleImport } from "@/components/library-google"
import { listConnections } from "@/lib/connections"
import Link from "next/link"
import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"
import { and, eq } from "drizzle-orm"
import { db } from "@/db"
import { libraryEntries, agents, companions } from "@/db/schema"
import { requireOwner } from "@/lib/auth"
import { HttpError } from "@/lib/errors"
import { listEntries, readSource, searchSources, sourceType } from "@/lib/library"
import { PageLayout } from "@/components/page-header"
import { updateLibrary } from "./actions"
const box = "w-full rounded-md border bg-background p-2 text-sm",
  btn = "rounded-md border px-3 py-1.5 text-sm hover:bg-muted",
  panel = "space-y-3 rounded-xl border p-4"
const labels = {
  chat: "聊天原话",
  task: "任务",
  artifact: "成果文件",
  upload: "上传附件",
}
const srcUrl = (kind: string, id: string) =>
  `/library?source=${kind}&id=${encodeURIComponent(id)}`
export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  let owner
  try {
    owner = await requireOwner(await headers())
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) redirect("/login")
    throw e
  }
  const p = await searchParams
  const arg = (k: string) => (typeof p[k] === "string" ? p[k] : "")
  const q = arg("q").trim().slice(0, 180),
    view = arg("view"),
    parsed = sourceType.safeParse(arg("source")),
    filter = sourceType.safeParse(arg("type"))
  const source = parsed.success
    ? await readSource(owner.userId, { kind: parsed.data, id: arg("id") })
    : null
  if (arg("source") && !source) notFound()
  const followup = source && arg("followup") === "1"
  const [entry] = arg("entry")
    ? await db
        .select()
        .from(libraryEntries)
        .where(
          and(
            eq(libraryEntries.ownerId, owner.userId),
            eq(libraryEntries.id, arg("entry"))
          )
        )
    : []
  if (arg("entry") && !entry) notFound()
  const connections = (await listConnections(owner.userId))
    .filter((c) => c.kind === "google" && c.enabled && c.authorized)
    .map((c) => ({ id: String(c.id), name: String(c.name) }))
  const people = await db
    .select({ id: agents.id, name: agents.name })
    .from(companions)
    .innerJoin(agents, eq(agents.id, companions.agentId))
    .where(eq(companions.ownerId, owner.userId))
  const page = Math.min(10000, Math.max(1, Number.parseInt(arg("page"), 10) || 1)),
    size = 30
  const next = (n: number) =>
    "/library?" +
    new URLSearchParams({ q, view, type: arg("type"), page: String(n) }).toString()
  const [items, hits] = await Promise.all([
    listEntries(
      owner.userId,
      q,
      view === "open" || view === "done" ? "followup" : undefined,
      view === "open" ? false : view === "done" ? true : undefined,
      size + 1,
      (page - 1) * size
    ),
    searchSources(
      owner.userId,
      q,
      filter.success ? filter.data : undefined,
      size + 1,
      (page - 1) * size
    ),
  ])
  return (
    <PageLayout title="资料与跟进">
      {arg("error") && <p role="alert">{arg("error")}</p>}
      <form className={panel} action="/library">
        <label htmlFor="lookup">搜索共享笔记、聊天原话、任务和文件名</label>
        <div className="flex flex-wrap gap-2">
          <input
            className={box}
            id="lookup"
            name="q"
            maxLength={180}
            defaultValue={q}
            placeholder="例如：报价、任务名称、文件名"
          />
          <select aria-label="原始资料类型" name="type" defaultValue={arg("type")}>
            <option value="">所有原始资料</option>
            {Object.entries(labels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <button className={btn}>搜索</button>
        </div>
      </form>
      {source && (
        <section className={panel}>
          <h2>
            {labels[source.kind]} · {source.title}
          </h2>
          <p className="break-words whitespace-pre-wrap">{source.body}</p>
          <small>{source.at.toISOString().slice(0, 10)}</small>{" "}
          {source.task && (
            <Link
              className="underline"
              href={"/?task=" + encodeURIComponent(source.task)}
            >
              打开任务
            </Link>
          )}{" "}
          {(source.kind === "artifact" || source.kind === "upload") && (
            <a
              className="underline"
              href={
                "/api/" +
                (source.kind === "artifact" ? "artifacts" : "uploads") +
                "/" +
                encodeURIComponent(source.id)
              }
            >
              下载原文件
            </a>
          )}
        </section>
      )}
      {q && (
        <section className={panel}>
          <h2>匹配的原始资料</h2>
          {!hits.length && <p>没有匹配的原始资料。</p>}
          {hits.slice(0, size).map((h) => (
            <article key={h.kind + h.id}>
              <Link className="underline" href={srcUrl(h.kind, h.id)}>
                {labels[h.kind]} · {h.title}
              </Link>
              <p className="text-sm text-muted-foreground">{h.body}</p>
            </article>
          ))}
        </section>
      )}
      <section className={panel}>
        <h2>
          {entry ? "编辑条目" : source ? "根据这份原文记一条" : "添加笔记或待跟进事项"}
        </h2>
        <p className="text-sm text-muted-foreground">
          保存的标题和正文供你的各个助手查询。来源链接只供你查看。
        </p>
        <form
          key={entry?.id ?? (source ? source.kind + source.id : "new")}
          action={updateLibrary}
          className="space-y-2"
        >
          <input type="hidden" name="action" value="save" />
          {entry && <input type="hidden" name="id" value={entry.id} />}
          {source && (
            <>
              <input type="hidden" name="sourceKind" value={source.kind} />
              <input type="hidden" name="sourceId" value={source.id} />
            </>
          )}
          {entry ? (
            <input type="hidden" name="kind" value={entry.kind} />
          ) : (
            <select
              aria-label="条目类型"
              name="kind"
              defaultValue={followup ? "followup" : "note"}
            >
              <option value="note">共享笔记</option>
              <option value="followup">待跟进</option>
            </select>
          )}
          <input
            className={box}
            name="title"
            aria-label="标题"
            defaultValue={
              entry?.title ??
              (source?.kind === "chat" ? source.body : source?.title)?.slice(0, 180)
            }
            maxLength={180}
            placeholder="标题"
          />
          <textarea
            className={box}
            name="body"
            aria-label="正文"
            defaultValue={entry?.body}
            rows={3}
            maxLength={8000}
            placeholder="结论、约定或还在等的事"
          />
          {!entry && (
            <label className="block text-sm">
              或导入一份 TXT / Markdown / 会议字幕（最多 8000 字）{" "}
              <input name="file" type="file" accept=".md,.txt,.srt,.vtt" />
            </label>
          )}
          {entry?.kind !== "note" && (
            <details open={entry?.kind === "followup" || !!followup}>
              <summary>待跟进：设置到期日期与聊天提醒</summary>
              <label className="block">
                到期日期{" "}
                <input name="dueDate" type="date" defaultValue={entry?.dueDate ?? ""} />
              </label>
              <label>
                提醒到{" "}
                <select name="reminderAgent" defaultValue={entry?.reminderAgent ?? ""}>
                  <option value="">只记在清单</option>
                  {people.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            </details>
          )}
          <button className={btn}>保存</button>{" "}
          {entry?.sourceKind && entry.sourceId && (
            <Link className="underline" href={srcUrl(entry.sourceKind, entry.sourceId)}>
              查看原始出处
            </Link>
          )}
        </form>
        {entry && (
          <form action={updateLibrary}>
            <input type="hidden" name="id" value={entry.id} />
            <button className="text-sm" name="action" value="delete">
              删除此条目
            </button>
          </form>
        )}
      </section>
      <GoogleImport connections={connections} />
      <section className={panel}>
        <h2>我的条目</h2>
        <nav className="flex gap-3">
          {[
            ["all", "全部"],
            ["open", "待跟进"],
            ["done", "已完成"],
          ].map(([k, v]) => (
            <Link
              key={k}
              aria-current={(view || "all") === k ? "page" : undefined}
              className="underline"
              href={"/library?view=" + k + "&q=" + encodeURIComponent(q)}
            >
              {v}
            </Link>
          ))}
        </nav>
        {!items.length && <p>这里暂时没有条目。</p>}
        {items.slice(0, size).map((r) => (
          <article key={r.id} className="space-y-1 border-t py-2">
            <Link
              className="font-medium underline"
              href={"/library?entry=" + encodeURIComponent(r.id)}
            >
              {r.title}
            </Link>
            {r.dueDate && <small> · {r.dueDate}</small>}
            <p className="line-clamp-2 text-sm whitespace-pre-wrap">{r.body}</p>
            <form action={updateLibrary} className="flex gap-3 text-sm">
              <input type="hidden" name="id" value={r.id} />
              {r.kind === "followup" && (
                <button name="action" value={r.done ? "reopen" : "complete"}>
                  {r.done ? "重新跟进" : "标记已完成"}
                </button>
              )}
              {r.sourceKind && r.sourceId && (
                <Link href={srcUrl(r.sourceKind, r.sourceId)}>原始出处</Link>
              )}
            </form>
          </article>
        ))}
      </section>
      <nav className="flex gap-3">
        {page > 1 && <Link href={next(page - 1)}>上一页</Link>}
        {(items.length > size || hits.length > size) && (
          <Link href={next(page + 1)}>下一页</Link>
        )}
      </nav>
    </PageLayout>
  )
}
