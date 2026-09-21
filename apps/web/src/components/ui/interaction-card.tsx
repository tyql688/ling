import { useState, type ComponentProps, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@renderer/lib/utils";
import { Button } from "./button";
import { ChoiceRow } from "./choice-row";

/** Shared shell for questions, approvals and Pi extension prompts; each caller owns its response protocol. */
export function InteractionCard({
	label,
	title,
	icon,
	meta,
	children,
	hint,
	footer,
	className,
}: {
	label: string;
	title: ReactNode;
	icon: ReactNode;
	meta?: ReactNode;
	children: ReactNode;
	hint?: ReactNode;
	footer: ReactNode;
	className?: string;
}) {
	const { t } = useTranslation();
	const [collapsed, setCollapsed] = useState(false);
	return (
		<section
			aria-label={label}
			className={cn("attention-prompt-card pointer-events-auto min-w-0 w-full rounded-panel", className)}
		>
			<div className="attention-prompt-card-surface flex max-h-[min(55dvh,32rem)] min-h-0 flex-col overflow-hidden">
				<div className="min-h-0 overflow-y-auto [overflow-wrap:anywhere]">
					<div className="flex items-center gap-2 px-4 py-3">
						<span className="shrink-0 text-text-muted" aria-hidden="true">
							{icon}
						</span>
						<h2 className="min-w-0 flex-1 whitespace-pre-wrap text-ui font-medium">{title}</h2>
						{meta && <span className="shrink-0 text-xs text-text-muted">{meta}</span>}
						<Button
							size="icon"
							variant="ghost"
							aria-label={t(collapsed ? "interactions.expand" : "interactions.minimize")}
							aria-expanded={!collapsed}
							onClick={() => setCollapsed(!collapsed)}
						>
							<ChevronDown
								className={cn("size-4 transition-transform motion-reduce:transition-none", !collapsed && "rotate-180")}
							/>
						</Button>
					</div>
					{!collapsed && <div className="grid auto-rows-max gap-3 px-4 pb-3">{children}</div>}
				</div>
				{!collapsed && (
					<div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-border-subtle px-4 py-2">
						{hint && <div className="min-w-0 basis-48 grow text-xs text-text-muted">{hint}</div>}
						<div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">{footer}</div>
					</div>
				)}
			</div>
		</section>
	);
}

/** Ignore the second click's toggle before confirming, including for multiple choice questions. */
export function InteractionChoice({
	onSelect,
	onConfirm,
	children,
	selected,
	...props
}: Omit<ComponentProps<typeof ChoiceRow>, "onClick" | "onDoubleClick" | "onChange" | "checked"> & {
	selected: boolean;
	onSelect(): void;
	onConfirm(): void;
}) {
	return (
		<ChoiceRow
			{...props}
			checked={selected}
			onClick={(event) => {
				if (event.detail >= 2) event.preventDefault();
			}}
			onChange={(event) => {
				if ((event.nativeEvent as MouseEvent).detail < 2) onSelect();
			}}
			onDoubleClick={onConfirm}
		>
			{children}
		</ChoiceRow>
	);
}
