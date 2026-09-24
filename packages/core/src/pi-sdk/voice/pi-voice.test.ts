import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { VOICE_PCM_MAX_BYTES, isPiVoiceSource, voiceTranscribeRequestSchema } from "@ling/contracts/voice";
import { createPiVoice, decodeVoicePcm } from "./pi-voice";
import { loadPiVoiceModules } from "./pi-voice-modules";
import { createPiProjectServices } from "../projects/services";
import { createPiModelRuntimes } from "../models/model-runtime";
import { createPiTurnLifecycle } from "../session/turn-lifecycle";
import { createLingSkillResources } from "../resources/skill-toggles";

const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("decodes little-endian signed PCM and rejects truncated, noncanonical or oversized audio", () => {
	const bytes = Buffer.alloc(6);
	bytes.writeInt16LE(-32768, 0);
	bytes.writeInt16LE(0, 2);
	bytes.writeInt16LE(32767, 4);
	expect([...decodeVoicePcm(bytes.toString("base64"))]).toEqual([-1, 0, 32767 / 32768]);
	for (const input of ["", "AA==", "AAE", "AB==", " AAIA", Buffer.alloc(VOICE_PCM_MAX_BYTES + 2).toString("base64")])
		expect(() => decodeVoicePcm(input)).toThrow();
	const request = {
		operationId: randomUUID(),
		cwd: "/project",
		pcm: Buffer.alloc(VOICE_PCM_MAX_BYTES).toString("base64"),
	};
	expect(voiceTranscribeRequestSchema.safeParse(request).success).toBe(true);
	for (const pcm of ["AAAA!AAA", "AAA=AAAA", "AAAAA", `${request.pcm}AAAA`])
		expect(voiceTranscribeRequestSchema.safeParse({ ...request, pcm }).success).toBe(false);
});

it("projects only the bundled identity and the exact upstream package, including pinned installs", () => {
	for (const source of [
		"ling:voice",
		"npm:@earendil-works/pi-voice",
		"npm:@earendil-works/pi-voice@0.1.0",
		"git:github.com/earendil-works/pi-voice",
	])
		expect(isPiVoiceSource(source)).toBe(true);
	for (const source of [
		"npm:pi-voice",
		"npm:@someone/pi-voice",
		"npm:@earendil-works/pi-voice-extra",
		"git:github.com/someone/pi-voice",
	])
		expect(isPiVoiceSource(source)).toBe(false);
});

it("loads the shipped source modules without downloading models or opening a microphone", async () => {
	const entry = fileURLToPath(
		new URL("../../../../host/node_modules/@earendil-works/pi-voice/index.ts", import.meta.url),
	);
	const modules = await loadPiVoiceModules(entry);
	const root = await temporaryDirectory("voice-config");
	roots.push(root);
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
	const model = modules.catalog.CATALOG_MODELS[0]!;
	const legacy = JSON.stringify(modules.settings.settingsForModel(model.id, "/existing-model.gguf", {}));
	await writeFile(join(root, "pi-transcribe.json"), legacy);
	expect(await modules.settings.readSettings()).toEqual({});
	expect(await readFile(join(root, "pi-transcribe.json"), "utf8")).toBe(legacy);
	await expect(stat(join(root, "pi-voice.json"))).rejects.toMatchObject({ code: "ENOENT" });
	expect(modules.catalog.CATALOG_MODELS.some((model) => model.languages.includes("zh"))).toBe(true);
	const service = new modules.service.TranscriptionService();
	await service.shutdown();
}, 30_000);

it("rejects unknown package versions before importing their executable source", async () => {
	const root = await temporaryDirectory("voice-version");
	roots.push(root);
	await mkdir(join(root, "src"));
	await writeFile(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-voice", version: "9.9.9" }));
	await expect(loadPiVoiceModules(join(root, "index.ts"))).rejects.toThrow("Supported version: 0.1.0");
});

it("preserves unchanged voice settings and reloads only projects with a voice consumer", async () => {
	const root = await temporaryDirectory("voice-reload");
	roots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "voice-project");
	const other = join(root, "other-project");
	for (const path of [agentDir, cwd, other]) await mkdir(path);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	const entry = fileURLToPath(
		new URL("../../../../host/node_modules/@earendil-works/pi-voice/index.ts", import.meta.url),
	);
	const modelRuntimes = createPiModelRuntimes(agentDir);
	const turnLifecycle = createPiTurnLifecycle({ start: async () => {}, finish: async () => {} });
	const projects = createPiProjectServices({
		loadCatalogResources: true,
		agentDir,
		modelRuntimes,
		turnLifecycle,
		skillResources: createLingSkillResources(),
		builtinExtensions: () => [],
		resolveProjectTrust: async () => true,
		readAdapterPlan: async (project) => ({
			features: {
				todo: false,
				permissions: false,
				questions: false,
				"background-tasks": false,
				schedules: false,
				voice: true,
				mcp: false,
			},
			voice: project === cwd ? entry : null,
			todo: null,
			permissions: null,
			mcp: null,
		}),
	});
	const voice = createPiVoice(projects);
	try {
		await projects.openProject(cwd);
		await projects.openProject(other);
		const modules = await loadPiVoiceModules(entry);
		const model = modules.catalog.CATALOG_MODELS.find((item) => item.capabilities.languageDetection)!;
		const cached = modules.models.findCachedCatalogModel(model);
		const modelPath = cached?.path ?? join(root, "model.gguf");
		// Configuration only checks existence; this test never opens the native backend.
		if (!cached) await writeFile(modelPath, "fixture");
		const settings = modules.settings.settingsForModel(model.id, modelPath, {
			transcriptionLanguage: "auto",
			chineseOutput: "simplified",
		});
		const path = join(agentDir, "pi-voice.json");
		const saved = JSON.stringify(settings);
		await writeFile(path, saved);
		const configure = (chineseOutput: "simplified" | "traditional-taiwan") =>
			voice.configure(
				{
					cwd,
					operationId: randomUUID(),
					download: false,
					configuration: { modelId: model.id, language: "auto", chineseOutput },
				},
				new AbortController().signal,
			);
		await expect(configure("simplified")).resolves.toEqual([]);
		expect(await readFile(path, "utf8")).toBe(saved);
		await expect(configure("traditional-taiwan")).resolves.toEqual([cwd]);
	} finally {
		await voice.dispose();
		try {
			await projects.dispose(async () => {});
		} finally {
			turnLifecycle.dispose();
			await modelRuntimes.dispose();
		}
	}
}, 30_000);
