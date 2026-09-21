import { LoadingTransition } from "@renderer/components/ui/loading-transition";
import { skinPreferenceAtom } from "@renderer/lib/appearance/skin-state";
import { useAtomValue } from "jotai";
import { useContext } from "react";
import { SkinBackdrop } from "./skin-backdrop";
import { SkinBackdropContext } from "./skin-backdrop-context";

/** Full-page loading owns a scene before the workbench's bounded viewports exist. */
export function SkinLoadingState({ label }: { label: string }) {
	const { layer, motion } = useContext(SkinBackdropContext);
	const preference = useAtomValue(skinPreferenceAtom);
	if (preference === "default") {
		return <LoadingTransition label={label} size="lg" className="h-screen w-screen bg-surface-under" />;
	}
	return (
		<div
			data-skin-loading="true"
			className="relative isolate h-screen w-screen overflow-hidden bg-surface-under"
			role="status"
			aria-live="polite"
			aria-busy="true"
		>
			<SkinBackdrop layer={layer} motion={motion} />
			<span className="sr-only">{label}</span>
		</div>
	);
}
