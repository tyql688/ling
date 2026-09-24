import { formatRequestError } from "@renderer/lib/errors";
import { useTranslation } from "react-i18next";
import { VoiceCaptureError } from "./microphone-capture";

/** Localized recovery stays visible while upstream diagnostics remain available verbatim. */
export function VoiceError({ error }: { error: unknown }) {
	const { t } = useTranslation();
	if (error instanceof VoiceCaptureError) return <>{t(`voice.captureError.${error.code}`)}</>;
	return (
		<>
			<p>{t("voice.operationFailed")}</p>
			<details className="mt-1 text-xs">
				<summary className="cursor-pointer rounded-control focus-visible:bg-surface-hover">
					{t("voice.errorDetails")}
				</summary>
				<p className="mt-1 max-h-32 overflow-auto break-words whitespace-pre-wrap">{formatRequestError(error, t)}</p>
			</details>
		</>
	);
}
