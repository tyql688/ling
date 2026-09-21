import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const electronBuilderCli = fileURLToPath(import.meta.resolve("electron-builder/cli.js"));
const releaseMetadata = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
	author?: { email?: unknown; name?: unknown };
	homepage?: unknown;
	version?: unknown;
};

function requiredMetadata(value: unknown, field: string): string {
	if (typeof value !== "string" || !value) {
		throw new Error(`The repository package.json must declare ${field}`);
	}
	return value;
}

const releaseVersion = requiredMetadata(releaseMetadata.version, "the Ling release version");
const releaseHomepage = requiredMetadata(releaseMetadata.homepage, "the Ling homepage");
const releaseAuthorName = requiredMetadata(releaseMetadata.author?.name, "the Ling author name");
const releaseAuthorEmail = requiredMetadata(releaseMetadata.author?.email, "the Ling author email");

const builder = spawnSync(
	process.execPath,
	[
		electronBuilderCli,
		"--config",
		"electron-builder.yml",
		"--publish",
		"never",
		`--config.extraMetadata.version=${releaseVersion}`,
		`--config.extraMetadata.homepage=${releaseHomepage}`,
		`--config.extraMetadata.author.name=${releaseAuthorName}`,
		`--config.extraMetadata.author.email=${releaseAuthorEmail}`,
		...process.argv.slice(2),
	],
	{
		cwd: desktopRoot,
		stdio: "inherit",
		windowsHide: true,
	},
);

if (builder.error) throw builder.error;
if (builder.signal) throw new Error(`electron-builder was terminated by ${builder.signal}`);
if (builder.status !== 0) throw new Error(`electron-builder exited with status ${String(builder.status)}`);
