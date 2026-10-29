"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function Login() {
  const router = useRouter()
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <div className="space-y-6 rounded-2xl border border-border bg-surface p-7 shadow-xs sm:p-8">
        <div>
          <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground">
            OwnDesk · 私有工作站
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">回到你的工作现场</h1>
        </div>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault()
            setBusy(true)
            setError("")
            const form = new FormData(event.currentTarget)
            try {
              const response = await fetch("/api/auth/sign-in/email", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  email: form.get("email"),
                  password: form.get("password"),
                }),
              })
              if (!response.ok) {
                const result = await response.json()
                throw new Error(result.message ?? "登录失败")
              }
              router.push("/")
              router.refresh()
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error))
            } finally {
              setBusy(false)
            }
          }}
        >
          <label className="block space-y-2 text-sm font-medium">
            邮箱
            <Input name="email" type="email" autoComplete="username" required />
          </label>
          <label className="block space-y-2 text-sm font-medium">
            密码
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "正在登录…" : "登录"}
          </Button>
        </form>
        <p className="border-t border-hairline pt-4 text-xs leading-6 text-muted-foreground">
          首位拥有者通过部署端命令创建，公开注册始终关闭。
        </p>
      </div>
    </main>
  )
}
