import type { AgentId } from "@/lib/jarvis/types"
import { TOOL_NAME } from "./tools"

const TOOL_PERMISSIONS: Record<AgentId, ReadonlySet<string>> = {
  orchestrator: new Set(),
  researcher: new Set(),
  memory: new Set([TOOL_NAME]),
  planner: new Set(),
  analyst: new Set(),
  creator: new Set(),
  auditor: new Set(),
  final_judge: new Set(),
}

export function isToolAllowed(agent: AgentId, toolName: string): boolean {
  return TOOL_PERMISSIONS[agent].has(toolName)
}
