export function isLiveAccessEnabled(value: string | undefined, deploymentEnv?: string): boolean {
  if (deploymentEnv === "preview") return false
  return value?.trim().toLowerCase() === "true"
}
