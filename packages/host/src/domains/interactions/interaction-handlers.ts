import { interactionProcedures } from "@ling/contracts/interaction-procedures";
import type { HostDomain } from "../../transport/host-domain";
import type { Interactions } from "./interactions";

export function createInteractionDomain(interactions: Interactions): HostDomain {
	return {
		handlers: {
			[interactionProcedures.list.channel]: async () => interactions.list(),
			[interactionProcedures.answer.channel]: async (_context, id, submissionId, value) => {
				interactions.answer(id, submissionId, value);
			},
		},
	};
}
