"use client"

// Keyboard/IME handling, draft persistence and composer layout adapted from the pinned MIT upstream.
import { useEffect, useId, useState, type ReactNode } from "react"
import { ArrowUpIcon, SquareIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

export function Composer({
  draftKey,
  label,
  initialText = "",
  busy,
  allowSupplement = false,
  disabled,
  sending,
  onSend,
  onStop,
  children,
}: {
  draftKey: string
  label: string
  initialText?: string
  busy: boolean
  allowSupplement?: boolean
  disabled: boolean
  sending: boolean
  onSend: (text: string) => Promise<boolean>
  onStop: () => void
  children?: ReactNode
}) {
  const inputId = useId()
  const [text, setText] = useState(initialText),
    [loadedKey, setLoadedKey] = useState("")
  const [storageError, setStorageError] = useState(""),
    [storageAvailable, setStorageAvailable] = useState(true)
  useEffect(() => {
    try {
      setText(sessionStorage.getItem(`personal-agent:draft:${draftKey}`) ?? initialText)
      setStorageAvailable(true)
      setStorageError("")
    } catch (cause) {
      setStorageAvailable(false)
      setStorageError(
        `浏览器草稿暂存不可用：${cause instanceof Error ? cause.message : String(cause)}`
      )
    }
    setLoadedKey(draftKey)
  }, [draftKey, initialText])
  useEffect(() => {
    if (loadedKey !== draftKey || !storageAvailable) return
    try {
      if (text) sessionStorage.setItem(`personal-agent:draft:${draftKey}`, text)
      else sessionStorage.removeItem(`personal-agent:draft:${draftKey}`)
    } catch (cause) {
      setStorageAvailable(false)
      setStorageError(
        `浏览器草稿保存失败：${cause instanceof Error ? cause.message : String(cause)}`
      )
    }
  }, [text, draftKey, loadedKey, storageAvailable])
  async function submit() {
    if (!text.trim() || (busy && !allowSupplement) || disabled || sending) return
    if (await onSend(text.trim())) {
      setText("")
      // The accepted task can immediately switch to its server-assigned thread.
      // Remove the old draft before this composer is unmounted.
      if (storageAvailable) {
        try {
          sessionStorage.removeItem(`personal-agent:draft:${draftKey}`)
        } catch (cause) {
          setStorageAvailable(false)
          setStorageError(
            `浏览器草稿清理失败：${cause instanceof Error ? cause.message : String(cause)}`
          )
        }
      }
    }
  }
  return (
    <form
      className="space-y-3.5"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <label htmlFor={inputId} className="block text-sm font-medium text-foreground/90">
        {label}
      </label>
      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-xs transition-all focus-within:border-primary/45 focus-within:ring-3 focus-within:ring-ring/15">
        <textarea
          id={inputId}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              void submit()
            }
          }}
          required
          maxLength={16000}
          rows={3}
          placeholder={
            label === "继续对话"
              ? "例如：把刚才的报表改成按地区汇总"
              : "告诉 Agent 你要完成的事"
          }
          disabled={disabled || sending}
          className="block max-h-64 min-h-28 w-full resize-y bg-transparent px-4 py-3.5 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/75 disabled:opacity-50"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline bg-muted/30 px-4 py-2.5">
          <span className="text-xs text-muted-foreground">
            Enter 发送 · Shift+Enter 换行
          </span>
          {busy && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onStop}
              disabled={sending}
            >
              <SquareIcon className="size-3" />
              停止当前任务
            </Button>
          )}
          {(!busy || allowSupplement) && (
            <Button type="submit" disabled={sending || disabled || !text.trim()}>
              <ArrowUpIcon className="size-3.5" />
              {sending
                ? "正在提交…"
                : busy
                  ? "补充当前任务"
                  : label === "继续对话"
                    ? "发送追问"
                    : "交给 Agent"}
            </Button>
          )}
        </div>
      </div>
      {storageError && (
        <p role="alert" className="text-xs text-destructive">
          {storageError}
        </p>
      )}
      <fieldset disabled={sending} className="space-y-2.5">
        {children}
      </fieldset>
    </form>
  )
}
