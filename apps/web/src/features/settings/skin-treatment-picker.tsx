import type { SkinArtworkTreatment } from "@ling/contracts/skins";
import { SKIN_TREATMENTS, type ResolvedSkinArtwork } from "@renderer/lib/appearance/skins/resolve-skin";
import { SkinBackdrop } from "@renderer/lib/appearance/skins/skin-backdrop";
import { Check } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";

/** Preview each treatment against the selected artwork with native radio keyboard navigation. */
export function SkinTreatmentPicker({
	layer,
	authoredTreatment,
	onChange,
	labelId,
	descriptionId,
}: {
	layer: ResolvedSkinArtwork;
	authoredTreatment: SkinArtworkTreatment | undefined;
	onChange: (treatment: SkinArtworkTreatment) => void;
	labelId: string;
	descriptionId: string | undefined;
}) {
	const name = useId();
	const { t } = useTranslation();
	return (
		<fieldset
			aria-labelledby={labelId}
			aria-describedby={descriptionId}
			className="grid w-full min-w-0 grid-cols-2 gap-2 border-0 p-0 sm:grid-cols-3"
		>
			{Object.values(SKIN_TREATMENTS).map((preset) => {
				const selected = preset.kind === layer.treatment.kind;
				const treatment = selected
					? layer.treatment
					: authoredTreatment?.kind === preset.kind
						? authoredTreatment
						: preset;
				return (
					<label
						key={preset.kind}
						htmlFor={`${name}-${preset.kind}`}
						aria-label={t(`skins.treatment_${preset.kind}`)}
						className="relative min-w-0 cursor-pointer"
					>
						<input
							id={`${name}-${preset.kind}`}
							type="radio"
							name={name}
							value={preset.kind}
							checked={selected}
							onChange={() => onChange(treatment)}
							className="peer absolute inset-0 z-10 size-full cursor-pointer opacity-0"
						/>
						<span className="flex flex-col gap-2 rounded-control border border-border-subtle bg-surface/50 p-2 text-text-muted transition-colors duration-150 hover:border-text-muted peer-checked:border-text-primary peer-checked:text-text-primary peer-focus-visible:bg-surface-hover motion-reduce:transition-none">
							<span className="relative isolate block h-16 overflow-hidden rounded-[max(0px,calc(var(--radius-control)-0.5rem))]">
								<SkinBackdrop layer={{ ...layer, treatment }} motion="none" preview />
								{treatment.kind === "glass" && (
									<span
										aria-hidden="true"
										className="absolute inset-0"
										style={{
											// Compact swatches show the balanced frost unless the author fixes its radius.
											backdropFilter: `blur(${String(treatment.blur ?? 12)}px) saturate(110%)`,
										}}
									/>
								)}
							</span>
							<span className="flex min-w-0 items-center justify-between gap-1 text-xs font-medium">
								<span>{t(`skins.treatment_${preset.kind}`)}</span>
								<Check aria-hidden="true" className={`size-3.5 shrink-0 ${selected ? "opacity-100" : "opacity-0"}`} />
							</span>
						</span>
					</label>
				);
			})}
		</fieldset>
	);
}
