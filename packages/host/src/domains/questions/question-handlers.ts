import { questionsProcedures } from "@ling/contracts/questions-procedures";
import type { HostDomain } from "../../transport/host-domain";
import type { Questions } from "./questions";

export function createQuestionDomain(questions: Questions): HostDomain {
	return {
		handlers: {
			[questionsProcedures.list.channel]: async (_context, ref) => questions.list(ref),
			[questionsProcedures.retry.channel]: async (_context, { ref, id }) => questions.retry(ref, id),
		},
	};
}
