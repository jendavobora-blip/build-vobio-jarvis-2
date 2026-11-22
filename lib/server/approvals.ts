import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"

export const approvalPlanSchema = z.object({
  target: z.string().trim().min(1).max(200),
  action: z.string().trim().min(1).max(200),
  changes: z.array(z.string().trim().min(1).max(1000)).min(1).max(50),
  impacts: z.array(z.string().trim().min(1).max(1000)).min(1).max(50),
  critical: z.boolean(),
})

export type ApprovalPlan = z.infer<typeof approvalPlanSchema>

export function approvalHash(plan: ApprovalPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("base64url")
}

export function approvalId(): string {
  return randomUUID()
}
