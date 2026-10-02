import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import type { AgentInfo } from "@ling/contracts/application";

export function getAgentInfo(): AgentInfo {
	return { agentDir: getAgentDir(), piVersion: VERSION };
}
