import type { PiSettingsRecoveryStatus } from "@ling/contracts/pi-settings";
import { createRequestFence, type RequestFence } from "@renderer/lib/request-fence";
import { formatRequestError } from "@renderer/lib/errors";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { createPersistedSettingsMutationQueue } from "./persisted-settings";
import { createPiSettingsMutations, type PiSettingsChange } from "./pi-settings-mutations";

type ProxySettingReadResult = { status: "ready"; value: string } | { status: "unavailable"; error: unknown };

async function readProxySetting(read: () => Promise<string | null>): Promise<ProxySettingReadResult> {
	try {
		return { status: "ready", value: (await read()) ?? "" };
	} catch (error) {
		return { status: "unavailable", error };
	}
}

/** Owns the persisted proxy value and its pending reads and writes. */
export function useProxySetting() {
	const hostNetworkApi = useDomainApi("network");
	const { t } = useTranslation();
	const [stored, setStored] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const fence = useRef(createRequestFence<typeof hostNetworkApi>()).current;
	const queue = useRef(createPersistedSettingsMutationQueue()).current;
	const load = useCallback(async () => {
		const revision = fence.begin(hostNetworkApi);
		const result = await readProxySetting(hostNetworkApi.getProxy);
		if (!fence.isCurrent(revision, hostNetworkApi)) return;
		if (result.status === "ready") {
			setStored(result.value);
			setError(null);
		} else setError(formatRequestError(result.error, t));
	}, [hostNetworkApi, fence, t]);
	useEffect(() => {
		void load();
		return () => {
			fence.invalidate();
			queue.invalidate();
		};
	}, [load, fence, queue]);
	const save = async (draft: string): Promise<boolean> => {
		fence.invalidate();
		const next = draft.trim();
		const outcome = await queue.run(() => hostNetworkApi.setProxy(next === "" ? null : next), hostNetworkApi.getProxy);
		if (!queue.isCurrent(outcome.revision)) return outcome.result.status === "saved";
		const { result } = outcome;
		if (result.status === "saved") {
			setStored(next);
			setError(null);
			return true;
		}
		if (result.persisted.status === "ready") setStored(result.persisted.value ?? "");
		setError(formatRequestError(result.error, t));
		return false;
	};
	return { stored, error, load, save };
}

/** Owns Pi settings reads, serialized mutations and recovery after partial writes. */
export function usePiSettings() {
	const hostPiSettingsApi = useDomainApi("piSettings");

	const { t } = useTranslation();
	const mutations = useMemo(() => createPiSettingsMutations(hostPiSettingsApi), [hostPiSettingsApi]);
	const { snapshot, pending, error } = useSyncExternalStore(mutations.subscribe, mutations.getSnapshot);
	const [readError, setReadError] = useState<string | null>(null);
	const [recoveryStatus, setRecoveryStatus] = useState<PiSettingsRecoveryStatus | null>(null);
	const [repairing, setRepairing] = useState(false);
	const readFenceRef = useRef<RequestFence<typeof hostPiSettingsApi> | null>(null);
	readFenceRef.current ??= createRequestFence<typeof hostPiSettingsApi>();
	const readFence = readFenceRef.current;
	useEffect(
		() => () => {
			readFence.invalidate();
			mutations.invalidate();
		},
		[mutations, readFence],
	);

	const load = useCallback(async () => {
		const revision = readFence.begin(hostPiSettingsApi);
		try {
			await mutations.whenSettled();
			if (!readFence.isCurrent(revision, hostPiSettingsApi)) return;
			const nextSnapshot = await hostPiSettingsApi.get();
			if (!readFence.isCurrent(revision, hostPiSettingsApi)) return;
			mutations.replace(nextSnapshot);
			setReadError(null);
			setRecoveryStatus(null);
		} catch (cause) {
			if (!readFence.isCurrent(revision, hostPiSettingsApi)) return;
			const nextError = formatRequestError(cause, t);
			try {
				const nextRecoveryStatus = await hostPiSettingsApi.getRecoveryStatus();
				if (!readFence.isCurrent(revision, hostPiSettingsApi)) return;
				setReadError(nextError);
				setRecoveryStatus(nextRecoveryStatus);
			} catch {
				if (!readFence.isCurrent(revision, hostPiSettingsApi)) return;
				setReadError(nextError);
				setRecoveryStatus({ status: "unavailable", code: "PI_SETTINGS_READ_FAILED" });
			}
		}
	}, [hostPiSettingsApi, mutations, readFence, t]);

	useEffect(() => {
		void load();
	}, [load]);

	const repairHttpIdleTimeout = async () => {
		readFence.invalidate();
		setRepairing(true);
		try {
			if (await mutations.repair(hostPiSettingsApi.repairHttpIdleTimeout)) {
				setReadError(null);
				setRecoveryStatus(null);
			}
		} finally {
			setRepairing(false);
		}
	};

	const apply = (update: PiSettingsChange, key?: string): Promise<boolean> => {
		readFence.invalidate();
		return mutations.apply(update, key);
	};

	const settingsError = error ? formatRequestError(error.cause, t) : readError;
	return { snapshot, pending, settingsError, recoveryStatus, repairing, load, repairHttpIdleTimeout, apply };
}
