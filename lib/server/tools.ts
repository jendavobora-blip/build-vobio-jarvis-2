import "server-only"

/**
 * A single, fixed, read-only tool exposed to the model: `search_memory`.
 *
 * The tool searches ONLY the memory items that were already included in the
 * authenticated request body. It has no access to files, databases, other
 * users, external networks or any write operation. Returned content is capped
 * in count and length so it cannot be used to smuggle unbounded data back into
 * the prompt.
 */

export const TOOL_NAME = "search_memory" as const

const MAX_RESULTS = 5
const MAX_EXCERPT_CHARS = 500
const MAX_TITLE_CHARS = 120
const MAX_QUERY_CHARS = 200

export class ToolError extends Error {}

export interface SearchableMemory {
  id: string
  category: string
  title: string
  content: string
}

export interface SearchMemoryArgs {
  query: string
  limit: number
}

export interface ToolCallOutcome {
  content: string
  matches: number
}

/** OpenAI/DeepSeek-compatible function tool definition. */
export const SEARCH_MEMORY_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME,
    description:
      "Prohledá POUZE paměťové položky přiložené k aktuálnímu požadavku (název a obsah). Vrací nejvýše 5 stručných výňatků. Neposkytuje soubory, databázi, síť ani data jiných uživatelů.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Hledaný výraz (1–200 znaků).",
        },
        limit: {
          type: "integer",
          description: "Maximální počet výsledků (1–5).",
          minimum: 1,
          maximum: MAX_RESULTS,
        },
      },
      required: ["query"],
    },
  },
} as const

export function parseSearchMemoryArgs(raw: string): SearchMemoryArgs {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ToolError("Argumenty nástroje nejsou platný JSON.")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ToolError("Argumenty nástroje musí být objekt.")
  }
  const obj = parsed as Record<string, unknown>
  const query = typeof obj.query === "string" ? obj.query.trim().slice(0, MAX_QUERY_CHARS) : ""
  if (query.length < 2) {
    throw new ToolError("Parametr 'query' musí mít alespoň 2 znaky.")
  }
  let limit = MAX_RESULTS
  if (obj.limit !== undefined) {
    if (typeof obj.limit !== "number" || !Number.isFinite(obj.limit)) {
      throw new ToolError("Parametr 'limit' musí být číslo.")
    }
    limit = Math.min(MAX_RESULTS, Math.max(1, Math.floor(obj.limit)))
  }
  return { query, limit }
}

/**
 * Executes the fixed `search_memory` tool against the provided memories only.
 * Matching is a simple, deterministic substring/token score so behavior is
 * predictable and testable without touching retrieval internals.
 */
export function executeSearchMemory(memories: readonly SearchableMemory[], rawArgs: string): ToolCallOutcome {
  const { query, limit } = parseSearchMemoryArgs(rawArgs)
  const normalizedQuery = query.toLowerCase()
  const words = Array.from(new Set(normalizedQuery.split(/\s+/).filter((word) => word.length >= 2)))
  if (words.length === 0) words.push(normalizedQuery)

  const scored = memories
    .map((memory) => {
      const title = memory.title.toLowerCase()
      const content = memory.content.toLowerCase()
      let score = 0
      for (const word of words) {
        if (title.includes(word)) score += 2
        if (content.includes(word)) score += 1
      }
      return { memory, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const results = scored.map(({ memory }) => ({
    id: memory.id.slice(0, 64),
    category: memory.category,
    title: memory.title.slice(0, MAX_TITLE_CHARS),
    excerpt: memory.content.slice(0, MAX_EXCERPT_CHARS),
  }))

  return {
    matches: results.length,
    content: JSON.stringify({ found: results.length, results }),
  }
}
