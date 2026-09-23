import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { PickerPanel, PickerPopover, PickerRail } from "@renderer/components/ui/picker-panel";
import { pickerItemClass } from "@renderer/components/ui/menu-styles";
import { isImeCommandMenuKey, useImeGuard } from "@renderer/hooks/use-ime-guard";
import { cn } from "@renderer/lib/utils";
import { Command } from "cmdk";
import { ArrowLeft, Check, ChevronDown, Search, X } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	filterModelPickerOptions,
	filterModelPickerProviders,
	type ModelPickerOption,
	type ModelPickerProvider,
	modelPickerMatchParts,
	modelPickerOptionKey,
} from "./model-picker-options";

interface ModelPickerProps {
	options: readonly ModelPickerOption[];
	selected: Pick<ModelPickerOption, "provider" | "id"> | null;
	defaultModel?: Pick<ModelPickerOption, "provider" | "id"> | null;
	ownerKey?: string;
	placement?: "top-start" | "bottom-end";
	onSelect: (option: ModelPickerOption) => void;
	children: ReactNode;
	disabled?: boolean;
	triggerClassName?: string;
	triggerId?: string | undefined;
	triggerAriaLabelledBy?: string | undefined;
	triggerAriaDescribedBy?: string | undefined;
}

interface ProviderOption {
	id: string | null;
	name: string;
	count: number;
}

function providerKey(id: string | null): string {
	return JSON.stringify(["provider", id]);
}

function MatchedLabel({ text, query }: { text: string; query: string }) {
	return modelPickerMatchParts(text, query).map((part) =>
		part.matched ? (
			<mark key={part.start} className="bg-transparent font-semibold text-inherit">
				{part.text}
			</mark>
		) : (
			part.text
		),
	);
}

function ModelPickerContent({
	options,
	selected,
	defaultModel,
	onSelect,
	onClose,
	panelRef,
	id,
}: Omit<ModelPickerProps, "children"> & {
	onClose: () => void;
	panelRef: RefObject<HTMLDivElement | null>;
	id: string;
}) {
	const { t } = useTranslation();
	const [modelQuery, setModelQuery] = useState("");
	const [providerQuery, setProviderQuery] = useState("");
	const [provider, setProvider] = useState<ProviderOption | null>(null);
	const [providerPage, setProviderPage] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const ime = useImeGuard();
	const allMatches = useMemo(
		() => filterModelPickerOptions(options, modelQuery, { selected, defaultModel }),
		[options, modelQuery, selected, defaultModel],
	);
	const matches = provider === null ? allMatches : allMatches.filter((option) => option.provider === provider.id);
	const catalog = useMemo(() => {
		const catalog = new Map<string, ModelPickerProvider>();
		for (const option of options)
			catalog.set(option.provider, { id: option.provider, name: option.providerName, count: 0 });
		for (const option of allMatches) {
			const item = catalog.get(option.provider);
			if (item) item.count += 1;
		}
		return [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
	}, [options, allMatches]);
	const allProviders = { id: null, name: t("modelPicker.allProviders"), count: allMatches.length };
	const railProviders = [allProviders, ...catalog.filter((item) => item.count > 0 || item.id === provider?.id)];
	const providerMatches = useMemo(() => filterModelPickerProviders(catalog, providerQuery), [catalog, providerQuery]);
	const providers: ProviderOption[] = providerQuery.trim() ? providerMatches : [allProviders, ...providerMatches];
	const query = providerPage ? providerQuery : modelQuery;
	const [activeKey, setActiveKey] = useState(() => (matches[0] ? modelPickerOptionKey(matches[0]) : ""));
	const selectedKey = selected ? modelPickerOptionKey(selected) : null;
	const availableKeys = providerPage
		? providers.map((item) => providerKey(item.id))
		: matches.map(modelPickerOptionKey);
	const activeValue = availableKeys.includes(activeKey) ? activeKey : (availableKeys[0] ?? "");
	useLayoutEffect(() => {
		inputRef.current?.focus({ preventScroll: true });
	}, []);
	const changeQuery = (next: string) => {
		if (providerPage) setProviderQuery(next);
		else setModelQuery(next);
		// A new query always highlights its best match, even when the old selection still matches.
		setActiveKey("");
	};
	const showProviders = () => {
		setProviderPage(true);
		setActiveKey("");
		inputRef.current?.focus({ preventScroll: true });
	};
	const chooseProvider = (next: ProviderOption) => {
		setProvider(next.id === null ? null : next);
		setProviderPage(false);
		setActiveKey("");
		inputRef.current?.focus({ preventScroll: true });
	};
	const scopeName = provider?.name ?? t("modelPicker.allProviders");
	const searchLabel = providerPage
		? t("modelPicker.searchProviders")
		: provider
			? t("modelPicker.searchProvider", { provider: provider.name })
			: t("modelPicker.placeholder");
	return (
		<Command
			shouldFilter={false}
			loop
			value={activeValue}
			onValueChange={setActiveKey}
			label={searchLabel}
			className="h-full min-h-0 w-110 min-w-0 max-w-full"
			onKeyDownCapture={(event) => {
				if (ime.isComposing(event) && isImeCommandMenuKey(event)) {
					event.preventDefault();
					event.stopPropagation();
					return;
				}
			}}
		>
			<PickerPanel
				ref={panelRef}
				id={id}
				role="region"
				aria-label={t("modelPicker.title")}
				onEscapeKeyDown={(event) => {
					if (ime.isNativeComposing(event)) return;
					if (providerPage) {
						setProviderPage(false);
						setActiveKey("");
						inputRef.current?.focus({ preventScroll: true });
					} else onClose();
				}}
			>
				<div className="flex h-9 shrink-0 items-center gap-1.5 rounded-control px-1.5 focus-within:bg-surface-hover">
					<Search className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
					<Command.Input asChild value={query} onValueChange={changeQuery} {...ime.compositionProps}>
						<Input
							ref={inputRef}
							aria-label={searchLabel}
							placeholder={searchLabel}
							className="h-8 min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none"
						/>
					</Command.Input>
					{query.length > 0 && (
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="size-7"
							aria-label={t("modelPicker.clearSearch")}
							title={t("modelPicker.clearSearch")}
							onClick={() => {
								changeQuery("");
								inputRef.current?.focus({ preventScroll: true });
							}}
							onKeyDown={(event) => {
								if (event.key !== "Escape") event.stopPropagation();
							}}
						>
							<X className="size-3.5" aria-hidden="true" />
						</Button>
					)}
				</div>
				{(catalog.length > 1 || providerPage) && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						title={scopeName}
						className={cn("h-7 min-w-0 max-w-full self-start", !providerPage && "@min-[376px]/picker:hidden")}
						onClick={() => {
							if (providerPage) {
								setProviderPage(false);
								setActiveKey("");
								inputRef.current?.focus({ preventScroll: true });
							} else showProviders();
						}}
						onKeyDown={(event) => {
							if (event.key !== "Escape") event.stopPropagation();
						}}
					>
						{providerPage ? (
							<>
								<ArrowLeft className="size-3" aria-hidden="true" />
								{t("modelPicker.backToModels")}
							</>
						) : (
							<>
								<span className="min-w-0 truncate">{scopeName}</span>
								<ChevronDown className="size-3 shrink-0" aria-hidden="true" />
							</>
						)}
					</Button>
				)}
				<div className="flex min-h-0 flex-1 gap-1.5 overflow-hidden">
					{!providerPage && catalog.length > 1 && (
						<div className="hidden min-h-0 w-27 shrink-0 flex-col border-e border-border-subtle pe-1.5 @min-[376px]/picker:flex">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								aria-label={t("modelPicker.searchProviders")}
								title={t("modelPicker.searchProviders")}
								className="mb-1 w-full justify-between px-1.5 text-xs text-text-muted"
								onClick={showProviders}
								onKeyDown={(event) => {
									if (event.key !== "Escape") event.stopPropagation();
								}}
							>
								{t("modelPicker.providers")}
								<Search className="size-3" aria-hidden="true" />
							</Button>
							<PickerRail
								label={t("modelPicker.providers")}
								value={providerKey(provider?.id ?? null)}
								items={railProviders.map((item) => ({
									value: providerKey(item.id),
									label: item.name,
									content: (
										<>
											<span className="min-w-0 truncate">
												<MatchedLabel text={item.name} query={modelQuery} />
											</span>
											<span className="shrink-0 text-text-muted tabular-nums">{item.count}</span>
										</>
									),
								}))}
								onSelect={(value) => {
									const item = railProviders.find((item) => providerKey(item.id) === value);
									if (item) chooseProvider(item);
								}}
							/>
						</div>
					)}
					<Command.List
						label={providerPage ? t("modelPicker.providers") : t("modelPicker.title")}
						className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain"
					>
						{providerPage
							? providers.map((item) => (
									<Command.Item
										key={providerKey(item.id)}
										value={providerKey(item.id)}
										onSelect={() => chooseProvider(item)}
										className={cn(pickerItemClass, "min-h-8 justify-between")}
										title={item.id ? `${item.name}\n${item.id}` : item.name}
									>
										<span className="min-w-0 truncate">
											<MatchedLabel text={item.name} query={providerQuery} />
											{item.id && item.id.toLowerCase() !== item.name.toLowerCase() && (
												<span className="block truncate text-xs text-text-muted">
													<MatchedLabel text={item.id} query={providerQuery} />
												</span>
											)}
										</span>
										<span className="text-text-muted tabular-nums">{item.count}</span>
									</Command.Item>
								))
							: matches.map((option) => {
									const key = modelPickerOptionKey(option);
									return (
										<Command.Item
											key={key}
											value={key}
											onSelect={() => onSelect(option)}
											className={pickerItemClass}
											title={`${option.name}\n${option.provider}/${option.id}`}
										>
											<span className="min-w-0 flex-1">
												<span className="block truncate">
													<MatchedLabel text={option.name} query={modelQuery} />
												</span>
												<span className="block truncate text-xs text-text-muted">
													<MatchedLabel text={`${option.provider}/${option.id}`} query={modelQuery} />
												</span>
											</span>
											{selectedKey === key ? (
												<Check className="size-3 shrink-0" aria-hidden="true" />
											) : defaultModel?.provider === option.provider && defaultModel.id === option.id ? (
												<span className="shrink-0 text-xs text-text-muted">{t("modelPicker.default")}</span>
											) : null}
										</Command.Item>
									);
								})}
						{(providerPage ? providers.length === 0 : matches.length === 0) && (
							<div
								role="status"
								className="flex min-h-32 flex-col items-center justify-center gap-2 px-3 py-5 text-center text-ui text-text-muted"
							>
								<span>
									{providerPage
										? t("modelPicker.noMatchingProviders")
										: provider
											? t("modelPicker.noProviderResults", { provider: provider.name })
											: t("modelPicker.noResults")}
								</span>
								{!providerPage && provider && (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => {
											setProvider(null);
											setActiveKey("");
											inputRef.current?.focus({ preventScroll: true });
										}}
										onKeyDown={(event) => {
											if (event.key !== "Escape") event.stopPropagation();
										}}
									>
										{t("modelPicker.allProviders")}
									</Button>
								)}
							</div>
						)}
					</Command.List>
				</div>
				<div className="flex h-6 shrink-0 items-center justify-between gap-2 border-t border-border-subtle px-1.5 text-xs text-text-muted">
					<span role="status" className="min-w-0 truncate">
						{providerPage
							? t("modelPicker.providerCount", { count: providerMatches.length })
							: t("modelPicker.resultCount", { provider: scopeName, count: matches.length })}
					</span>
					<span className="shrink-0" aria-label={t("modelPicker.keyboardHint")}>
						Tab · ↑↓ · ↵ · Esc
					</span>
				</div>
			</PickerPanel>
		</Command>
	);
}

export function ModelPicker({
	children,
	disabled = false,
	ownerKey,
	placement = "bottom-end",
	triggerClassName,
	triggerId,
	triggerAriaLabelledBy,
	triggerAriaDescribedBy,
	...props
}: ModelPickerProps) {
	const { t } = useTranslation();
	const [openOwner, setOpenOwner] = useState<string | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const id = useId();
	const scopeKey = ownerKey ?? id;
	const open = !disabled && openOwner === scopeKey;
	useEffect(() => {
		setOpenOwner(null);
	}, [disabled, scopeKey]);
	useEffect(() => {
		if (!open) return;
		const dismissOutside = (event: Event) => {
			if (
				event.target instanceof Node &&
				!panelRef.current?.contains(event.target) &&
				!triggerRef.current?.contains(event.target)
			)
				setOpenOwner(null);
		};
		document.addEventListener("pointerdown", dismissOutside, true);
		document.addEventListener("focusin", dismissOutside, true);
		return () => {
			document.removeEventListener("pointerdown", dismissOutside, true);
			document.removeEventListener("focusin", dismissOutside, true);
		};
	}, [open]);
	const close = () => {
		setOpenOwner(null);
		triggerRef.current?.focus({ preventScroll: true });
	};
	return (
		<>
			<Button
				ref={triggerRef}
				id={triggerId}
				type="button"
				variant="ghost"
				size={null}
				disabled={disabled}
				aria-label={triggerAriaLabelledBy === undefined ? t("modelPicker.title") : undefined}
				aria-labelledby={triggerAriaLabelledBy}
				aria-describedby={triggerAriaDescribedBy}
				aria-controls={open ? id : undefined}
				aria-expanded={open}
				onClick={() => setOpenOwner(open ? null : scopeKey)}
				className={cn("min-w-0 justify-between gap-1.5", triggerClassName)}
			>
				{children}
				<ChevronDown className="size-3 shrink-0 text-text-muted" aria-hidden="true" />
			</Button>
			{open && (
				<PickerPopover anchorRef={triggerRef} placement={placement}>
					<ModelPickerContent
						{...props}
						id={id}
						panelRef={panelRef}
						onClose={close}
						onSelect={(option) => {
							close();
							props.onSelect(option);
						}}
					/>
				</PickerPopover>
			)}
		</>
	);
}
