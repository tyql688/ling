import { ProviderGlyph } from "@renderer/features/models/provider-glyph";
import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import { isImeCommandMenuKey, useImeGuard } from "@renderer/hooks/use-ime-guard";
import {
	filterModelPickerOptions,
	type ModelPickerOption,
	modelPickerOptionKey,
} from "@renderer/features/models/model-picker-options";
import { cn } from "@renderer/lib/utils";
import { Command } from "cmdk";
import { Check, ChevronDown, Search } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface ModelPickerProps {
	options: readonly ModelPickerOption[];
	selected: Pick<ModelPickerOption, "provider" | "id"> | null;
	onSelect: (option: ModelPickerOption) => void;
	children: ReactNode;
	disabled?: boolean;
	triggerClassName?: string;
	triggerId?: string | undefined;
	triggerAriaLabelledBy?: string | undefined;
	triggerAriaDescribedBy?: string | undefined;
}

interface ModelPickerGroup {
	key: string;
	provider: string;
	providerName: string;
	options: ModelPickerOption[];
}

function groupModelOptions(options: readonly ModelPickerOption[]): ModelPickerGroup[] {
	const groups = new Map<string, ModelPickerGroup>();
	for (const option of options) {
		const key = JSON.stringify([option.provider, option.providerName]);
		const group = groups.get(key);
		if (group) group.options.push(option);
		else groups.set(key, { key, provider: option.provider, providerName: option.providerName, options: [option] });
	}
	return [...groups.values()];
}

export function ModelPicker({
	options,
	selected,
	onSelect,
	children,
	disabled = false,
	triggerClassName,
	triggerId,
	triggerAriaLabelledBy,
	triggerAriaDescribedBy,
}: ModelPickerProps) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeKey, setActiveKey] = useState("");
	const triggerRef = useRef<HTMLButtonElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const ime = useImeGuard();
	const selectedKey = selected ? modelPickerOptionKey(selected) : null;
	const filtered = useMemo(() => filterModelPickerOptions(options, query), [options, query]);
	const groups = useMemo(() => groupModelOptions(filtered), [filtered]);
	const openPicker = () => {
		ime.resetComposition();
		setQuery("");
		setActiveKey(
			selectedKey && options.some((option) => modelPickerOptionKey(option) === selectedKey)
				? selectedKey
				: options[0]
					? modelPickerOptionKey(options[0])
					: "",
		);
		setOpen(true);
	};
	useEffect(() => {
		if (!open || filtered.some((option) => modelPickerOptionKey(option) === activeKey)) return;
		setActiveKey(filtered[0] ? modelPickerOptionKey(filtered[0]) : "");
	}, [activeKey, filtered, open]);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				ime.resetComposition();
				setOpen(next);
			}}
		>
			<button
				ref={triggerRef}
				id={triggerId}
				type="button"
				disabled={disabled}
				aria-label={triggerAriaLabelledBy === undefined ? t("modelPicker.title") : undefined}
				aria-labelledby={triggerAriaLabelledBy}
				aria-describedby={triggerAriaDescribedBy}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={openPicker}
				className={cn(
					"inline-flex items-center justify-between gap-1.5 whitespace-nowrap transition-colors focus-visible:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50",
					triggerClassName,
				)}
			>
				{children}
				<ChevronDown className="size-3 shrink-0 text-text-muted" aria-hidden="true" />
			</button>
			<DialogContent
				size="medium"
				aria-describedby={undefined}
				className="top-24 translate-y-0 overflow-hidden rounded-panel p-2"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					inputRef.current?.focus();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					triggerRef.current?.focus();
				}}
				onEscapeKeyDown={(event) => {
					if (ime.isNativeComposing(event)) event.preventDefault();
				}}
			>
				<DialogTitle className="sr-only">{t("modelPicker.title")}</DialogTitle>
				<Command
					shouldFilter={false}
					value={activeKey}
					onValueChange={setActiveKey}
					onKeyDownCapture={(event) => {
						if (!ime.isComposing(event) || !isImeCommandMenuKey(event)) return;
						event.preventDefault();
						event.stopPropagation();
					}}
					aria-label={t("modelPicker.title")}
					className="w-full"
				>
					<div className="flex items-center gap-2 border-b border-border-subtle px-3">
						<Search className="size-3.5 shrink-0 text-text-muted" aria-hidden="true" />
						<Command.Input
							ref={inputRef}
							aria-label={t("modelPicker.placeholder")}
							value={query}
							onValueChange={setQuery}
							placeholder={t("modelPicker.placeholder")}
							className="w-full bg-transparent py-2.5 text-sm text-text-primary placeholder:text-text-muted"
							{...ime.compositionProps}
						/>
					</div>
					<Command.List aria-label={t("modelPicker.title")} className="max-h-[min(60vh,28rem)] overflow-y-auto p-1">
						{filtered.length === 0 && (
							<Command.Empty className="px-2 py-3 text-sm text-text-muted">{t("modelPicker.noResults")}</Command.Empty>
						)}
						{groups.map((group) => (
							<Command.Group
								key={group.key}
								heading={
									<span className="flex min-w-0 items-center gap-1.5">
										<ProviderGlyph provider={group.provider} size={12} />
										<span className="truncate">{group.providerName}</span>
										{group.providerName !== group.provider && (
											<span className="truncate font-mono text-xs opacity-70">{group.provider}</span>
										)}
									</span>
								}
								className="py-1 [&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:items-center [&_[cmdk-group-heading]]:gap-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-text-muted"
							>
								{group.options.map((option) => {
									const key = modelPickerOptionKey(option);
									return (
										<Command.Item
											key={key}
											value={key}
											onSelect={() => {
												onSelect(option);
												setOpen(false);
											}}
											className="flex min-h-10 w-full cursor-default items-center gap-2 rounded-control px-2 py-1.5 text-left text-sm text-text-primary outline-none data-[selected=true]:bg-surface-hover"
										>
											<ProviderGlyph provider={option.provider} size={16} />
											<span className="min-w-0 flex-1">
												<span className="block truncate">{option.name}</span>
												<span className="block truncate font-mono text-xs text-text-muted">
													{option.provider}/{option.id}
												</span>
											</span>
											{selectedKey === key && <Check className="size-3.5 shrink-0 text-accent" aria-hidden="true" />}
										</Command.Item>
									);
								})}
							</Command.Group>
						))}
					</Command.List>
				</Command>
			</DialogContent>
		</Dialog>
	);
}
