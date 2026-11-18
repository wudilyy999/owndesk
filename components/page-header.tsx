import type { ReactNode } from "react"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { AppNavMenu } from "@/components/navigation"
import { cn } from "@/lib/utils"

export function WorkspaceBackLink({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground hover:underline hover:underline-offset-4",
        className
      )}
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      返回工作现场
    </Link>
  )
}

export function PageLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-5 sm:space-y-8 sm:px-8 sm:py-8">
      <header className="space-y-3 border-b border-hairline pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <WorkspaceBackLink />
          <AppNavMenu />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      </header>
      {children}
    </main>
  )
}
