import { cn } from "@renderer/lib/utils";
import { type ReactNode, useId } from "react";

interface SettingsCollectionProps {
	children: ReactNode;
	className?: string;
}

/**
 * Settings collections share one boundary and one row rhythm. Feature pages own
 * their row contents, while this primitive owns the visual list contract.
 */
export function SettingsCollection({ children, className }: SettingsCollectionProps) {
	return (
		<div
			className={cn(
				"divide-y divide-border-subtle overflow-hidden rounded-panel border border-border-subtle bg-card/35",
				className,
			)}
		>
			{children}
		</div>
	);
}

interface SettingsSectionProps {
	title?: string;
	action?: ReactNode;
	description?: string;
	children: ReactNode;
}

export function SettingsSection({ title, action, description, children }: SettingsSectionProps) {
	return (
		<section className="flex flex-col gap-3">
			{(title || action) && (
				<div className="flex flex-wrap items-end justify-between gap-3 px-1">
					{title && (
						<div className="min-w-0">
							<h2 className="text-base font-semibold tracking-tight text-text-primary">{title}</h2>
							{description && <p className="mt-0.5 text-xs leading-relaxed text-text-muted">{description}</p>}
						</div>
					)}
					{action}
				</div>
			)}
			<SettingsCollection>{children}</SettingsCollection>
		</section>
	);
}

interface SettingsRowProps {
	label: ReactNode;
	description?: ReactNode;
	children: ReactNode;
	className?: string;
	layout?: "default" | "toggle";
}

function rowClassName(layout: "default" | "toggle" | "stacked", className?: string): string {
	return cn(
		layout === "toggle"
			? "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3.5 sm:gap-8 sm:px-5"
			: layout === "stacked"
				? "flex min-w-0 flex-col items-stretch gap-3 px-4 py-3.5 sm:px-5"
				: "flex flex-col items-stretch justify-between gap-3 px-4 py-3.5 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] sm:items-center sm:gap-8 sm:px-5",
		className,
	);
}

function ControlSlot({
	children,
	compact,
	stacked = false,
}: {
	children: ReactNode;
	compact: boolean;
	stacked?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-2",
				stacked ? "min-w-0 w-full" : "sm:justify-end",
				!compact && "max-sm:[&_button]:min-h-10 max-sm:[_[data-slot=select-trigger]]:min-h-10",
			)}
		>
			{children}
		</div>
	);
}

export function SettingsRow({ label, description, children, className, layout = "default" }: SettingsRowProps) {
	return (
		<div className={rowClassName(layout, className)}>
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="text-sm font-medium text-text-primary">{label}</span>
				{description && <span className="max-w-xl text-ui leading-relaxed text-text-muted">{description}</span>}
			</div>
			<ControlSlot compact={layout === "toggle"}>{children}</ControlSlot>
		</div>
	);
}

interface SettingsFieldIds {
	controlId: string;
	labelId: string;
	descriptionId: string | undefined;
}

interface SettingsFieldRowProps {
	label: ReactNode;
	description?: ReactNode;
	children: (ids: SettingsFieldIds) => ReactNode;
	className?: string;
	group?: boolean;
	/** Long option groups use the whole row instead of competing with their description. */
	layout?: "default" | "stacked";
}

/** Field-type settings row: the shared row establishes the accessible relationship between label, description, and control. */
export function SettingsFieldRow({
	label,
	description,
	children,
	className,
	group = false,
	layout = "default",
}: SettingsFieldRowProps) {
	const generatedId = useId();
	const controlId = `${generatedId}-control`;
	const labelId = `${generatedId}-label`;
	const descriptionId = description === undefined ? undefined : `${generatedId}-description`;
	return (
		<div className={rowClassName(layout, className)}>
			<div className="flex min-w-0 flex-col gap-0.5">
				{group ? (
					<span id={labelId} className="text-sm font-medium text-text-primary">
						{label}
					</span>
				) : (
					<label id={labelId} htmlFor={controlId} className="text-sm font-medium text-text-primary">
						{label}
					</label>
				)}
				{description !== undefined && (
					<span id={descriptionId} className="max-w-xl text-ui leading-relaxed text-text-muted">
						{description}
					</span>
				)}
			</div>
			<ControlSlot compact={false} stacked={layout === "stacked"}>
				{children({ controlId, labelId, descriptionId })}
			</ControlSlot>
		</div>
	);
}
