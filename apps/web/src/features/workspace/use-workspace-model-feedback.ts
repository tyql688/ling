import { onRendererSessionStateEvicted } from "@renderer/features/sessions/runtime/renderer-session-state";
import { useCallback, useEffect, useState, useMemo } from "react";

/** Keep the model-change hint visible for five seconds, without retaining it after its session is retired. */
const MODEL_NOTICE_DURATION_MS = 5_000;

export function useWorkspaceModelFeedback(activeSessionKey: string | null) {
	const [notice, setNotice] = useState<{ sessionKey: string } | null>(null);
	const [provider, setProvider] = useState<{ sessionKey: string; provider: string | null } | null>(null);
	const showModelSwitchNotice = useCallback(() => {
		if (activeSessionKey !== null) setNotice({ sessionKey: activeSessionKey });
	}, [activeSessionKey]);
	const clearModelSwitchNotice = useCallback(() => setNotice(null), []);
	const handleCurrentProviderChange = useCallback((sessionKey: string, provider: string | null) => {
		setProvider((current) =>
			current?.sessionKey === sessionKey && current.provider === provider ? current : { sessionKey, provider },
		);
	}, []);
	useEffect(() => {
		if (notice === null) return;
		const timeout = window.setTimeout(clearModelSwitchNotice, MODEL_NOTICE_DURATION_MS);
		return () => window.clearTimeout(timeout);
	}, [clearModelSwitchNotice, notice]);
	useEffect(
		() =>
			onRendererSessionStateEvicted((keys) => {
				const retired = new Set(keys);
				setNotice((current) => (current && retired.has(current.sessionKey) ? null : current));
				setProvider((current) => (current && retired.has(current.sessionKey) ? null : current));
			}),
		[],
	);

	return useMemo(
		() => ({
			modelSwitchNoticeVisible: notice !== null && notice.sessionKey === activeSessionKey,
			currentProviderId:
				activeSessionKey === null ? undefined : provider?.sessionKey === activeSessionKey ? provider.provider : null,
			showModelSwitchNotice,
			clearModelSwitchNotice,
			handleCurrentProviderChange,
		}),
		[activeSessionKey, notice, provider, showModelSwitchNotice, clearModelSwitchNotice, handleCurrentProviderChange],
	);
}
