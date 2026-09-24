import { mcpCommandSchema, type McpCommand, type McpOverview } from "@ling/contracts/mcp";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { Button } from "@renderer/components/ui/button";
import { SettingsRow, SettingsSection } from "@renderer/components/ui/settings-list";
import { useBuiltinFeatures } from "@renderer/features/companions/builtin-feature-state";
import { extensionUiSnapshotFamily, sessionBusyFamily } from "@renderer/features/sessions/state/session";
import { useAppNavigation } from "@renderer/lib/app-navigation";
import { useAppFeedback } from "@renderer/lib/feedback-context";
import { formatRequestError } from "@renderer/lib/errors";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { useAtomValue } from "jotai";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export function McpLiveSession({
	sessionRef,
	configuring,
	configured,
}: {
	sessionRef: SessionRef;
	configuring: boolean;
	configured: NonNullable<McpOverview["effective"]>;
}) {
	const { t } = useTranslation();
	const api = useDomainApi("mcp");
	const features = useBuiltinFeatures();
	const navigation = useAppNavigation();
	const feedback = useAppFeedback();
	const snapshot = useAtomValue(extensionUiSnapshotFamily(sessionKey(sessionRef)));
	const busy = useAtomValue(sessionBusyFamily(sessionKey(sessionRef)));
	const [pending, setPending] = useState(false);
	const running = useRef(false);
	const status = snapshot?.state.mcpStatus;
	const blocked = busy || pending || configuring || features.busy || !features.value?.enabled.mcp;
	async function execute(command: McpCommand) {
		if (!snapshot || blocked || running.current) return;
		running.current = true;
		setPending(true);
		try {
			await navigation.openSession(sessionRef);
			await api.run({ ref: sessionRef, runtimeId: snapshot.runtimeId, generation: snapshot.generation, ...command });
		} catch (cause) {
			feedback.show({ tone: "danger", title: t("mcp.actionFailed"), description: formatRequestError(cause) });
		} finally {
			running.current = false;
			setPending(false);
		}
	}
	if (!features.value?.enabled.mcp)
		return <p className="text-xs leading-relaxed text-text-muted">{t("mcp.runtimeOff")}</p>;
	if (!status) return <p className="text-xs leading-relaxed text-text-muted">{t("mcp.noLiveStatus")}</p>;
	// The adapter can defer initialization from cached metadata without emitting server status.
	// Keep configured services reachable while reporting no connection or tool-count claims.
	const servers = status.servers.length
		? status.servers
		: configured.map((server) => ({
				name: server.name,
				disabled: server.disabled,
				status: server.disabled ? ("disabled" as const) : ("not-connected" as const),
				toolCount: null,
			}));
	return (
		<SettingsSection
			title={t("mcp.live")}
			description={
				status.servers.length
					? t("mcp.summary", { connected: status.connectedCount, tools: status.totalTools })
					: t("mcp.status_not-connected")
			}
		>
			{(busy || configuring) && (
				<p className="px-5 py-3 text-xs leading-relaxed text-text-muted">{t("mcp.waitForIdle")}</p>
			)}
			{servers.map((server) => {
				const supportsCommand = mcpCommandSchema.shape.name.safeParse(server.name).success;
				return (
					<SettingsRow
						key={server.name}
						label={<span className="break-all">{server.name}</span>}
						description={
							<>
								{t(`mcp.status_${server.status}`)}
								{!supportsCommand && !server.disabled && <span className="mt-1 block">{t("mcp.commandNameHint")}</span>}
							</>
						}
					>
						<div className="flex flex-wrap items-center gap-2">
							{server.toolCount !== null && (
								<span className="text-xs tabular-nums text-text-muted">
									{t("mcp.tools", { count: server.toolCount })}
								</span>
							)}
							{!server.disabled && (
								<Button
									variant="outline"
									size="sm"
									disabled={blocked || !supportsCommand}
									aria-label={t(server.status === "needs-auth" ? "mcp.authenticateNamed" : "mcp.connectNamed", {
										name: server.name,
									})}
									onClick={() =>
										void execute({
											action: server.status === "needs-auth" ? "authenticate" : "connect",
											name: server.name,
										})
									}
								>
									{t(server.status === "needs-auth" ? "mcp.authenticate" : "mcp.connect")}
								</Button>
							)}
						</div>
					</SettingsRow>
				);
			})}
		</SettingsSection>
	);
}
