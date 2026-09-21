import { event, noArguments, request, returns } from "./procedure";
import type { DataStoreHealth } from "./data-store";
export const dataStoreProcedures = {
	status: request("data:status", noArguments, returns<DataStoreHealth>()),
	retry: request("data:retry", noArguments, returns<DataStoreHealth>()),
	onChanged: event("data:changed", returns<null>()),
};
