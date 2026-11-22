export function isLiveAccessEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true"
}
