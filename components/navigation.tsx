"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  BookOpen,
  Library,
  Bot,
  CalendarClock,
  ChartNoAxesCombined,
  ChevronDown,
  GitBranch,
  Goal,
  ListChecks,
  MessageCircle,
  Settings2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu"

const APP_NAV_ITEMS = [
  { href: "/companion", label: "陪伴聊天", icon: MessageCircle },
  { href: "/library", label: "资料与跟进", icon: Library },
  { href: "/settings", label: "模型与 Agent 设置", icon: Bot },
  { href: "/usage", label: "用量与预算", icon: ChartNoAxesCombined },
  { href: "/routines", label: "定时例程", icon: CalendarClock },
  { href: "/objectives", label: "长期目标", icon: Goal },
  { href: "/improvements", label: "自我改进", icon: Settings2 },
  { href: "/versions", label: "版本", icon: GitBranch },
  { href: "/workflows", label: "电脑操作流程", icon: ListChecks },
  { href: "/manuals", label: "操作手册", icon: BookOpen },
] as const

export function AppNavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  return (
    <nav aria-label="应用导航" className="grid grid-cols-2 gap-0.5">
      {APP_NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-2 py-2 text-xs text-foreground/80 transition-colors hover:bg-surface hover:text-foreground",
              active && "bg-surface font-medium text-foreground shadow-2xs"
            )}
          >
            <Icon
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span>{label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export function AppNavMenu() {
  const pathname = usePathname()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
        页面导航 <ChevronDown aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {APP_NAV_ITEMS.map(({ href, label, icon: Icon }) => (
          <DropdownMenuItem
            key={href}
            render={
              <Link href={href} aria-current={pathname === href ? "page" : undefined} />
            }
            className="gap-2 px-2 py-2 aria-[current=page]:bg-muted aria-[current=page]:font-medium"
          >
            <Icon aria-hidden="true" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
