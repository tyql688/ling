import type { HostApi } from "@ling/contracts/api/host-procedures";
import { errorMessage } from "@ling/contracts/ling-error";
import type { createStore } from "jotai/vanilla";
import { dataHealthActionsAtom, dataHealthAtom, dataHealthErrorAtom } from "./state";

export function createDataHealthRuntime(store: ReturnType<typeof createStore>, api: HostApi["data"]) {
	let disposed = false;
	let sequence = 0;
	let loading: Promise<void> | null = null;
	let refreshAgain = false;
	function refresh(): Promise<void> {
		if (loading) {
			refreshAgain = true;
			return loading;
		}
		loading = (async () => {
			do {
				refreshAgain = false;
				const request = ++sequence;
				try {
					const status = await api.status();
					if (!disposed && request === sequence) {
						store.set(dataHealthAtom, status);
						store.set(dataHealthErrorAtom, null);
					}
				} catch (error) {
					if (!disposed && request === sequence) store.set(dataHealthErrorAtom, errorMessage(error));
				}
			} while (refreshAgain && !disposed);
		})().finally(() => {
			loading = null;
		});
		return loading;
	}
	async function retry() {
		const request = ++sequence;
		try {
			const status = await api.retry();
			if (!disposed && request === sequence) {
				store.set(dataHealthAtom, status);
				store.set(dataHealthErrorAtom, null);
			}
		} catch (error) {
			if (!disposed && request === sequence) store.set(dataHealthErrorAtom, errorMessage(error));
		}
	}
	const release = api.onChanged(() => {
		if (!disposed) void refresh();
	});
	store.set(dataHealthActionsAtom, { refresh, retry });
	const ready = refresh();
	return {
		ready,
		dispose() {
			disposed = true;
			sequence++;
			release();
			store.set(dataHealthActionsAtom, null);
		},
	};
}
