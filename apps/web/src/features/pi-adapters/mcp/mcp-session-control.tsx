import { sameSessionRef, sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { Button } from "@renderer/components/ui/button";
import { useBuiltinFeatures } from "@renderer/features/companions/builtin-feature-state";
import {
	activeSessionRefAtom,
	dismissedMcpSettingsRequestFamily,
	extensionUiSnapshotFamily,
} from "@renderer/features/sessions/state/session";
import { useAppNavigation } from "@renderer/lib/app-navigation";
import { useAtom, useAtomValue } from "jotai";
import { Plug } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

export function McpSessionControl({ sessionRef }: { sessionRef: SessionRef }) {
	const { t } = useTranslation();
	const features = useBuiltinFeatures();
	const navigation = useAppNavigation();
	const active = useAtomValue(activeSessionRefAtom);
	const snapshot = useAtomValue(extensionUiSnapshotFamily(sessionKey(sessionRef)));
	const [dismissed, setDismissed] = useAtom(dismissedMcpSettingsRequestFamily(sessionKey(sessionRef)));
	const request = snapshot?.state.mcpSettingsRequestId;
	const visible = features.value?.enabled.mcp && sameSessionRef(active, sessionRef);
	useEffect(() => {
		if (!visible || !request || request === dismissed) return;
		setDismissed(request);
		navigation.openSettings("mcp");
	}, [visible, request, dismissed, setDismissed, navigation]);
	const status = snapshot?.state.mcpStatus;
	if (!visible || !status) return null;
	return (
		<Button
			variant="ghost"
			size="sm"
			className="h-7 gap-1 px-1.5 text-xs text-text-muted"
			onClick={() => navigation.openSettings("mcp")}
			title={
				status.servers.length
					? t("mcp.summary", { connected: status.connectedCount, tools: status.totalTools })
					: t("mcp.status_not-connected")
			}
			aria-label={t("mcp.title")}
		>
			<Plug className="size-3.5" aria-hidden="true" />
			MCP · {status.connectedCount}
		</Button>
	);
}
