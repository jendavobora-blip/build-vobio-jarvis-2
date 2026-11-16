import type { MemoryItem, WorkMode } from "./types"

type RetrievableMemory = Pick<MemoryItem, "id" | "category" | "title" | "content">

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
}

function tokens(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2)
    // Crude Czech stemming: compare on the first 5 characters so inflected forms match.
    .map((t) => t.slice(0, 5))
}

const MODE_CATEGORY_BOOST: Record<WorkMode, RetrievableMemory["category"][]> = {
  universal: ["preferences", "tasks", "projects"],
  investments: ["investments", "preferences"],
  business: ["business", "projects", "preferences"],
}

/** Keyword-overlap retrieval; transparent and free, no embeddings service required. */
export function retrieveMemories<T extends RetrievableMemory>(
  query: string,
  memories: T[],
  mode: WorkMode,
  limit = 6,
): { item: T; score: number }[] {
  const queryTokens = new Set(tokens(query))
  if (memories.length === 0) return []
  return memories
    .map((item) => {
      const itemTokens = tokens(`${item.title} ${item.title} ${item.content}`)
      let overlap = 0
      for (const t of new Set(itemTokens)) if (queryTokens.has(t)) overlap++
      let score = queryTokens.size ? overlap / Math.sqrt(queryTokens.size) : 0
      if (MODE_CATEGORY_BOOST[mode].includes(item.category)) score += 0.25
      if (item.category === "preferences") score += 0.15
      return { item, score: Math.round(score * 100) / 100 }
    })
    .filter((r) => r.score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
