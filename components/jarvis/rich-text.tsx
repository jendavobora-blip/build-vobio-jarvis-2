import { Fragment } from "react"

function inline(text: string, keyPrefix: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={key} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      )
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={key} className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.85em] text-accent-foreground">
          {part.slice(1, -1)}
        </code>
      )
    }
    return <Fragment key={key}>{part}</Fragment>
  })
}

/** Minimal, XSS-safe Markdown subset renderer: headings, bullet/numbered lists, code fences, paragraphs. */
export function RichText({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n")
  const blocks: React.ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let code: string[] | null = null

  const flushList = () => {
    if (!list) return
    const Tag = list.ordered ? "ol" : "ul"
    blocks.push(
      <Tag
        key={`l${blocks.length}`}
        className={list.ordered ? "ml-5 list-decimal space-y-1" : "ml-5 list-disc space-y-1 marker:text-primary"}
      >
        {list.items.map((item, i) => (
          <li key={i}>{inline(item, `li${blocks.length}-${i}`)}</li>
        ))}
      </Tag>,
    )
    list = null
  }

  lines.forEach((raw, idx) => {
    const line = raw.trimEnd()
    if (line.trim().startsWith("```")) {
      if (code) {
        blocks.push(
          <pre key={`c${idx}`} className="overflow-x-auto rounded-xl bg-black/50 p-3 font-mono text-xs leading-relaxed text-accent-foreground">
            <code>{code.join("\n")}</code>
          </pre>,
        )
        code = null
      } else {
        flushList()
        code = []
      }
      return
    }
    if (code) {
      code.push(raw)
      return
    }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/)
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, items: [] }
      list.items.push((bullet ?? numbered)![1])
      return
    }
    flushList()
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      blocks.push(
        <h3 key={`h${idx}`} className="pt-1 text-base font-semibold text-foreground">
          {inline(heading[2], `h${idx}`)}
        </h3>,
      )
      return
    }
    if (line.trim()) {
      blocks.push(
        <p key={`p${idx}`} className="leading-relaxed">
          {inline(line, `p${idx}`)}
        </p>,
      )
    }
  })
  flushList()
  if (code) {
    blocks.push(
      <pre key="c-end" className="overflow-x-auto rounded-xl bg-black/50 p-3 font-mono text-xs text-accent-foreground">
        <code>{(code as string[]).join("\n")}</code>
      </pre>,
    )
  }

  return <div className="space-y-2.5 text-[15px] text-foreground/90 [overflow-wrap:anywhere]">{blocks}</div>
}
