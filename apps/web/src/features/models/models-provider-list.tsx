import { StatusGlyph } from "@renderer/components/ui/status-glyph";
import type { ProviderSummary } from "@ling/contracts/model";
import { ProviderGlyph } from "@renderer/features/models/provider-glyph";
import { cn } from "@renderer/lib/utils";
import { Plus } from "lucide-react";
import { motion } from "motion/react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { isProviderUsable } from "./models-navigation";

interface ModelsProviderListProps {
	providers: readonly ProviderSummary[];
	selectedId: string | null;
	busy?: boolean;
	onSelect: (providerId: string) => void;
	onAddProvider: () => void;
}

export function ModelsProviderList({
	providers,
	selectedId,
	busy = false,
	onSelect,
	onAddProvider,
}: ModelsProviderListProps) {
	const { t } = useTranslation();
	const titleId = useId();
	const connected = providers.filter(isProviderUsable);
	const others = providers.filter((provider) => !isProviderUsable(provider));

	return (
		<aside
			aria-labelledby={titleId}
			className="models-provider-list flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border-subtle bg-surface-raised/40 p-3"
		>
			<h2 id={titleId} className="sr-only">
				{t("models.providerListTitle")}
			</h2>
			<ProviderGroup
				label={t("models.groupConnected")}
				providers={connected}
				selectedId={selectedId}
				onSelect={onSelect}
			/>
			<ProviderGroup label={t("models.groupAll")} providers={others} selectedId={selectedId} onSelect={onSelect} />
			<button
				type="button"
				disabled={busy}
				onClick={onAddProvider}
				className="mt-1 flex min-h-11 items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-sm text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-50 sm:min-h-9"
			>
				<Plus className="size-4 shrink-0" aria-hidden="true" />
				{t("models.addProvider")}
			</button>
		</aside>
	);
}

function ProviderGroup({
	label,
	providers,
	selectedId,
	onSelect,
}: {
	label: string;
	providers: readonly ProviderSummary[];
	selectedId: string | null;
	onSelect: (providerId: string) => void;
}) {
	const { t } = useTranslation();
	const labelId = useId();
	if (providers.length === 0) return null;

	return (
		<section aria-labelledby={labelId} className="flex flex-col gap-0.5">
			<h3 id={labelId} className="px-2 pb-1 pt-2 text-xs text-text-muted">
				{label}
			</h3>
			{providers.map((provider) => {
				const selected = provider.id === selectedId;
				return (
					<button
						key={provider.id}
						type="button"
						data-provider-id={provider.id}
						aria-current={selected ? "page" : undefined}
						onClick={() => onSelect(provider.id)}
						className={cn(
							"relative flex min-h-11 items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-sm transition-colors sm:min-h-9",
							selected
								? "font-medium text-text-primary"
								: "text-text-muted hover:bg-surface-hover hover:text-text-primary",
						)}
					>
						{selected && (
							<motion.span
								layoutId="models-provider-pill"
								aria-hidden="true"
								className="absolute inset-0 rounded-control bg-surface-hover"
								transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
							/>
						)}
						<ProviderGlyph provider={provider.id} size={16} className="relative shrink-0" />
						<span className="relative min-w-0 flex-1 truncate">{provider.displayName}</span>
						<span
							className="relative"
							title={t(isProviderUsable(provider) ? "models.configured" : "models.notConfigured")}
						>
							<StatusGlyph status={isProviderUsable(provider) ? "neutral" : "attention"} className="size-3.5" />
							<span className="sr-only">
								{t(isProviderUsable(provider) ? "models.configured" : "models.notConfigured")}
							</span>
						</span>
					</button>
				);
			})}
		</section>
	);
}
