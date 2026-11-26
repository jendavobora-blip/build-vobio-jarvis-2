export function stableOwnerId(configuredId: string | undefined): string | undefined {
  const value = configuredId?.trim().toLowerCase()
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
    ? value
    : undefined
}
