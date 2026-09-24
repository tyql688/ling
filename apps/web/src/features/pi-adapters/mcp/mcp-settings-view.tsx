import type { McpDocument, McpOverview, McpServer, McpTarget, McpWriteRequest } from "@ling/contracts/mcp";
import type { OpenProjectInfo } from "@ling/contracts/project";
import { errorCode } from "@ling/contracts/ling-error";
import type { PiResourceReloadSummary } from "@ling/contracts/session";
import { sessionKey, type SessionRef } from "@ling/contracts/session-ref";
import { ResourceReloadFeedback } from "@renderer/components/resource-reload-feedback";
import { Button } from "@renderer/components/ui/button";
import { ConfirmDialog } from "@renderer/components/ui/confirm-dialog";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { SettingsRow, SettingsSection } from "@renderer/components/ui/settings-list";
import { SettingsPage } from "@renderer/components/ui/settings-page";
import { Switch } from "@renderer/components/ui/switch";
import { useBuiltinFeatures } from "@renderer/features/companions/builtin-feature-state";
import { BuiltinFeatureDocumentation } from "@renderer/features/companions/builtin-feature-documentation";
import { activeSessionRefAtom } from "@renderer/features/sessions/state/session";
import { formatRequestError } from "@renderer/lib/errors";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { useAtomValue } from "jotai";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { McpServerEditor } from "./mcp-server-editor";
import { McpLiveSession } from "./mcp-live-session";

export function McpSettingsView({ projects, activeCwd }: { projects: OpenProjectInfo[]; activeCwd: string | null }) {
	const { t } = useTranslation();
	const features = useBuiltinFeatures();
	const active = useAtomValue(activeSessionRefAtom);
	const [scope, setScope] = useState<string>(activeCwd ?? "global");
	const cwd = projects.find((project) => project.cwd === scope)?.cwd ?? null;
	return (
		<SettingsPage
			title={t("mcp.title")}
			description={t("mcp.description")}
			actions={<BuiltinFeatureDocumentation id="mcp" label={t("mcp.title")} />}
		>
			<SettingsSection>
				<SettingsRow label={t("mcp.builtin")} description={t("mcp.builtinHint")} layout="toggle">
					<Switch
						aria-label={t("mcp.builtin")}
						checked={features.value?.enabled.mcp ?? false}
						disabled={!features.value || features.busy}
						onCheckedChange={(value) => features.setEnabled("mcp", value)}
					/>
				</SettingsRow>
			</SettingsSection>
			{features.error && <FeedbackNotice tone="danger">{features.error}</FeedbackNotice>}
			{features.reload && <ResourceReloadFeedback summary={features.reload} />}
			<div className="flex flex-col gap-2">
				<span className="text-sm font-medium">{t("mcp.scope")}</span>
				<Select value={cwd ?? "global"} onValueChange={setScope}>
					<SelectTrigger className="w-full" aria-label={t("mcp.scope")}>
						<SelectValue>
							{cwd
								? t("mcp.project", { name: projects.find((project) => project.cwd === cwd)?.name })
								: t("mcp.global")}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="global">{t("mcp.global")}</SelectItem>
						{projects.map((project) => (
							<SelectItem key={project.cwd} value={project.cwd}>
								{t("mcp.project", { name: project.name })}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-xs leading-relaxed text-text-muted">{t(cwd ? "mcp.projectHint" : "mcp.globalHint")}</p>
			</div>
			<McpConfiguration key={cwd ?? "global"} cwd={cwd} active={active?.cwd === cwd ? active : null} />
		</SettingsPage>
	);
}

function McpConfiguration({ cwd, active }: { cwd: string | null; active: SessionRef | null }) {
	const { t } = useTranslation();
	const api = useDomainApi("mcp");
	const [overview, setOverview] = useState<McpOverview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [target, setTarget] = useState<McpTarget>(cwd ? "project" : "global");
	const [editor, setEditor] = useState<{ name: string | null; server: McpServer | null; document: McpDocument } | null>(
		null,
	);
	const [editorConflict, setEditorConflict] = useState(false);
	const [editorRefreshed, setEditorRefreshed] = useState(false);
	const [removing, setRemoving] = useState<{ name: string; document: McpDocument } | null>(null);
	const [reload, setReload] = useState<PiResourceReloadSummary | null>(null);
	const alive = useRef(false);
	const operation = useRef<"write" | "refresh" | null>(null);
	const generation = useRef(0);
	const refresh = useCallback(
		async (preserveError = false) => {
			const current = ++generation.current;
			setLoading(true);
			if (!preserveError) setError(null);
			try {
				const value = await api.read({ cwd });
				if (alive.current && generation.current === current) {
					setOverview(value);
					return value;
				}
			} catch (cause) {
				if (alive.current && generation.current === current) setError(formatRequestError(cause));
			} finally {
				if (alive.current && generation.current === current) setLoading(false);
			}
		},
		[api, cwd],
	);
	useEffect(() => {
		alive.current = true;
		void refresh();
		const unsubscribe = api.onChanged(() => {
			if (operation.current !== "write") void refresh(operation.current === "refresh");
		});
		return () => {
			unsubscribe();
			alive.current = false;
		};
	}, [refresh, api]);
	const document = overview?.documents.find((item) => item.target === target);
	const projectDocument = overview?.documents.find((item) => item.target === "project");
	const writable = canWrite(document);
	function canWrite(owner: McpDocument | undefined) {
		return !!owner?.revision && !owner.error && !loading && !busy && !error;
	}
	function openEditor(name: string | null, server: McpServer | null, owner: McpDocument) {
		setError(null);
		setEditorConflict(false);
		setEditorRefreshed(false);
		setEditor({ name, server, document: owner });
	}
	async function refreshEditor() {
		if (!editor || busy || loading) return;
		const current = editor;
		const latest = await refresh();
		if (!alive.current || !latest) return;
		const owner = latest.documents.find((item) => item.path === current.document.path);
		if (!owner?.revision || owner.error) {
			setError(owner?.error ?? t("mcp.invalidFile"));
			return;
		}
		setEditor((value) => (value === current ? { ...value, document: owner } : value));
		setEditorConflict(false);
		setEditorRefreshed(true);
	}
	async function write(name: string, change: McpWriteRequest["change"], owner = document) {
		if (!owner?.target || !owner.revision || operation.current) return;
		operation.current = "write";
		setBusy(true);
		setError(null);
		setReload(null);
		try {
			const result = await api.write({ cwd, target: owner.target, expectedRevision: owner.revision, name, change });
			if (!alive.current) return;
			setReload(result);
			setEditor(null);
			setRemoving(null);
		} catch (cause) {
			if (alive.current) {
				setError(formatRequestError(cause));
				setEditorConflict(errorCode(cause) === "MCP_CONFIG_CHANGED");
				setRemoving(null);
			}
		} finally {
			// The reload event precedes the write response. Refresh once after either
			// outcome, keeping a failed save visible and its draft available for retry.
			operation.current = "refresh";
			if (alive.current) await refresh(true);
			operation.current = null;
			if (alive.current) setBusy(false);
		}
	}
	return (
		<>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<Select
					value={target}
					disabled={busy || editor !== null || removing !== null}
					onValueChange={(value) => setTarget(value as McpTarget)}
				>
					<SelectTrigger aria-label={t("mcp.file")}>
						<SelectValue>{t(`mcp.target_${target}`)}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{(cwd ? (["project", "project-shared"] as const) : (["global", "global-shared"] as const)).map((value) => (
							<SelectItem value={value} key={value}>
								{t(`mcp.target_${value}`)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<div className="flex gap-2">
					<Button
						variant="ghost"
						size="sm"
						disabled={busy || loading || editor !== null || removing !== null}
						onClick={() => void refresh()}
					>
						<RefreshCw className="size-3.5" aria-hidden="true" />
						{t("mcp.refresh")}
					</Button>
					<Button size="sm" disabled={!writable} onClick={() => openEditor(null, null, document!)}>
						<Plus className="size-3.5" aria-hidden="true" />
						{t("mcp.add")}
					</Button>
				</div>
			</div>
			{document && <p className="-mt-5 break-all font-mono text-xs text-text-muted">{document.path}</p>}
			{error && !editor && <FeedbackNotice tone="danger">{error}</FeedbackNotice>}
			{overview?.documents
				.filter((item) => item.error)
				.map((item) => (
					<FeedbackNotice key={item.path} tone="danger" title={t("mcp.invalidFile")}>
						<span className="break-all">{item.path}</span>
						<p>{item.error}</p>
					</FeedbackNotice>
				))}
			{loading && (
				<p role="status" className="text-sm text-text-muted">
					{t("mcp.loading")}
				</p>
			)}
			{document?.servers && (
				<SettingsSection title={t("mcp.configured")} description={t("mcp.precedenceHint")}>
					{Object.entries(document.servers).length === 0 && (
						<p className="px-5 py-5 text-sm text-text-muted">{t("mcp.empty")}</p>
					)}
					{Object.entries(document.servers).map(([name, server]) => (
						<SettingsRow
							key={name}
							label={<span className="break-all">{name}</span>}
							description={
								server.command
									? t("mcp.transport_stdio")
									: server.url
										? t("mcp.transport_http")
										: t("mcp.transport_advanced")
							}
						>
							<div className="flex items-center gap-1">
								<Button
									variant="ghost"
									size="icon"
									disabled={!writable}
									aria-label={t("mcp.editNamed", { name })}
									onClick={() => openEditor(name, server, document)}
								>
									<Pencil className="size-3.5" aria-hidden="true" />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									disabled={!writable}
									aria-label={t("mcp.removeNamed", { name })}
									onClick={() => setRemoving({ name, document })}
								>
									<Trash2 className="size-3.5" aria-hidden="true" />
								</Button>
								<Switch
									checked={!server.disabled}
									disabled={!writable}
									aria-label={t("mcp.enableNamed", { name })}
									onCheckedChange={(enabled) => void write(name, { kind: "toggle", disabled: !enabled })}
								/>
							</div>
						</SettingsRow>
					))}
				</SettingsSection>
			)}
			{reload && <ResourceReloadFeedback summary={reload} successMessage={t("mcp.saved")} />}
			{cwd && overview?.effective && (
				<>
					<SettingsSection title={t("mcp.effective")} description={t("mcp.effectiveHint")}>
						{overview.effective.length === 0 && (
							<p className="px-5 py-4 text-sm text-text-muted">{t("mcp.noEffective")}</p>
						)}
						{overview.effective.map((server) => (
							<SettingsRow
								key={server.name}
								label={<span className="break-all">{server.name}</span>}
								description={<span className="break-all">{server.source ?? t("mcp.externalSource")}</span>}
							>
								<div className="flex flex-wrap items-center gap-2">
									<span className="text-xs text-text-muted">{t(server.disabled ? "mcp.disabled" : "mcp.enabled")}</span>
									{projectDocument?.servers?.[server.name]?.disabled !== undefined && (
										<Button
											variant="ghost"
											size="sm"
											disabled={!canWrite(projectDocument)}
											onClick={() => void write(server.name, { kind: "reset-disabled" }, projectDocument)}
										>
											{t("mcp.resetDisabled")}
										</Button>
									)}
									{(server.source !== document?.path || document?.target !== "project") && (
										<Button
											variant="outline"
											size="sm"
											disabled={!canWrite(projectDocument)}
											onClick={() =>
												void write(server.name, { kind: "toggle", disabled: !server.disabled }, projectDocument)
											}
										>
											{t(server.disabled ? "mcp.enableHere" : "mcp.disableHere")}
										</Button>
									)}
								</div>
							</SettingsRow>
						))}
					</SettingsSection>
					{active ? (
						<McpLiveSession
							key={sessionKey(active)}
							sessionRef={active}
							configuring={busy}
							configured={overview.effective}
						/>
					) : (
						<p className="text-xs text-text-muted">{t("mcp.openSession")}</p>
					)}
				</>
			)}
			{overview && (
				<details className="text-sm">
					<summary className="cursor-pointer font-medium">{t("mcp.sources")}</summary>
					<div className="mt-3 flex flex-col gap-3">
						{overview.documents
							.filter((item) => item.exists && item.path !== document?.path)
							.map((item) => (
								<div key={item.path}>
									<p className="break-all font-mono text-xs text-text-muted">{item.path}</p>
									<p className="mt-1 text-xs">
										{item.servers ? Object.keys(item.servers).join(" · ") || t("mcp.empty") : t("mcp.invalidFile")}
									</p>
								</div>
							))}
					</div>
				</details>
			)}
			{editor && (
				<McpServerEditor
					name={editor.name}
					server={editor.server}
					path={editor.document.path}
					busy={busy || loading}
					error={error}
					conflict={editorConflict}
					refreshed={editorRefreshed}
					latestServer={editor.name ? (editor.document.servers?.[editor.name] ?? null) : null}
					onRefresh={() => void refreshEditor()}
					onClose={() => {
						setEditor(null);
					}}
					onSave={(name, server) => {
						if (editor.name === null && Object.hasOwn(editor.document.servers ?? {}, name)) {
							setError(t("mcp.nameExists"));
							return;
						}
						void write(name, { kind: "save", server }, editor.document);
					}}
				/>
			)}
			<ConfirmDialog
				open={removing !== null}
				busy={busy}
				title={t("mcp.removeConfirm", { name: removing?.name })}
				destructive
				confirmLabel={t(busy ? "mcp.saving" : "mcp.remove")}
				cancelLabel={t("session.cancel")}
				onCancel={() => !busy && setRemoving(null)}
				onConfirm={() => {
					if (removing) void write(removing.name, { kind: "remove" }, removing.document);
				}}
			/>
		</>
	);
}
