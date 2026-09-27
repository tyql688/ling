import { copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../../test/temporary-directory";
import { HOST_STDIO_MESSAGE_PREFIX } from "@ling/contracts/host-shell";
import { startDesktopHostProcess } from "./host-process";

it.each([
	["NODE_OPTIONS", "NODE_PATH"],
	["Node_Options", "Node_Path"],
])("removes %s and %s before launching the independent Host", async (optionsKey, pathKey) => {
	const root = await temporaryDirectory("desktop-host-environment");
	let host: Awaited<ReturnType<typeof startDesktopHostProcess>> | undefined;
	try {
		await mkdir(join(root, "host/dist"), { recursive: true });
		await mkdir(join(root, "runtime"));
		// Unix Node installations may link adjacent libraries; Windows symlinks require extra privileges.
		if (process.platform === "win32") await copyFile(process.execPath, join(root, "runtime/node.exe"));
		else await symlink(process.execPath, join(root, "runtime/node"));
		await writeFile(
			join(root, "host/dist/index.js"),
			`const { writeFileSync } = require("node:fs");
writeFileSync("environment.json", JSON.stringify({
  injectionKeys: Object.keys(process.env).filter(key => /^NODE_(OPTIONS|PATH)$/i.test(key)),
  agentDir: process.env.PI_CODING_AGENT_DIR,
  stdio: process.env.LING_HOST_STDIO_CONTROL,
  execArgv: process.execArgv,
}));
console.log(${JSON.stringify(HOST_STDIO_MESSAGE_PREFIX)} + JSON.stringify({
  type: "ling-host-ready", hostId: "00000000-0000-4000-8000-000000000001",
  origin: "http://127.0.0.1:12345", token: "x".repeat(32),
}));
process.stdin.resume();
`,
		);
		vi.stubEnv(optionsKey, "--no-warnings");
		vi.stubEnv(pathKey, join(root, "external-modules"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
		host = await startDesktopHostProcess({
			appResourcesRoot: root,
			userDataDirectory: root,
			desktopLog: { attachForwarder: () => () => {} },
			onShellEvent: () => {},
			onUnexpectedExit: () => {},
		});
		expect(JSON.parse(await readFile(join(root, "host/environment.json"), "utf8"))).toEqual({
			injectionKeys: [],
			agentDir: join(root, "agent"),
			stdio: "1",
			execArgv: ["--disable-sigusr1"],
		});
	} finally {
		vi.unstubAllEnvs();
		try {
			await host?.dispose();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
});
