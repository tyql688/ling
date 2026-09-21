import { cn } from "@renderer/lib/utils";
import { motion } from "motion/react";
import { useId, type CSSProperties } from "react";

/** Inline segmented toggle (e.g. Queue | Guide). */
export function Segmented<T extends string>({
	value,
	onChange,
	options,
	ariaLabel,
	ariaLabelledBy,
	ariaDescribedBy,
	variant = "surface",
	disabled,
	className,
	style,
}: {
	value: T;
	onChange: (next: T) => void;
	options: ReadonlyArray<{ value: T; label: string; disabled?: boolean | undefined }>;
	disabled?: boolean | undefined;
	className?: string | undefined;
	style?: CSSProperties | undefined;
	ariaLabel?: string | undefined;
	ariaLabelledBy?: string | undefined;
	ariaDescribedBy?: string | undefined;
	/** Plain groups stay on their owner's material, such as the usage reading plane. */
	variant?: "surface" | "plain";
}) {
	const pillId = useId();
	return (
		<fieldset
			disabled={disabled}
			style={style}
			aria-label={ariaLabel}
			aria-labelledby={ariaLabelledBy}
			aria-describedby={ariaDescribedBy}
			className={cn(
				"flex min-w-0 flex-wrap rounded-control border-0 p-0.5 disabled:opacity-50",
				variant === "surface" && "skin-surface bg-surface-raised",
				className,
			)}
		>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					disabled={option.disabled}
					onClick={() => onChange(option.value)}
					aria-pressed={option.value === value}
					className={cn(
						"relative rounded-control px-3 py-1 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50",
						option.value === value ? "font-medium text-text-primary" : "text-text-muted hover:text-text-primary",
					)}
				>
					{option.value === value && (
						<motion.span
							layoutId={pillId}
							aria-hidden="true"
							className={cn(
								"absolute inset-0 rounded-control",
								variant === "surface" ? "bg-surface shadow-xs" : "bg-surface-hover",
							)}
							transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
						/>
					)}
					<span className="relative">{option.label}</span>
				</button>
			))}
		</fieldset>
	);
}
