import type { GlobalInstructionFile, GlobalInstructionKind } from "@ling/contracts/global-instructions";
import { Markdown } from "@renderer/components/markdown";
import { Button } from "@renderer/components/ui/button";
import { Segmented } from "@renderer/components/ui/segmented";
import { Textarea } from "@renderer/components/ui/textarea";
import { formatRequestError } from "@renderer/lib/errors";
import { useDomainApi } from "@renderer/lib/host-api-context";
import { isShortcutModifier } from "@renderer/lib/platform";
import { cn } from "@renderer/lib/utils";
import { ChevronDown, FolderOpen, SquarePen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type Mode = "edit" | "preview";

interface FileState {
	stored: string | null;
	draft: string;
	loading: boolean;
}

const EMPTY_DRAFT = "";

function fileStateFor(file: GlobalInstructionFile): FileState {
	return { stored: file.content, draft: file.content ?? EMPTY_DRAFT, loading: false };
}

/**
 * Manages Pi's three global prompt files (AGENTS.md / SYSTEM.md / APPEND_SYSTEM.md) under
 * `~/.pi/agent/`. These apply to every Pi session Ling embeds. Edits take effect on the
 * next session start (or after `/reload` in a running one) — the UI says so inline rather
 * than attempting an in-process prompt rebuild.
 */
export function GlobalInstructionsSection() {
	const hostGlobalInstructionsApi = useDomainApi("globalInstructions");
	const hostUiApi = useDomainApi("ui");

	const { t } = useTranslation();
	const [collapsed, setCollapsed] = useState(true);
	const [activeKind, setActiveKind] = useState<GlobalInstructionKind>("agents");
	const [files, setFiles] = useState<Record<GlobalInstructionKind, FileState>>({
		agents: { stored: null, draft: EMPTY_DRAFT, loading: true },
		system: { stored: null, draft: EMPTY_DRAFT, loading: true },
		"append-system": { stored: null, draft: EMPTY_DRAFT, loading: true },
	});
	const [mode, setMode] = useState<Mode>("edit");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const loadedRef = useRef(false);
	const mounted = useRef(true);
	const savePending = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const loadRevision = useRef(0);
	const loadAll = useCallback(async () => {
		const revision = ++loadRevision.current;
		setError(null);
		const kinds = ["agents", "system", "append-system"] as const;
		const results = await Promise.allSettled(kinds.map((kind) => hostGlobalInstructionsApi.read(kind)));
		if (!mounted.current || revision !== loadRevision.current) return;
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [formatRequestError(result.reason, t)] : [],
		);
		setFiles((previous) => {
			const next = { ...previous };
			for (const [index, result] of results.entries()) {
				if (result.status === "rejected") continue;
				const kind = kinds[index]!;
				const current = previous[kind];
				next[kind] = {
					...fileStateFor(result.value),
					draft:
						current.loading || current.draft === (current.stored ?? EMPTY_DRAFT)
							? (result.value.content ?? EMPTY_DRAFT)
							: current.draft,
				};
			}
			return next;
		});
		setError(failures.length ? failures.join("\n") : null);
	}, [hostGlobalInstructionsApi, t]);

	useEffect(() => {
		if (collapsed || loadedRef.current) return;
		loadedRef.current = true;
		void loadAll();
	}, [collapsed, loadAll]);

	const active = files[activeKind];
	const dirty = active.draft !== (active.stored ?? EMPTY_DRAFT);

	const setDraft = (next: string) => {
		setFiles((prev) => ({ ...prev, [activeKind]: { ...prev[activeKind], draft: next } }));
		setNotice(null);
	};

	const save = async () => {
		if (!dirty || savePending.current) return;
		savePending.current = true;
		const content = active.draft;
		setSaving(true);
		setError(null);
		setNotice(null);
		try {
			const result = await hostGlobalInstructionsApi.save({ kind: activeKind, content });
			if (!mounted.current) return;
			setFiles((prev) => ({
				...prev,
				[activeKind]: {
					...fileStateFor(result),
					draft: prev[activeKind].draft === content ? (result.content ?? EMPTY_DRAFT) : prev[activeKind].draft,
				},
			}));
			setNotice(t("settings.globalInstructionsSaved"));
		} catch (cause) {
			if (mounted.current) setError(formatRequestError(cause, t));
		} finally {
			savePending.current = false;
			if (mounted.current) setSaving(false);
		}
	};

	const reveal = async () => {
		try {
			await hostGlobalInstructionsApi.reveal(activeKind);
		} catch (cause) {
			if (mounted.current) setError(formatRequestError(cause, t));
		}
	};

	const openDir = async () => {
		try {
			await hostGlobalInstructionsApi.openDir();
		} catch (cause) {
			if (mounted.current) setError(formatRequestError(cause, t));
		}
	};

	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-wrap items-end justify-between gap-3 px-1">
				<button
					type="button"
					onClick={() => setCollapsed((value) => !value)}
					aria-expanded={!collapsed}
					className="group flex min-w-0 items-center gap-2 text-left"
				>
					<ChevronDown
						aria-hidden="true"
						className={cn("size-4 shrink-0 text-text-muted transition-transform", collapsed && "-rotate-90")}
					/>
					<span className="min-w-0">
						<span className="block text-base font-semibold tracking-tight text-text-primary">
							{t("settings.globalInstructions")}
						</span>
						<span className="mt-0.5 block text-xs leading-relaxed text-text-muted">
							{t("settings.globalInstructionsDescription")}
						</span>
					</span>
				</button>
				{hostUiApi.capabilities.nativePathOpen && (
					<Button variant="ghost" size="sm" onClick={() => void openDir()}>
						<FolderOpen className="size-4" aria-hidden="true" />
						{t("settings.globalInstructionsOpenDir")}
					</Button>
				)}
			</div>

			{!collapsed && (
				<div className="overflow-hidden rounded-panel border border-border-subtle bg-surface">
					<div className="flex flex-col gap-3 px-4 py-3.5 sm:px-5">
						{error && <p className="text-xs text-danger">{error}</p>}

						<div className="flex flex-wrap items-center justify-between gap-2">
							<Segmented<GlobalInstructionKind>
								value={activeKind}
								onChange={setActiveKind}
								ariaLabel={t("settings.globalInstructionsFile")}
								options={[
									{ value: "agents", label: "AGENTS.md" },
									{ value: "system", label: "SYSTEM.md" },
									{ value: "append-system", label: "APPEND_SYSTEM.md" },
								]}
							/>
							<Segmented<Mode>
								value={mode}
								onChange={setMode}
								ariaLabel={t("settings.globalInstructionsMode")}
								options={[
									{ value: "edit", label: t("settings.globalInstructionsEdit") },
									{ value: "preview", label: t("settings.globalInstructionsPreview") },
								]}
							/>
						</div>

						<p className="text-xs leading-relaxed text-text-muted">
							{t(`settings.globalInstructionsHelp_${activeKind}`)}
						</p>

						{active.loading ? (
							<div className="h-40 animate-pulse rounded-control border border-border-subtle bg-surface-hover/40" />
						) : mode === "edit" ? (
							<Textarea
								ref={textareaRef}
								spellCheck={false}
								value={active.draft}
								placeholder={t("settings.globalInstructionsPlaceholder")}
								onChange={(event) => setDraft(event.target.value)}
								onBlur={() => void save()}
								onKeyDown={(event) => {
									if (event.nativeEvent.isComposing) return;
									if (event.key === "Enter" && isShortcutModifier(event)) {
										event.preventDefault();
										void save();
									} else if (event.key === "Escape") {
										event.stopPropagation();
										setDraft(active.stored ?? EMPTY_DRAFT);
									}
								}}
								aria-label={t("settings.globalInstructionsFile")}
								readOnly={saving}
								className="h-80 resize-y font-mono text-xs leading-relaxed"
							/>
						) : (
							<div className="h-80 overflow-y-auto rounded-control border border-border-subtle bg-surface-hover/30 px-4 py-3">
								{active.draft.trim() === "" ? (
									<p className="text-xs text-text-muted">{t("settings.globalInstructionsEmptyPreview")}</p>
								) : (
									<Markdown text={active.draft} className="text-sm" />
								)}
							</div>
						)}

						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="flex items-center gap-2 text-xs text-text-muted">
								<span>
									{active.stored === null
										? t("settings.globalInstructionsStatusMissing")
										: t("settings.globalInstructionsStatusPresent")}
								</span>
								<span aria-hidden="true">·</span>
								<span className="tabular-nums">{active.draft.length}</span>
								{notice && (
									<>
										<span aria-hidden="true">·</span>
										<span className="text-text-primary">{notice}</span>
									</>
								)}
							</div>
							<div className="flex items-center gap-2">
								{hostUiApi.capabilities.nativePathReveal && (
									<Button variant="ghost" size="sm" onClick={() => void reveal()}>
										<SquarePen className="size-4" aria-hidden="true" />
										{t("settings.globalInstructionsReveal")}
									</Button>
								)}
								{error && (
									<Button
										variant="outline"
										size="sm"
										disabled={saving}
										onClick={() => {
											if (dirty) void save();
											else void loadAll();
										}}
									>
										{t("common.retry")}
									</Button>
								)}
								{saving && (
									<span role="status" className="text-xs text-text-muted">
										{t("settings.saving")}
									</span>
								)}
							</div>
						</div>

						<p className="text-xs leading-relaxed text-text-muted">{t("settings.globalInstructionsReloadHint")}</p>
					</div>
				</div>
			)}
		</section>
	);
}
