import { z } from "zod";
import { argumentsOf, event, noArguments, request, returns } from "./procedure";
import type { UserSkinsSnapshot } from "./skins";
import { SKIN_ID_PATTERN } from "./skins";
const schemas = { skinId: z.string().regex(SKIN_ID_PATTERN, "Invalid skin id") };
export const skinsProcedures = {
	list: request("skins:list", noArguments, returns<UserSkinsSnapshot>()),
	openDir: request("skins:openDir", noArguments, returns<{ dir: string }>()),
	delete: request(
		"skins:delete",
		argumentsOf<[id: string]>((args) => [schemas.skinId.parse(args[0])]),
		returns<UserSkinsSnapshot>(),
	),
	onChanged: event("skins:changed-event", returns<UserSkinsSnapshot>()),
};
