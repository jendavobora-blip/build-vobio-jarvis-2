export type GraphicsQuality = "high" | "low" | "fallback"

export function nextGraphicsQuality(current: GraphicsQuality, fps: number): GraphicsQuality {
  if (!Number.isFinite(fps) || fps < 0 || current === "fallback") return current
  if (current === "high" && fps < 45) return "low"
  if (current === "low" && fps < 24) return "fallback"
  return current
}
