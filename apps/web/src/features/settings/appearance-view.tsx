import { useDomainApi } from "@renderer/lib/host-api-context";
import {
	SKIN_ID_PATTERN,
	skinMediaUrl,
	type SkinAppearanceMode,
	type SkinArtworkScope,
	type SkinManifest,
	type UserSkinSnapshot,
} from "@ling/contracts/skins";
import { errorMessage } from "@ling/contracts/ling-error";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Segmented } from "@renderer/components/ui/segmented";
import { SettingsFieldRow, SettingsRow, SettingsSection } from "@renderer/components/ui/settings-list";
import { SettingsPage } from "@renderer/components/ui/settings-page";
import {
	skinExpressionAtom,
	skinLoadErrorAtom,
	skinPreferenceAtom,
	skinSceneOverridesAtom,
	userSkinsAtom,
	type SkinPreference,
} from "@renderer/lib/appearance/skin-state";
import { BUILTIN_SKINS, DEFAULT_SKIN_MANIFEST, type BuiltinSkin } from "@renderer/lib/appearance/skins/builtin-skins";
import {
	resolveSkin,
	selectResolvedSkinMode,
	SKIN_SCENE_VISIBILITY,
	type ResolvedSkinMode,
	type SkinExpression,
} from "@renderer/lib/appearance/skins/resolve-skin";
import { SkinBackdrop } from "@renderer/lib/appearance/skins/skin-backdrop";
import type { ThemePreference } from "@renderer/lib/appearance/theme-state";
import { useReducedTransparency } from "@renderer/lib/appearance/use-skin";
import type { ThemeController } from "@renderer/lib/appearance/use-theme";
import { nativeTransparencyAtom } from "@renderer/lib/appearance/window-state";
import { cn } from "@renderer/lib/utils";
import { useAtom, useAtomValue, useStore } from "jotai";
import { Check, FolderOpen, Trash2, TriangleAlert, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SkinTreatmentPicker } from "./skin-treatment-picker";

const THEME_VALUES: ThemePreference[] = ["system", "light", "dark"];
const EXPRESSION_VALUES: SkinExpression[] = ["balanced", "immersive"];
const SCOPE_VALUES: SkinArtworkScope[] = ["conversation", "window"];

interface GallerySkin {
	preference: SkinPreference;
	manifest: SkinManifest;
	name: string;
	description: string;
	assetUrl(asset: string): string;
	customId?: string;
}

function PreviewScene({ mode, large = false }: { mode: ResolvedSkinMode; large?: boolean }) {
	const { t } = useTranslation();
	const conversationOnly = mode.artwork?.scope === "conversation";
	const token = (name: keyof ResolvedSkinMode["vars"]): string => {
		const value = mode.vars[name];
		if (value === undefined) throw new Error(`Missing resolved skin token: ${String(name)}`);
		return value;
	};
	return (
		<div
			aria-hidden="true"
			className={cn("relative isolate flex overflow-hidden border", large ? "h-52" : "h-24")}
			style={{
				// Resolve nested var() aliases locally; the light preview must never inherit dark app tokens.
				...mode.vars,
				background: mode.palette.canvas,
				borderColor: token("--color-border-subtle"),
				borderRadius: large ? token("--radius-panel") : token("--radius-control"),
			}}
		>
			{!conversationOnly && <SkinBackdrop layer={mode.artwork} motion="none" preview />}
			<div
				className={cn("relative shrink-0 border-r", large ? "w-[24%] p-3" : "w-[24%] p-1.5")}
				style={{
					background: token("--color-sidebar"),
					borderColor: token("--color-border-subtle"),
					backdropFilter: token("--glass-chrome-filter"),
				}}
			>
				{large ? (
					<div
						className="text-xs font-semibold"
						style={{ color: token("--color-scene-text"), fontFamily: token("--font-sans"), opacity: 0.72 }}
					>
						Aa
					</div>
				) : (
					<div className="h-1 w-3/5 rounded-full" style={{ background: token("--color-scene-text"), opacity: 0.7 }} />
				)}
				<div className={cn("space-y-1.5", large ? "mt-6" : "mt-3")}>
					{[0.82, 0.62, 0.72].map((width) => (
						<div
							key={width}
							className={cn("rounded-full", large ? "h-1.5" : "h-1")}
							style={{ width: `${String(width * 100)}%`, background: token("--color-scene-text"), opacity: 0.2 }}
						/>
					))}
				</div>
			</div>
			<div
				className="relative isolate flex min-w-0 flex-1 flex-col"
				style={{
					background: conversationOnly ? "transparent" : token("--color-conversation"),
					backdropFilter: token("--glass-chrome-filter"),
				}}
			>
				{conversationOnly && <SkinBackdrop layer={mode.artwork} motion="none" preview tint />}
				<div className={cn("flex items-center px-2", large ? "h-9 gap-2" : "h-5 gap-1")}>
					<div
						className={cn(large ? "h-6 w-28" : "h-3 w-12")}
						style={{
							background: token("--color-surface-hover"),
							borderRadius: token("--radius-control"),
						}}
					/>
				</div>
				<div className="relative flex min-h-0 flex-1 flex-col">
					<div className={cn("flex min-h-0 flex-1 flex-col justify-center", large ? "gap-2 p-3" : "gap-1 p-2")}>
						{large ? (
							<>
								<p
									className="truncate text-sm font-semibold"
									style={{ color: token("--color-scene-text"), fontFamily: token("--font-sans") }}
								>
									{t("skins.previewSampleTitle")}
								</p>
								<div className="scene-surface flex min-w-0 items-baseline gap-2 text-xs">
									<p className="truncate" style={{ color: token("--color-scene-text-muted") }}>
										{t("skins.previewSampleBody")}
									</p>
									<code className="md-inline-code shrink-0" style={{ fontFamily: token("--font-mono") }}>
										pnpm dev
									</code>
								</div>
							</>
						) : (
							<>
								<div
									className="h-1.5 w-3/5 rounded-full"
									style={{ background: token("--color-scene-text"), opacity: 0.76 }}
								/>
								<div
									className="h-1 w-2/5 rounded-full"
									style={{ background: token("--color-scene-text"), opacity: 0.24 }}
								/>
							</>
						)}
						{large && (
							<div
								className="mt-1 flex h-9 shrink-0 items-center gap-2 px-3"
								style={{
									background: token("--color-scene-code-block"),
									borderRadius: token("--radius-control"),
									textShadow: "none",
								}}
							>
								<code
									className="truncate text-xs"
									style={{ color: token("--color-scene-text"), fontFamily: token("--font-mono") }}
								>
									{`const theme = "${t("skins.previewReady")}";`}
								</code>
							</div>
						)}
					</div>
					<div
						className={cn("mx-2 mb-2 flex shrink-0 items-center justify-between border px-2", large ? "h-9" : "h-4")}
						style={{
							background: token("--color-composer"),
							backdropFilter: token("--glass-composer-filter"),
							borderColor: `color-mix(in srgb, ${token("--color-scene-text")} 14%, transparent)`,
							borderRadius: token("--radius-panel"),
							textShadow: "none",
						}}
					>
						{large && (
							<>
								<span className="text-xs" style={{ color: token("--color-scene-control-muted") }}>
									Aa
								</span>
								<span
									className="px-2 py-1 text-xs font-medium"
									style={{
										background: token("--color-btn-primary"),
										color: token("--color-btn-primary-foreground"),
										borderRadius: token("--radius-control"),
									}}
								>
									{t("skins.previewAction")}
								</span>
							</>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

function SkinCard({
	skin,
	mode,
	expression,
	forceOpaque,
	selected,
	onSelect,
	onDelete,
	deleteLabel,
}: {
	skin: GallerySkin;
	mode: SkinAppearanceMode;
	expression: SkinExpression;
	forceOpaque: boolean;
	selected: boolean;
	onSelect(): void;
	onDelete?: () => void;
	deleteLabel?: string;
}) {
	const sceneOverride = useAtomValue(skinSceneOverridesAtom)[skin.preference];
	const preview = useMemo(
		() =>
			selectResolvedSkinMode(resolveSkin(skin.manifest, expression, skin.assetUrl, forceOpaque, sceneOverride), mode),
		[expression, forceOpaque, mode, sceneOverride, skin],
	);
	return (
		<div className="group relative">
			<button
				type="button"
				onClick={onSelect}
				aria-pressed={selected}
				className={cn(
					"w-full rounded-panel border p-2.5 text-left transition-[transform,border-color,background-color] duration-150 hover:-translate-y-0.5 active:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none",
					selected
						? "border-text-primary/25 bg-surface-hover"
						: "border-border-subtle hover:border-border-strong hover:bg-surface-hover/50",
				)}
			>
				<PreviewScene mode={preview} />
				<div className="mt-2 flex items-center gap-1.5 px-0.5">
					<span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{skin.name}</span>
					{selected && <Check className="skin-selected-check size-3.5 shrink-0 text-text-primary" aria-hidden="true" />}
				</div>
				<p className="mt-0.5 truncate px-0.5 text-xs text-text-muted">{skin.description}</p>
			</button>
			{onDelete && (
				<button
					type="button"
					aria-label={deleteLabel}
					title={deleteLabel}
					onClick={onDelete}
					className="absolute right-4 top-4 rounded-control border border-border-subtle bg-popover p-1 text-text-muted opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
				>
					<Trash2 className="size-3.5" aria-hidden="true" />
				</button>
			)}
		</div>
	);
}

function builtinGallerySkin(skin: BuiltinSkin, name: string, description: string): GallerySkin {
	return {
		preference: `builtin:${skin.id}`,
		manifest: skin.manifest,
		name,
		description,
		assetUrl: skin.assetUrl,
	};
}

function customGallerySkin(skin: UserSkinSnapshot): GallerySkin | null {
	if (skin.manifest === null || skin.error !== null) return null;
	return {
		preference: `custom:${skin.id}`,
		manifest: skin.manifest,
		name: skin.manifest.meta.name,
		description: skin.manifest.meta.description,
		assetUrl: (asset) => skinMediaUrl(skin.id, asset, skin.revision),
		customId: skin.id,
	};
}

export function AppearanceView({ themeController }: { themeController: ThemeController }) {
	const hostUiApi = useDomainApi("ui");
	const hostSkinsApi = useDomainApi("skins");

	const { t } = useTranslation();
	const store = useStore();
	const { preference: themePreference, setPreference: setThemePreference, studioAppearance: mode } = themeController;
	const [preference, setPreference] = useAtom(skinPreferenceAtom);
	const [expression, setExpression] = useAtom(skinExpressionAtom);
	const [sceneOverrides, setSceneOverrides] = useAtom(skinSceneOverridesAtom);
	const sceneOverride = sceneOverrides[preference];
	const [userSkins, setUserSkins] = useAtom(userSkinsAtom);
	const [loadError, setLoadError] = useAtom(skinLoadErrorAtom);
	const [nativeTransparency, setNativeTransparency] = useAtom(nativeTransparencyAtom);
	const [artQuery, setArtQuery] = useState("");
	const [previousPreference, setPreviousPreference] = useState<SkinPreference | null>(null);
	const forceOpaque = useReducedTransparency();

	const stock: GallerySkin = useMemo(
		() => ({
			preference: "default",
			manifest: DEFAULT_SKIN_MANIFEST,
			name: t("skins.default"),
			description: t("skins.defaultDescription"),
			assetUrl: (asset) => {
				throw new Error(`The default skin has no artwork asset ${asset}`);
			},
		}),
		[t],
	);
	const builtins = useMemo(
		() => BUILTIN_SKINS.map((skin) => builtinGallerySkin(skin, t(skin.nameKey), t(skin.descriptionKey))),
		[t],
	);
	const customs = useMemo(
		() => userSkins?.skins.map(customGallerySkin).filter((skin): skin is GallerySkin => skin !== null) ?? [],
		[userSkins],
	);
	const invalidCustoms = userSkins?.skins.filter((skin) => skin.error !== null) ?? [];
	const allSkins = [stock, ...builtins, ...customs];
	const selected = allSkins.find((skin) => skin.preference === preference) ?? stock;
	const previous = allSkins.find((skin) => skin.preference === previousPreference);
	const selectSkin = (next: SkinPreference) => {
		if (next === preference) return;
		setPreviousPreference(preference);
		setPreference(next);
	};
	const query = artQuery.trim().toLocaleLowerCase();
	const artSkins = builtins.filter(
		(skin) => skin.manifest.kind === "art" && `${skin.name} ${skin.description}`.toLocaleLowerCase().includes(query),
	);
	const selectedResolved = useMemo(
		() => resolveSkin(selected.manifest, expression, selected.assetUrl, forceOpaque, sceneOverride),
		[expression, forceOpaque, sceneOverride, selected],
	);
	const selectedMode = selectResolvedSkinMode(selectedResolved, mode);
	const nativeTransparencyAvailable =
		!forceOpaque &&
		selected.manifest.presentation.material === "system" &&
		selectedMode.artwork === null &&
		hostUiApi.translucent;
	const expressionAvailable = selectedMode.artwork !== null;
	const scene = selectedMode.artwork;
	const dither = scene?.treatment.kind === "dither" ? scene.treatment : null;
	const texture =
		scene && scene.treatment.kind !== "glass" && scene.treatment.kind !== "clear" && scene.treatment.kind !== "dither"
			? scene.treatment
			: null;
	const authoredArtwork =
		selected.manifest.kind === "art" ? selected.manifest.mode.artwork : selected.manifest.modes[mode].artwork;

	const reportFailure = (error: unknown) => setLoadError(errorMessage(error));
	const deleteSkin = (id: string) => {
		void hostSkinsApi
			.delete(id)
			.then((snapshot) => {
				if (store.get(userSkinsAtom) === userSkins) {
					setLoadError(snapshot.error);
					setUserSkins(snapshot);
				}
				setPreference((current) => (current === `custom:${id}` ? "default" : current));
			})
			.catch(reportFailure);
	};

	return (
		<SettingsPage title={t("settings.appearance")}>
			<SettingsSection>
				{selected.manifest.kind === "studio" && (
					<SettingsFieldRow label={t("settings.theme")}>
						{({ labelId, descriptionId }) => (
							<Segmented
								value={themePreference}
								onChange={setThemePreference}
								options={THEME_VALUES.map((value) => ({ value, label: t(`settings.theme_${value}`) }))}
								ariaLabelledBy={labelId}
								ariaDescribedBy={descriptionId}
							/>
						)}
					</SettingsFieldRow>
				)}
				{scene !== null && (
					<SettingsFieldRow
						label={t("skins.backgroundScope")}
						description={t(`skins.backgroundScope_${scene.scope}_description`)}
					>
						{({ labelId, descriptionId }) => (
							<Segmented
								value={scene.scope}
								onChange={(scope: SkinArtworkScope) => {
									if (scope !== scene.scope) setSceneOverrides({ preference, scene: { ...sceneOverride, scope } });
								}}
								options={SCOPE_VALUES.map((value) => ({ value, label: t(`skins.backgroundScope_${value}`) }))}
								ariaLabelledBy={labelId}
								ariaDescribedBy={descriptionId}
							/>
						)}
					</SettingsFieldRow>
				)}
				{scene !== null && (
					<SettingsFieldRow
						label={t("skins.treatment")}
						description={t(`skins.treatment_${scene.treatment.kind}_description`)}
						className="sm:grid-cols-1 sm:gap-3"
						group
					>
						{({ labelId, descriptionId }) => (
							<SkinTreatmentPicker
								layer={scene}
								authoredTreatment={authoredArtwork?.treatment}
								onChange={(treatment) => {
									// Re-selecting the active texture must not reset its customized parameters.
									if (treatment.kind === scene.treatment.kind) return;
									setSceneOverrides({
										preference,
										scene: { ...sceneOverride, treatment },
									});
								}}
								labelId={labelId}
								descriptionId={descriptionId}
							/>
						)}
					</SettingsFieldRow>
				)}
				{texture !== null && (
					<SettingsFieldRow label={t("skins.textureStrength")} description={t("skins.textureStrengthDescription")}>
						{({ controlId, labelId, descriptionId }) => (
							<>
								<input
									id={controlId}
									type="range"
									min={0}
									max={100}
									step={5}
									value={Math.round(texture.strength * 100)}
									aria-labelledby={labelId}
									aria-describedby={descriptionId}
									aria-valuetext={`${Math.round(texture.strength * 100)}%`}
									onChange={(event) =>
										setSceneOverrides({
											preference,
											scene: {
												...sceneOverride,
												treatment: { ...texture, strength: Number(event.target.value) / 100 },
											},
										})
									}
									className="w-36 accent-text-primary"
								/>
								<span className="w-12 text-right text-xs tabular-nums text-text-muted">
									{Math.round(texture.strength * 100)}%
								</span>
							</>
						)}
					</SettingsFieldRow>
				)}
				{dither !== null && (
					<SettingsFieldRow label={t("skins.ditherSize")} description={t("skins.ditherSizeDescription")}>
						{({ controlId, labelId, descriptionId }) => (
							<>
								<input
									id={controlId}
									type="range"
									min={1}
									max={6}
									step={0.5}
									value={dither.cellSize}
									aria-labelledby={labelId}
									aria-describedby={descriptionId}
									onChange={(event) =>
										setSceneOverrides({
											preference,
											scene: { ...sceneOverride, treatment: { ...dither, cellSize: Number(event.target.value) } },
										})
									}
									className="w-36 accent-text-primary"
								/>
								<span className="w-12 text-right text-xs tabular-nums text-text-muted">{dither.cellSize} px</span>
							</>
						)}
					</SettingsFieldRow>
				)}
				{sceneOverride !== undefined && (
					<SettingsRow label={t("skins.sceneCustom")} description={t("skins.sceneCustomDescription")}>
						<Button variant="ghost" size="sm" onClick={() => setSceneOverrides({ preference, scene: null })}>
							<Undo2 className="size-3.5" aria-hidden="true" />
							{t("skins.resetScene")}
						</Button>
					</SettingsRow>
				)}
				{expressionAvailable && (
					<SettingsFieldRow
						label={t("skins.expression")}
						description={t("skins.expressionDescription", SKIN_SCENE_VISIBILITY)}
					>
						{({ labelId, descriptionId }) => (
							<Segmented
								value={expression}
								onChange={setExpression}
								options={EXPRESSION_VALUES.map((value) => ({
									value,
									label: `${t(`skins.expression_${value}`)} ${String(SKIN_SCENE_VISIBILITY[value])}%`,
								}))}
								ariaLabelledBy={labelId}
								ariaDescribedBy={descriptionId}
							/>
						)}
					</SettingsFieldRow>
				)}
				{nativeTransparencyAvailable && (
					<SettingsFieldRow label={t("settings.vibrancy")} description={t("settings.vibrancyDescription")}>
						{({ controlId, labelId, descriptionId }) => (
							<>
								<input
									id={controlId}
									aria-labelledby={labelId}
									aria-describedby={descriptionId}
									type="range"
									min={0}
									max={100}
									step={5}
									value={nativeTransparency}
									onChange={(event) => setNativeTransparency(Number(event.target.value))}
									className="w-40 accent-text-primary"
								/>
								<span className="w-10 text-right text-xs tabular-nums text-text-muted">{nativeTransparency}%</span>
							</>
						)}
					</SettingsFieldRow>
				)}
			</SettingsSection>

			<SettingsSection
				title={t("skins.previewTitle")}
				description={t(selectedResolved.kind === "art" ? "skins.artPreviewDescription" : "skins.previewDescription")}
				action={
					previous && previous.preference !== preference ? (
						<Button variant="ghost" size="sm" onClick={() => selectSkin(previous.preference)}>
							<Undo2 className="size-3.5" aria-hidden="true" />
							{t("skins.comparePrevious", { name: previous.name })}
						</Button>
					) : undefined
				}
			>
				<div className="space-y-3 p-3">
					{selectedResolved.kind === "art" ? (
						<PreviewScene mode={selectedResolved.mode} large />
					) : (
						<div className="grid gap-3 lg:grid-cols-2">
							<div>
								<div className="mb-1.5 text-xs font-medium text-text-muted">{t("settings.theme_light")}</div>
								<PreviewScene mode={selectedResolved.modes.light} large />
							</div>
							<div>
								<div className="mb-1.5 text-xs font-medium text-text-muted">{t("settings.theme_dark")}</div>
								<PreviewScene mode={selectedResolved.modes.dark} large />
							</div>
						</div>
					)}
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
						<span className="font-medium text-text-primary" aria-live="polite">
							{selected.name}
						</span>
						<span>{selected.manifest.meta.author}</span>
						<span>
							{selected.preference === "default" || selected.preference.startsWith("builtin:")
								? t("skins.bundledLicense")
								: selected.manifest.meta.license}
						</span>
						<span>{t(`skins.codeTheme_${selected.manifest.presentation.codeTheme}`)}</span>
						<span>{t(`skins.shape_${selected.manifest.presentation.shape}`)}</span>
					</div>
				</div>
			</SettingsSection>

			<SettingsSection title={t("skins.standardTitle")} description={t("skins.standardDescription")}>
				<div className="grid grid-cols-2 gap-3 p-3 lg:grid-cols-3">
					{[stock, ...builtins.filter((skin) => skin.manifest.kind === "studio")].map((skin) => (
						<SkinCard
							key={skin.preference}
							skin={skin}
							mode={mode}
							expression={expression}
							forceOpaque={forceOpaque}
							selected={preference === skin.preference}
							onSelect={() => selectSkin(skin.preference)}
						/>
					))}
				</div>
			</SettingsSection>

			<SettingsSection title={t("skins.artTitle")} description={t("skins.artDescription")}>
				<div className="p-3 pb-0">
					<Input
						type="search"
						aria-label={t("skins.searchArt")}
						placeholder={t("skins.searchArt")}
						value={artQuery}
						onChange={(event) => setArtQuery(event.target.value)}
					/>
				</div>
				<div className="grid grid-cols-2 gap-3 p-3 lg:grid-cols-3">
					{artSkins.length === 0 && (
						<p className="col-span-full py-4 text-center text-sm text-text-muted" role="status">
							{t("skins.noMatches")}
						</p>
					)}
					{artSkins.map((skin) => (
						<SkinCard
							key={skin.preference}
							skin={skin}
							mode={mode}
							expression={expression}
							forceOpaque={forceOpaque}
							selected={preference === skin.preference}
							onSelect={() => selectSkin(skin.preference)}
						/>
					))}
				</div>
			</SettingsSection>

			<SettingsSection
				title={t("skins.customTitle")}
				description={t("skins.customDescription")}
				action={
					hostUiApi.capabilities.nativePathOpen ? (
						<Button variant="outline" size="sm" onClick={() => void hostSkinsApi.openDir().catch(reportFailure)}>
							<FolderOpen className="size-3.5" aria-hidden="true" />
							{t("skins.openDir")}
						</Button>
					) : undefined
				}
			>
				{loadError !== null && (
					<SettingsRow
						label={
							<span className="flex items-center gap-1.5">
								<TriangleAlert className="size-3.5 text-danger" aria-hidden="true" />
								{t("skins.loadFailed")}
							</span>
						}
						description={loadError}
					>
						{null}
					</SettingsRow>
				)}
				{customs.length === 0 && invalidCustoms.length === 0 ? (
					<SettingsRow label={t("skins.customEmpty")} description={t("skins.skillHint")}>
						{null}
					</SettingsRow>
				) : (
					<>
						{customs.length > 0 && (
							<div className="grid grid-cols-2 gap-3 p-3 lg:grid-cols-3">
								{customs.map((skin) => {
									const customId = skin.customId;
									const deleteProps =
										customId === undefined
											? {}
											: { onDelete: () => deleteSkin(customId), deleteLabel: t("skins.deleteSkin") };
									return (
										<SkinCard
											key={skin.preference}
											skin={skin}
											mode={mode}
											expression={expression}
											forceOpaque={forceOpaque}
											selected={preference === skin.preference}
											onSelect={() => selectSkin(skin.preference)}
											{...deleteProps}
										/>
									);
								})}
							</div>
						)}
						{invalidCustoms.map((skin) => (
							<SettingsRow
								key={skin.id}
								label={
									<span className="flex items-center gap-1.5">
										<TriangleAlert className="size-3.5 text-warning" aria-hidden="true" />
										{skin.id}
									</span>
								}
								description={t("skins.customInvalid", { message: skin.error ?? "" })}
							>
								{SKIN_ID_PATTERN.test(skin.id) ? (
									<Button variant="outline" size="sm" onClick={() => deleteSkin(skin.id)}>
										<Trash2 className="size-3.5" aria-hidden="true" />
										{t("skins.deleteSkin")}
									</Button>
								) : null}
							</SettingsRow>
						))}
						<SettingsRow label={t("skins.skillHintTitle")} description={t("skins.skillHint")}>
							{null}
						</SettingsRow>
					</>
				)}
			</SettingsSection>
		</SettingsPage>
	);
}
