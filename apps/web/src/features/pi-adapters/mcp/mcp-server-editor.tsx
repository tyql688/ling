import { mcpServerNameSchema, mcpServerSchema, type McpServer } from "@ling/contracts/mcp";
import { Button } from "@renderer/components/ui/button";
import {
	Dialog,
	DialogCloseButton,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@renderer/components/ui/dialog";
import { FeedbackNotice } from "@renderer/components/ui/feedback";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@renderer/components/ui/select";
import { formatRequestError } from "@renderer/lib/errors";
import { useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export function McpServerEditor({
	name: originalName,
	server,
	path,
	busy,
	error,
	conflict,
	refreshed,
	latestServer,
	onRefresh,
	onSave,
	onClose,
}: {
	name: string | null;
	server: McpServer | null;
	path: string;
	busy: boolean;
	error: string | null;
	conflict: boolean;
	refreshed: boolean;
	latestServer: McpServer | null;
	onRefresh(): void;
	onSave(name: string, server: McpServer): void;
	onClose(): void;
}) {
	const { t } = useTranslation();
	const id = useId();
	const advancedDetails = useRef<HTMLDetailsElement>(null);
	const [name, setName] = useState(originalName ?? "");
	// Empty arguments and embedded newlines need JSON to remain unambiguous.
	const initialTransport = server?.args?.some((arg) => arg === "" || /[\r\n]/.test(arg))
		? "advanced"
		: server?.url
			? "http"
			: server?.command || !server
				? "stdio"
				: "advanced";
	const [transport, setTransport] = useState(initialTransport);
	const [command, setCommand] = useState(server?.command ?? "");
	const [args, setArgs] = useState(server?.args?.join("\n") ?? "");
	const [url, setUrl] = useState(server?.url ?? "");
	const [httpTransport, setHttpTransport] = useState(server?.httpTransport ?? "streamable-http");
	const [advanced, setAdvanced] = useState(() => {
		if (!server) return '{\n  "approveTools": true\n}';
		if (initialTransport === "advanced") return JSON.stringify(server, null, 2);
		const rest = { ...server };
		for (const key of ["command", "args", "url", "httpTransport"]) delete rest[key];
		return JSON.stringify(rest, null, 2);
	});
	const [invalid, setInvalid] = useState<{ field: string; message: string } | null>(null);
	const parsedAdvanced = useMemo(() => {
		try {
			return mcpServerSchema.safeParse(JSON.parse(advanced));
		} catch {
			// A JSON draft can be incomplete while typing; submission owns the visible error.
			return null;
		}
	}, [advanced]);
	const approval = parsedAdvanced?.success ? parsedAdvanced.data.approveTools : undefined;
	const approvalMode = Array.isArray(approval) ? "custom" : approval === undefined ? "inherit" : String(approval);
	function fail(field: string, message: string) {
		setInvalid({ field, message });
		if (field === "advanced" && advancedDetails.current) advancedDetails.current.open = true;
		document.getElementById(`${id}-${field}`)?.focus();
	}
	function changeApproval(next: string) {
		if (!parsedAdvanced?.success) {
			fail("advanced", t("mcp.invalidJson"));
			return;
		}
		const value = { ...parsedAdvanced.data };
		if (next === "inherit") delete value.approveTools;
		else value.approveTools = next === "custom" ? [] : next === "true";
		setAdvanced(JSON.stringify(value, null, 2));
		setInvalid(null);
		if (next === "custom" && advancedDetails.current) {
			advancedDetails.current.open = true;
			document.getElementById(`${id}-advanced`)?.focus();
		}
	}
	function applyConnection(value: McpServer) {
		if (transport === "stdio") {
			value.command = command.trim();
			if (args || server?.args !== undefined || !server) value.args = args ? args.split("\n") : [];
		}
		if (transport === "http") {
			value.url = url.trim();
			// Opening and saving an existing service must not materialize omitted defaults.
			if (server?.httpTransport !== undefined || !server || httpTransport !== "streamable-http")
				value.httpTransport = httpTransport;
		}
	}
	function changeTransport(next: string) {
		try {
			const value = mcpServerSchema.parse(JSON.parse(advanced));
			if (next === "advanced") {
				if ((transport === "stdio" && command) || (transport === "http" && url)) applyConnection(value);
			} else if (transport === "advanced") {
				if (next === "stdio" && value.args?.some((arg) => arg === "" || /[\r\n]/.test(arg))) {
					fail("advanced", t("mcp.multilineArgs"));
					return;
				}
				if (value.command) setCommand(value.command);
				if (value.args) setArgs(value.args.join("\n"));
				if (value.url) setUrl(value.url);
				if (value.httpTransport) setHttpTransport(value.httpTransport);
				for (const key of ["command", "args", "url", "httpTransport", "socket"]) delete value[key];
			}
			setAdvanced(JSON.stringify(value, null, 2));
			setTransport(next);
			setInvalid(null);
		} catch (cause) {
			fail("advanced", formatRequestError(cause));
		}
	}
	function submit() {
		const parsedName = mcpServerNameSchema.safeParse(originalName ?? name.trim());
		if (!parsedName.success || (originalName === null && /\s/.test(name.trim()))) {
			fail("name", t("mcp.invalidName"));
			return;
		}
		if (transport === "stdio" && !command.trim()) {
			fail("command", t("mcp.commandRequired"));
			return;
		}
		if (transport === "http" && !mcpServerSchema.safeParse({ url: url.trim() }).success) {
			fail("url", t("mcp.invalidUrl"));
			return;
		}
		try {
			const extra: unknown = JSON.parse(advanced);
			if (typeof extra === "object" && extra !== null && ("mcpServers" in extra || "mcp-servers" in extra)) {
				fail("advanced", t("mcp.singleServiceJson"));
				return;
			}
			const value = mcpServerSchema.parse(extra);
			applyConnection(value);
			const parsed = mcpServerSchema.parse(value);
			setInvalid(null);
			onSave(parsedName.data, parsed);
		} catch (cause) {
			fail("advanced", `${t("mcp.invalidJson")} ${formatRequestError(cause)}`);
		}
	}
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy) onClose();
			}}
		>
			<DialogContent
				size="small"
				className="flex flex-col"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					const field =
						originalName === null
							? "name"
							: transport === "stdio"
								? "command"
								: transport === "http"
									? "url"
									: "advanced";
					document.getElementById(`${id}-${field}`)?.focus();
				}}
			>
				<DialogCloseButton disabled={busy} aria-label={t("session.cancel")} />
				<DialogHeader>
					<DialogTitle>{t(originalName ? "mcp.edit" : "mcp.add")}</DialogTitle>
					<DialogDescription className="break-all">{path}</DialogDescription>
				</DialogHeader>
				<form
					className="mt-4 flex min-h-0 flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (!busy && !conflict) submit();
					}}
				>
					<div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain">
						{(invalid || error) && (
							<FeedbackNotice tone="danger" title={t("mcp.saveFailed")}>
								<span id={`${id}-error`}>{invalid?.message || error}</span>
								{error && (
									<Button
										className="mt-2"
										type="button"
										size="sm"
										variant="outline"
										disabled={busy}
										onClick={onRefresh}
									>
										{t("mcp.refreshDraft")}
									</Button>
								)}
							</FeedbackNotice>
						)}
						{refreshed && !conflict && !error && (
							<FeedbackNotice tone="info">
								{t("mcp.draftRetained")}
								{originalName && (
									<details className="mt-2">
										<summary className="cursor-pointer">{t("mcp.latestSaved")}</summary>
										<pre className="mt-2 whitespace-pre-wrap break-all text-xs">
											{latestServer ? JSON.stringify(latestServer, null, 2) : t("mcp.serviceRemoved")}
										</pre>
									</details>
								)}
							</FeedbackNotice>
						)}
						<div className="flex flex-col gap-1.5">
							<label htmlFor={`${id}-name`} className="text-sm font-medium">
								{t("mcp.name")}
							</label>
							<Input
								id={`${id}-name`}
								value={name}
								disabled={busy || originalName !== null}
								placeholder="my-service"
								aria-invalid={invalid?.field === "name" || undefined}
								aria-describedby={`${id}-name-hint${invalid?.field === "name" ? ` ${id}-error` : ""}`}
								onChange={(event) => setName(event.target.value)}
							/>
							<p id={`${id}-name-hint`} className="text-xs leading-relaxed text-text-muted">
								{t("mcp.nameHint")}
							</p>
						</div>
						<div className="flex flex-col gap-1.5">
							<span className="text-sm font-medium">{t("mcp.transport")}</span>
							<Select value={transport} disabled={busy} onValueChange={changeTransport}>
								<SelectTrigger aria-label={t("mcp.transport")} className="w-full">
									<SelectValue>{t(`mcp.transport_${transport}`)}</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{["stdio", "http", "advanced"].map((value) => (
										<SelectItem key={value} value={value}>
											{t(`mcp.transport_${value}`)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						{transport === "stdio" && (
							<>
								<div className="flex flex-col gap-1.5">
									<label htmlFor={`${id}-command`} className="text-sm font-medium">
										{t("mcp.command")}
									</label>
									<Input
										id={`${id}-command`}
										value={command}
										disabled={busy}
										placeholder="npx"
										aria-invalid={invalid?.field === "command" || undefined}
										aria-describedby={invalid?.field === "command" ? `${id}-error` : undefined}
										onChange={(event) => setCommand(event.target.value)}
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<label htmlFor={`${id}-args`} className="text-sm font-medium">
										{t("mcp.args")}
									</label>
									<Textarea
										id={`${id}-args`}
										rows={3}
										className="font-mono"
										value={args}
										disabled={busy}
										placeholder={"-y\npackage-name"}
										onChange={(event) => setArgs(event.target.value)}
									/>
									<p className="text-xs text-text-muted">{t("mcp.argsHint")}</p>
								</div>
							</>
						)}
						{transport === "http" && (
							<>
								<div className="flex flex-col gap-1.5">
									<label htmlFor={`${id}-url`} className="text-sm font-medium">
										{t("mcp.url")}
									</label>
									<Input
										id={`${id}-url`}
										value={url}
										disabled={busy}
										placeholder="https://example.com/mcp"
										aria-invalid={invalid?.field === "url" || undefined}
										aria-describedby={invalid?.field === "url" ? `${id}-error` : undefined}
										onChange={(event) => setUrl(event.target.value)}
									/>
								</div>
								<Select
									value={httpTransport}
									disabled={busy}
									onValueChange={(value) => setHttpTransport(value as typeof httpTransport)}
								>
									<SelectTrigger className="w-full" aria-label={t("mcp.httpTransport")}>
										<SelectValue>{httpTransport === "sse" ? "SSE" : "Streamable HTTP"}</SelectValue>
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="streamable-http">Streamable HTTP</SelectItem>
										<SelectItem value="sse">SSE</SelectItem>
									</SelectContent>
								</Select>
							</>
						)}
						<div className="flex flex-col gap-1.5">
							<span className="text-sm font-medium">{t("mcp.approval")}</span>
							<Select value={approvalMode} disabled={busy || !parsedAdvanced?.success} onValueChange={changeApproval}>
								<SelectTrigger
									className="w-full"
									aria-label={t("mcp.approval")}
									aria-describedby={`${id}-approval-hint`}
								>
									<SelectValue>{t(`mcp.approval_${approvalMode}`)}</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{["true", "false", "inherit", "custom"].map((value) => (
										<SelectItem key={value} value={value}>
											{t(`mcp.approval_${value}`)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p id={`${id}-approval-hint`} className="text-xs leading-relaxed text-text-muted">
								{t(approvalMode === "custom" ? "mcp.approvalCustomHint" : "mcp.approvalHint")}
							</p>
						</div>
						<details ref={advancedDetails} open={transport === "advanced" || undefined}>
							<summary className="cursor-pointer text-sm font-medium">{t("mcp.advanced")}</summary>
							<div className="mt-2 flex flex-col gap-2">
								<Textarea
									id={`${id}-advanced`}
									aria-label={t("mcp.advanced")}
									rows={7}
									spellCheck={false}
									className="font-mono text-xs"
									value={advanced}
									disabled={busy}
									aria-invalid={invalid?.field === "advanced" || undefined}
									aria-describedby={invalid?.field === "advanced" ? `${id}-error` : undefined}
									onChange={(event) => setAdvanced(event.target.value)}
								/>
								<p className="text-xs leading-relaxed text-text-muted">{t("mcp.advancedHint")}</p>
							</div>
						</details>
						{!server && <p className="text-xs leading-relaxed text-text-muted">{t("mcp.newHint")}</p>}
					</div>
					<DialogFooter>
						<Button type="button" variant="outline" disabled={busy} onClick={onClose}>
							{t("session.cancel")}
						</Button>
						<Button type="submit" disabled={busy || conflict}>
							{t(busy ? "mcp.saving" : "mcp.save")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
