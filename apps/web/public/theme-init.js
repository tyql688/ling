// Runs synchronously before first paint to avoid a flash of the wrong theme.
// Keep this in sync with lib/appearance/use-theme.ts and skins/apply-skin.ts.
(() => {
	const root = document.documentElement;
	// Without a boot hint, native startup waits for the Host's saved selection before showing the default mark.
	if (window.lingShell !== undefined) root.dataset.nativeShell = "true";
	let preferences = null;
	try {
		const raw = localStorage.getItem("ling:ui-boot-preferences");
		const value = raw !== null && raw.length <= 8192 ? JSON.parse(raw) : null;
		if (value?.version === 1) preferences = value;
	} catch {
		/* This is a disposable first-paint hint. */
	}
	const readPreference = (field, key) => (preferences === null ? localStorage.getItem(key) : preferences[field]);
	let skinPreference = "default";
	try {
		const storedSkin = readPreference("skin", "ling:skin");
		if (/^(?:default|(?:builtin|custom):[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/.test(storedSkin)) {
			skinPreference = storedSkin;
			root.dataset.skinSelected = String(skinPreference !== "default");
		}
	} catch {
		/* The Host supplies the selection when the disposable cache cannot be read. */
	}
	const reduceTransparency = window.matchMedia("(prefers-reduced-transparency: reduce)").matches;
	const translucent = window.lingShell?.capabilities.windowTranslucency === true && !reduceTransparency;
	if (translucent) {
		root.classList.add("vibrancy");
	}
	try {
		const storedTransparency = String(readPreference("nativeTransparency","ling:vibrancy-transparency"));
		const transparency = /^(?:100|[0-9]{1,2})$/.test(storedTransparency)
			? Number(storedTransparency)
			: 70;
		root.style.setProperty("--native-transparency", String(transparency));
	} catch (_err) {
		root.style.setProperty("--native-transparency", "70");
	}
	let isDark = false;
	try {
		const stored = readPreference("theme","ling:theme");
		const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
		isDark = stored === "dark" || (stored !== "light" && prefersDark);
	} catch (_err) {
		// localStorage/matchMedia unavailable — fall back to the light default.
	}
	root.classList.toggle("dark", isDark);
	try {
		const expression = readPreference("skinExpression","ling:skin-expression");
		root.dataset.skinExpression = ["balanced", "immersive"].includes(expression)
			? expression
			: "balanced";
	} catch (_err) {
		root.dataset.skinExpression = "balanced";
	}

	// Pre-paint the current resolved skin snapshot so a skinned app does not flash the stock palette.
	// The version gate prevents an incompatible cache from partially styling the startup frame.
	try {
		const cache = JSON.parse(localStorage.getItem("ling:skin-cache") || "null");
		if (cache?.version !== 3 || cache.materialVersion !== 12) return;
		if (!["art", "studio"].includes(cache.kind)) return;
		if (cache.kind === "art" && !["light", "dark"].includes(cache.appearance)) return;
		const selectedPackage = /^(?:builtin|custom):([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/.exec(skinPreference);
		const expectedId = selectedPackage?.[1] || "ling-neutral";
		if (cache.id !== expectedId) return;
		if (cache.kind === "art") isDark = cache.appearance === "dark";
		root.classList.toggle("dark", isDark);
		root.dataset.skinKind = cache.kind;
		root.dataset.skinAppearance = isDark ? "dark" : "light";
		const mode = !reduceTransparency ? cache.kind === "art" ? cache.mode : cache.modes?.[isDark ? "dark" : "light"] : null;
		const vars = mode && typeof mode === "object" ? mode.vars : null;
		if (typeof cache.id === "string" && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(cache.id)) {
			root.dataset.skinId = cache.id;
		}
		if (["system", "solid"].includes(cache.material)) root.dataset.skinMaterial = cache.material;
		if (["none", "subtle", "ambient"].includes(cache.motion)) root.dataset.skinMotion = cache.motion;
		if (["neutral", "github", "vitesse", "catppuccin"].includes(cache.codeTheme)) {
			root.dataset.skinCodeTheme = cache.codeTheme;
		}
		if (mode?.artwork === true) {
			root.dataset.skinBackdrop = "true";
		}
		if (["window", "conversation"].includes(mode?.scope)) root.dataset.skinScope = mode.scope;
		if (["glass", "dither", "clear", "paper", "linen", "scanlines"].includes(mode?.treatment)) {
			root.dataset.skinTreatment = mode.treatment;
		}
		if (vars && typeof vars === "object") {
			let count = 0;
			for (const key of Object.keys(vars)) {
				// 128 bounds the boot hint while fitting the full semantic material and ANSI token set.
				if (++count > 128) break;
				const value = vars[key];
				if (key.startsWith("--") && key.length <= 64 && typeof value === "string" && value.length <= 200) {
					root.style.setProperty(key, value);
				}
			}
		}
	} catch (_err) {
		// A corrupt cache only costs the pre-paint; use-skin repaints after mount.
	}
})();
