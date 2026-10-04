import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { temporaryDirectory } from "../../../../../test/temporary-directory";
import { addCustomModelRequestSchema, updateCustomModelRequestSchema } from "@ling/contracts/model-requests";
import { createPiModelRuntimes } from "./model-runtime";
import { createPiModelsConfig } from "./models-config";
import { createPiModelCredentials } from "./model-credentials";
import { createPiModelProviderMutations } from "./model-provider-mutations";
import { createPiModelConfiguration } from "./model-configuration";

it("persists, inspects, copies and clears thinking-level sampling while retaining provider-owned fields", async () => {
	const agentDir = await temporaryDirectory("model-thinking-sampling");
	const runtimes = createPiModelRuntimes(agentDir);
	const config = createPiModelsConfig(runtimes, agentDir);
	const projects = {
		withOpenProject: async () => {
			throw new Error("This fixture has no open project");
		},
	};
	const credentials = createPiModelCredentials({ projects, config });
	const mutations = createPiModelProviderMutations({ modelRuntimes: runtimes, config, credentials });
	const inspector = createPiModelConfiguration({ projects, config });
	const path = join(agentDir, "models.json");
	const sampling = { off: { temperature: 0.2 }, high: { temperature: 0.7, top_p: 0.8 } };
	try {
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", models: [], futureOption: true },
				},
			}),
		);
		const fields = {
			provider: "fixture",
			name: null,
			contextWindow: null,
			maxTokens: null,
			reasoning: true,
			samplingParams: { top_p: 0.9 },
			compat: null,
			options: { samplingParamsByThinkingLevel: sampling },
		};
		await mutations.addCustomModelMutation(addCustomModelRequestSchema.parse({ ...fields, id: "sampling" }));
		const request = { cwd: null, provider: "fixture", modelId: "sampling" };
		const observed = await inspector.getModelConfiguration(request);
		expect(observed.effective.samplingParamsByThinkingLevel).toEqual(sampling);
		expect(observed.configured?.samplingParamsByThinkingLevel).toEqual(sampling);
		expect(observed.template.options.samplingParamsByThinkingLevel).toEqual(sampling);
		await mutations.addCustomModelMutation(
			addCustomModelRequestSchema.parse({ provider: "fixture", id: "copy", ...observed.template }),
		);
		expect(
			(await inspector.getModelConfiguration({ ...request, modelId: "copy" })).effective.samplingParamsByThinkingLevel,
		).toEqual(sampling);
		const before = await readFile(path, "utf8");
		expect(() =>
			updateCustomModelRequestSchema.parse({
				...fields,
				modelId: "sampling",
				options: { samplingParamsByThinkingLevel: { high: 0.5 } },
			}),
		).toThrow();
		expect(await readFile(path, "utf8")).toBe(before);
		await mutations.updateCustomModelMutation(
			updateCustomModelRequestSchema.parse({ ...fields, modelId: "sampling", options: {} }),
		);
		const after = await inspector.getModelConfiguration(request);
		expect(after.effective).not.toHaveProperty("samplingParamsByThinkingLevel");
		const saved = JSON.parse(await readFile(path, "utf8"));
		expect(saved.providers.fixture.futureOption).toBe(true);
		expect(saved.providers.fixture.models[1].samplingParamsByThinkingLevel).toEqual(sampling);
	} finally {
		await runtimes.dispose();
		await rm(agentDir, { recursive: true, force: true });
	}
}, 30_000);
