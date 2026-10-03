import type { McpCommand, McpOverview } from "@ling/contracts/mcp";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { Button } from "@renderer/components/ui/button";
import { SettingsRow, SettingsSection } from "@renderer/components/ui/settings-list";
import { extensionUiSnapshotFamily, sessionBusyFamily } from "@renderer/features/sessions/state/session";
import { useAppNavigation } from "@renderer/lib/app-navigation";
import { useAppFeedback } from "@renderer/lib/feedback-context";
import { formatRequestError } from "@renderer/lib/errors";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { useAtomValue } from "jotai";
import { RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export function McpLiveSession({
	sessionRef,
	configuring,
	configured,
}: {
	sessionRef: SessionRef;
	configuring: boolean;
	configured: McpOverview["effective"];
}) {
	const { t } = useTranslation();
	const api = useDomainApi("mcp");
	const navigation = useAppNavigation();
	const feedback = useAppFeedback();
	const snapshot = useAtomValue(extensionUiSnapshotFamily(sessionKey(sessionRef)));
	const busy = useAtomValue(sessionBusyFamily(sessionKey(sessionRef)));
	const [pending, setPending] = useState(false);
	const running = useRef(false);
	const status = snapshot?.state.mcpStatus;
	const blocked = !snapshot || busy || pending || configuring;
	async function execute(command: McpCommand) {
		if (!snapshot || blocked || running.current) return;
		running.current = true;
		setPending(true);
		try {
			if (command.action !== "status") await navigation.openSession(sessionRef);
			await api.run({ ref: sessionRef, runtimeId: snapshot.runtimeId, generation: snapshot.generation, ...command });
		} catch (cause) {
			feedback.show({ tone: "danger", title: t("mcp.actionFailed"), description: formatRequestError(cause) });
		} finally {
			running.current = false;
			setPending(false);
		}
	}
	return (
		<SettingsSection title={t("mcp.live")} description={t("mcp.statusHint")}>
			<div className="flex flex-col gap-3 px-5 py-4">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span className="text-xs text-text-muted">
						{status
							? t("mcp.statusUpdated", { time: new Date(status.updatedAt).toLocaleTimeString() })
							: t("mcp.noLiveStatus")}
					</span>
					<Button
						variant="outline"
						size="sm"
						disabled={blocked}
						pending={pending}
						onClick={() => void execute({ action: "status" })}
					>
						<RefreshCw
							className={`size-3.5 ${pending ? "animate-spin motion-reduce:animate-none" : ""}`}
							aria-hidden="true"
						/>
						{t("mcp.refreshStatus")}
					</Button>
				</div>
				{status && (
					<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed">
						{status.text}
					</pre>
				)}
				{(busy || configuring) && <p className="text-xs text-text-muted">{t("mcp.waitForIdle")}</p>}
			</div>
			{configured
				.filter((server) => !server.disabled)
				.map((server) => (
					<SettingsRow
						key={server.name}
						label={<span className="break-all">{server.name}</span>}
						description={
							server.authProvider
								? t("mcp.usesProvider", { provider: server.authProvider })
								: t(`mcp.exposure_${server.exposure}`)
						}
					>
						<div className="flex flex-wrap items-center gap-2">
							<Button
								variant="outline"
								size="sm"
								disabled={blocked}
								aria-label={t("mcp.connectNamed", { name: server.name })}
								onClick={() => void execute({ action: "connect", name: server.name })}
							>
								{t("mcp.connect")}
							</Button>
							{server.authProvider ? (
								<Button variant="outline" size="sm" onClick={() => navigation.openSettings("models")}>
									{t("mcp.manageProvider")}
								</Button>
							) : (
								server.transport === "http" && (
									<>
										<Button
											variant="outline"
											size="sm"
											disabled={blocked}
											aria-label={t("mcp.authenticateNamed", { name: server.name })}
											onClick={() => void execute({ action: "authenticate", name: server.name })}
										>
											{t("mcp.authenticate")}
										</Button>
										<Button
											variant="ghost"
											size="sm"
											disabled={blocked}
											aria-label={t("mcp.logoutNamed", { name: server.name })}
											onClick={() => void execute({ action: "logout", name: server.name })}
										>
											{t("mcp.logout")}
										</Button>
									</>
								)
							)}
						</div>
					</SettingsRow>
				))}
		</SettingsSection>
	);
}
