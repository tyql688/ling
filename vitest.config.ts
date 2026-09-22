import { resolve } from "node:path";
import ts from "typescript";
import { defineConfig } from "vitest/config";
import webConfig from "./apps/web/vite.config";

const root = import.meta.dirname;
const nodeConfig = ts.getParsedCommandLineOfConfigFile(
	resolve(root, "tsconfig.node.json"),
	{},
	{
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic(diagnostic) {
			throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
		},
	},
);
if (!nodeConfig || nodeConfig.errors.length) throw new Error("Invalid Node TypeScript configuration");

export default defineConfig({
	resolve: {
		alias: [
			...(webConfig.resolve!.alias as { find: string | RegExp; replacement: string }[]),
			...Object.entries(nodeConfig.options.paths!).map(([name, targets]) => {
				if (targets.length !== 1 || !targets[0]) throw new Error(`Ambiguous source alias: ${name}`);
				return {
					find: name.endsWith("/*") ? name.slice(0, -2) : new RegExp(`^${name}$`),
					replacement: resolve(root, targets[0].replace(/\/\*$/, "")),
				};
			}),
		],
	},
	test: {
		include: ["packages/*/src/**/*.test.ts", "apps/web/src/**/*.test.ts", "apps/desktop/src/**/*.test.ts"],
		environment: "node",
		// Bound simultaneous grammar and transcript fixtures on developer machines.
		maxWorkers: 4,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
	},
});
