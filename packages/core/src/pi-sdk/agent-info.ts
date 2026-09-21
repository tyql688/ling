import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import type { AgentInfo } from "@ling/contracts/application";

export function getPiAgentDir(): string {
	return getAgentDir();
}

export function getAgentInfo(): AgentInfo {
	return { agentDir: getPiAgentDir(), piVersion: VERSION };
}
