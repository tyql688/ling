import { todoProcedures } from "@ling/contracts/todo-procedures";
import type { HostDomain } from "../../../transport/host-domain";
import type { Todo } from "./todo";

export function createTodoDomain(todo: Todo): HostDomain {
	return {
		handlers: {
			[todoProcedures.snapshot.channel]: async (_context, ref) => todo.snapshot(ref),
			[todoProcedures.review.channel]: async (context, { ref, requestId, language }) =>
				todo.review(ref, requestId, language, context.signal),
		},
	};
}
