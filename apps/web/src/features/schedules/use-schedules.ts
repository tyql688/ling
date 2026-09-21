import type { SchedulesSnapshot } from "@ling/contracts/schedules";
import { useFeatureSnapshot } from "@renderer/features/companions/use-feature-snapshot";
import { useDomainApi } from "@renderer/lib/host-api-context";

export function useSchedules() {
	const api = useDomainApi("schedules");
	return useFeatureSnapshot<SchedulesSnapshot>({
		load: () => api.snapshot(),
		subscribe: (refresh) => api.onChanged(refresh),
		key: "schedules",
	});
}
