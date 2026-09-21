import { argumentsOf, noArguments, request, returns } from "./procedure";

import { httpUrlSchema } from "./schema-primitives";
const schemas = { proxySettingSchema: httpUrlSchema("Proxy URL").nullable() };
export const networkProcedures = {
	getProxy: request("network:getProxy", noArguments, returns<string | null>()),
	setProxy: request(
		"network:setProxy",
		argumentsOf<[proxy: string | null]>((args) => [schemas.proxySettingSchema.parse(args[0])]),
		returns<void>(),
	),
};
