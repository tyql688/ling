import { z } from "zod";
import { interactionAnswerSchema, type Interaction, type InteractionAnswer } from "./companions";
import { argumentsOf, event, noArguments, request, returns } from "./procedure";

export const interactionProcedures = {
	list: request("interactions:list", noArguments, returns<Interaction[]>()),
	answer: request(
		"interactions:answer",
		argumentsOf((args): [string, string, InteractionAnswer] => [
			z.string().min(1).max(200).parse(args[0]),
			z.string().min(1).max(200).parse(args[1]),
			interactionAnswerSchema.parse(args[2]),
		]),
		returns<void>(),
	),
	onChanged: event("interactions:changed", returns<Interaction[]>()),
};
