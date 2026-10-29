// Agent replies are Markdown; Telegram speaks a small subset of HTML.
// This converts the common constructs and escapes everything else.

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const escapeAttribute = (text: string) => escapeHtml(text).replace(/"/g, "&quot;")

export function markdownToTelegramHtml(markdown: string) {
  const stash: string[] = []
  const keep = (html: string) => `\u0000${stash.push(html) - 1}\u0000`

  let text = markdown.replace(/\r\n/g, "\n")

  // Fenced code first, so nothing inside is formatted
  text = text.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_, lang: string, code: string) =>
    keep(
      lang
        ? `<pre><code class="language-${escapeAttribute(lang)}">${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`
        : `<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`
    )
  )
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) =>
    keep(`<code>${escapeHtml(code)}</code>`)
  )

  text = tablesToLines(text)

  // Links before escaping, so their URLs stay intact
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label: string, url: string) =>
      keep(`<a href="${escapeAttribute(url)}">${escapeHtml(label)}</a>`)
  )

  text = escapeHtml(text)

  text = text
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>")
    .replace(/<\/blockquote>\n<blockquote>/g, "\n")
    .replace(/^-{3,}$/gm, "———")

  return text.replace(/\u0000(\d+)\u0000/g, (_, index: string) => stash[Number(index)])
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim())

// Telegram has no tables, and pipes are unreadable on a phone: the header
// becomes an italic line and each row a bullet led by its first cell
function tablesToLines(markdown: string) {
  const lines = markdown.split("\n")
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]
    const rule = lines[i + 1]
    if (
      /^\s*\|.*\|\s*$/.test(header) &&
      rule &&
      /^\s*\|?\s*:?-{3,}[-:|\s]*$/.test(rule)
    ) {
      out.push(`*${cells(header).filter(Boolean).join(" · ")}*`)
      i += 2
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const [first, ...rest] = cells(lines[i])
        out.push(`- **${first}**${rest.length ? ` · ${rest.join(" · ")}` : ""}`)
        i++
      }
      i--
      continue
    }
    out.push(header)
  }
  return out.join("\n")
}

// Telegram caps a message at 4096 characters. Split the Markdown on blank
// lines (never inside a code fence) so each piece converts cleanly.
export function splitMarkdown(markdown: string, limit = 3500) {
  if (markdown.length <= limit) return [markdown]

  const blocks: string[] = []
  let current = ""
  let inFence = false
  for (const line of markdown.split("\n")) {
    if (line.trim().startsWith("```")) inFence = !inFence
    const next = current ? `${current}\n${line}` : line
    if (next.length > limit && !inFence && current) {
      blocks.push(current)
      current = line
    } else if (next.length > limit * 1.15) {
      // A single enormous block (usually code): cut it hard
      blocks.push(next.slice(0, limit))
      current = next.slice(limit)
    } else {
      current = next
    }
  }
  if (current.trim()) blocks.push(current)
  return blocks
}

export function plainText(markdown: string) {
  return markdown.replace(/```[\w+-]*\n?/g, "").replace(/\*\*|__|`/g, "")
}
