import { argumentsOf, noArguments, request, returns } from "./procedure";
import type { ProviderQuotaSnapshot, UsageRangeDays, UsageStatsSnapshot } from "./usage";
import { usageRangeDaysSchema } from "./usage";
const schemas = { usageRangeDaysSchema };
export const usageProcedures = {
	getStats: request(
		"usage:getStats",
		argumentsOf<[rangeDays: UsageRangeDays]>((args) => [schemas.usageRangeDaysSchema.parse(args[0])]),
		returns<UsageStatsSnapshot>(),
	),
	getProviderQuotas: request("usage:getProviderQuotas", noArguments, returns<ProviderQuotaSnapshot>()),
};
