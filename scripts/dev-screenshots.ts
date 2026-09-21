import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** A bounded CDP client for the runner's own browser; outstanding calls fail when it closes. */
function connect(url: string) {
	const socket = new WebSocket(url);
	let sequence = 0;
	const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
	const ready = new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true });
	});
	socket.addEventListener("message", (event: MessageEvent<string>) => {
		const message = JSON.parse(event.data) as {
			id?: number;
			result?: Record<string, unknown>;
			error?: { message: string };
		};
		if (message.id === undefined) return;
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		if (message.error) request.reject(new Error(message.error.message));
		else request.resolve(message.result ?? {});
	});
	socket.addEventListener("close", () => {
		for (const request of pending.values()) request.reject(new Error("CDP disconnected"));
		pending.clear();
	});
	return {
		async call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
			await ready;
			const id = ++sequence;
			return new Promise((resolve, reject) => {
				// A stuck page must not leave a headless browser running indefinitely.
				const timeout = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`CDP timed out: ${method}`));
				}, 15_000);
				pending.set(id, {
					resolve(value) {
						clearTimeout(timeout);
						resolve(value);
					},
					reject(error) {
						clearTimeout(timeout);
						reject(error);
					},
				});
				socket.send(JSON.stringify({ id, method, params }));
			});
		},
		close: () => socket.close(),
	};
}

export async function captureScreenshots(run: string, url: string, executable?: string): Promise<void> {
	const target = new URL(url);
	if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
		throw new Error("Screenshots require an isolated loopback Host URL");
	}
	const chrome =
		executable ??
		process.env.CHROME_PATH ??
		(process.platform === "darwin"
			? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
			: process.platform === "win32"
				? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
				: "google-chrome");
	const profile = join(run, "browser", randomUUID());
	await mkdir(profile, { mode: 0o700 });
	const browser = spawn(
		chrome,
		[
			"--headless=new",
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			"--no-first-run",
			"--no-default-browser-check",
			"about:blank",
		],
		{ stdio: "ignore" },
	);
	let startupError: Error | undefined;
	const closed = new Promise<void>((resolve) => {
		browser.once("error", (error) => {
			startupError = error;
			resolve();
		});
		browser.once("close", () => resolve());
	});
	let cdp: ReturnType<typeof connect> | undefined;
	try {
		let port: string | undefined;
		for (let attempt = 0; attempt < 100 && !port; attempt++) {
			if (startupError) throw startupError;
			try {
				port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (!port) await delay(100);
		}
		if (!port) throw new Error("Chrome did not expose a debugging port");
		const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
			type: string;
			webSocketDebuggerUrl: string;
		}>;
		const page = pages.find((page) => page.type === "page");
		if (!page) throw new Error("Chrome has no page target");
		cdp = connect(page.webSocketDebuggerUrl);
		await cdp.call("Page.enable");
		let navigated = false;
		for (const language of ["en", "zh-CN"]) {
			for (const theme of ["light", "dark"]) {
				const navigationId = randomUUID();
				const script = await cdp.call("Page.addScriptToEvaluateOnNewDocument", {
					// These preferences store raw strings, not JSON values.
					source: `localStorage.setItem('ling:language', ${JSON.stringify(language)}); localStorage.setItem('ling:theme', ${JSON.stringify(theme)}); globalThis.__lingScreenshotNavigation = ${JSON.stringify(navigationId)};`,
				});
				// Reusing the launch URL can be a fragment-only navigation after token intake.
				if (navigated) await cdp.call("Page.reload");
				else {
					await cdp.call("Page.navigate", { url });
					navigated = true;
				}
				let ready = false;
				for (let attempt = 0; attempt < 100 && !ready; attempt++) {
					const state = await cdp.call("Runtime.evaluate", {
						// A previous page can still be mounted after navigation was requested.
						expression: `Boolean(globalThis.__lingScreenshotNavigation === ${JSON.stringify(navigationId)} && window.ling && document.documentElement?.lang === ${JSON.stringify(language)} && document.documentElement.classList.contains('dark') === ${theme === "dark"} && document.querySelector('#root')?.children.length && document.fonts.status === 'loaded')`,
						returnByValue: true,
					});
					ready = (state.result as { value?: boolean }).value === true;
					if (!ready) await delay(100);
				}
				if (!ready) {
					const state = await cdp.call("Runtime.evaluate", {
						expression: `({ navigationMatches: globalThis.__lingScreenshotNavigation === ${JSON.stringify(navigationId)}, language: document.documentElement?.lang, dark: document.documentElement?.classList.contains('dark'), clientReady: Boolean(window.ling), mounted: Boolean(document.querySelector('#root')?.children.length), fonts: document.fonts.status })`,
						returnByValue: true,
					});
					throw new Error(
						`Ling did not render ${language}/${theme}: ${JSON.stringify(state.result)}; inspect the Host log`,
					);
				}
				for (const width of [900, 1440, 2560]) {
					await cdp.call("Emulation.setDeviceMetricsOverride", {
						width,
						height: 1000,
						deviceScaleFactor: 1,
						mobile: false,
					});
					await cdp.call("Runtime.evaluate", {
						expression: "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
						awaitPromise: true,
					});
					const screenshot = await cdp.call("Page.captureScreenshot", { format: "png" });
					await writeFile(
						join(run, "shots", `${language}-${theme}-${width}.png`),
						Buffer.from(screenshot.data as string, "base64"),
					);
				}
				await cdp.call("Page.removeScriptToEvaluateOnNewDocument", { identifier: script.identifier });
			}
		}
		console.log(join(run, "shots"));
	} finally {
		cdp?.close();
		browser.kill("SIGTERM");
		const timeout = setTimeout(() => browser.kill("SIGKILL"), 5_000);
		await closed;
		clearTimeout(timeout);
		await rm(profile, { recursive: true, force: true });
	}
}
