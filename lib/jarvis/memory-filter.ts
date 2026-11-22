import type { MemoryCategory, MemoryItem } from "./types"

export function filterMemories<T extends Pick<MemoryItem, "category" | "title" | "content">>(
  items: T[],
  category: MemoryCategory | "all",
  query: string,
): T[] {
  const search = query.trim().toLocaleLowerCase("cs-CZ")
  return items.filter((item) =>
    (category === "all" || item.category === category) &&
    (!search || `${item.title}\n${item.content}`.toLocaleLowerCase("cs-CZ").includes(search)),
  )
}
