import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface RoutingConfig {
  roles?: Record<string, { model?: string }>;
  local?: { maxParallel?: number };
}

interface Reservation {
  type: string;
  background: boolean;
  agentId?: string;
}

export default function harnessRoutingGuard(pi: any) {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const routingPath = path.join(agentDir, "agent-routing.local.json");
  let routing: RoutingConfig = {};
  try {
    routing = JSON.parse(fs.readFileSync(routingPath, "utf8"));
  } catch {
    return;
  }

  const roleModels = routing.roles || {};
  const localRoleNames = Object.keys(roleModels).filter((role) => role === "implementer" || role === "reviewer");
  const localProviders = new Set(
    localRoleNames
      .map((role) => String(roleModels[role]?.model || "").split("/", 1)[0])
      .filter(Boolean),
  );
  const maxLocal = Number(routing.local?.maxParallel);
  if (localProviders.size === 0 || !Number.isInteger(maxLocal) || maxLocal < 1) return;

  const reservations = new Map<string, Reservation>();
  const activeAgentIds = new Set<string>();

  const isLocalCall = (input: any): boolean => {
    const type = String(input?.subagent_type || "");
    if (localRoleNames.some((role) => type === `harness-local-${role}`)) return true;
    const provider = String(input?.model || "").split("/", 1)[0];
    return localProviders.has(provider);
  };

  const localInFlight = (): number => {
    let unstarted = 0;
    for (const reservation of reservations.values()) {
      if (!reservation.agentId) unstarted += 1;
    }
    return activeAgentIds.size + unstarted;
  };

  pi.on("tool_call", (event: any) => {
    if (event.toolName !== "Agent" || !isLocalCall(event.input)) return;
    if (localInFlight() >= maxLocal) {
      return {
        block: true,
        reason: `Local subagent concurrency limit reached (${maxLocal}). Wait for the active local child to finish.`,
      };
    }
    reservations.set(event.toolCallId, {
      type: String(event.input?.subagent_type || ""),
      background: event.input?.run_in_background === true,
    });
  });

  const claimAgent = (data: any) => {
    const type = String(data?.type || "");
    const agentId = String(data?.id || data?.agentId || "");
    if (!agentId) return;
    const reservation = [...reservations.values()].find((item) => !item.agentId && item.type === type);
    if (!reservation) return;
    reservation.agentId = agentId;
    activeAgentIds.add(agentId);
  };
  pi.events.on("subagents:created", claimAgent);
  pi.events.on("subagents:started", claimAgent);

  const releaseAgent = (data: any) => {
    const agentId = String(data?.id || data?.agentId || "");
    if (agentId) activeAgentIds.delete(agentId);
  };
  pi.events.on("subagents:completed", releaseAgent);
  pi.events.on("subagents:failed", releaseAgent);
  pi.events.on("subagents:cancelled", releaseAgent);

  pi.on("tool_result", (event: any) => {
    if (event.toolName !== "Agent") return;
    const reservation = reservations.get(event.toolCallId);
    if (!reservation) return;
    reservations.delete(event.toolCallId);
    if (!reservation.background && reservation.agentId) activeAgentIds.delete(reservation.agentId);
  });
}
