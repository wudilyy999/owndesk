"use client"
// Adapted from the pinned MIT upstream Markdown wrapper; block raw HTML and auto-loaded remote images.

import { memo } from "react"
import { createCodePlugin } from "@streamdown/code"
import { Streamdown } from "streamdown"

import { cn } from "@/lib/utils"

const code = createCodePlugin({ themes: ["github-light", "github-dark-dimmed"] })

export const Markdown = memo(function Markdown({
  children,
  streaming,
  className,
}: {
  children: string
  streaming?: boolean
  className?: string
}) {
  return (
    <Streamdown
      className={cn("prose-owndesk min-w-0", className)}
      plugins={{ code }}
      skipHtml
      components={{
        img: ({ alt }) => (
          <span className="text-muted-foreground">
            [图片未自动加载：{alt || "外部图片"}]
          </span>
        ),
      }}
      isAnimating={streaming}
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={!!streaming}
    >
      {children}
    </Streamdown>
  )
})
