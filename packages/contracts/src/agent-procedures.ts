import { noArguments, request, returns } from "./procedure";
import type { AgentInfo } from "./application";

export const agentProcedures = { getInfo: request("agent:getInfo", noArguments, returns<AgentInfo>()) };
