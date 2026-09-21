import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { captureScreenshots } from "./dev-screenshots.ts";

const repository = resolve(import.meta.dirname, "..");
const rootInput = process.env.LING_DEV_ROOT ?? join(homedir(), ".cache/ling-dev");
const root = resolve(rootInput);
const [command, name, ...args] = process.argv.slice(2);
// Retain recent evidence for comparison; only runs created by this runner are eligible.
const retentionMs = 7 * 24 * 60 * 60 * 1_000;

interface RunMetadata {
	format: "ling/dev-run/1";
	id: string;
	createdAt: string;
	purpose: string;
	keep: boolean;
	commit: string;
	candidate: string;
}

function git(...arguments_: string[]): Buffer {
	return execFileSync("git", arguments_, { cwd: repository });
}

async function candidateHash(): Promise<string> {
	const hash = createHash("sha256");
	// Large refactors can exceed execFileSync's output buffer. Hash the diff as it
	// arrives so evidence capture does not retain another complete copy in memory.
	await new Promise<void>((resolve, reject) => {
		const child = spawn("git", ["diff", "HEAD", "--binary"], {
			cwd: repository,
			stdio: ["ignore", "pipe", "inherit"],
		});
		child.stdout.on("data", (chunk: Buffer) => hash.update(chunk));
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Git candidate capture failed with exit code ${code}`));
		});
	});
	for (const path of git("ls-files", "--others", "--exclude-standard", "-z").toString().split("\0")) {
		if (!path) continue;
		hash.update(path).update("\0");
		for await (const chunk of createReadStream(join(repository, path))) hash.update(chunk as Buffer);
	}
	return hash.digest("hex");
}

function runPath(id: string | undefined): string {
	if (!id || !/^\d{8}-[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("Use a run name such as 20260911-refactor");
	return join(root, "runs", id);
}

async function readMetadata(path: string): Promise<RunMetadata> {
	if ((await lstat(path)).isSymbolicLink()) throw new Error(`Run must not be a symbolic link: ${path}`);
	const metadata: RunMetadata = JSON.parse(await readFile(join(path, "meta.json"), "utf8"));
	if (
		metadata.format !== "ling/dev-run/1" ||
		runPath(metadata.id) !== path ||
		!Number.isFinite(Date.parse(metadata.createdAt))
	) {
		throw new Error(`Not a runner-owned directory: ${path}`);
	}
	return metadata;
}

async function environment(path: string): Promise<NodeJS.ProcessEnv> {
	await readMetadata(path);
	const canonical = await realpath(path);
	const paths = await Promise.all(
		["userdata", "pi-agent", "browser"].map(async (part) => {
			const child = join(path, part);
			if ((await realpath(child)) !== join(canonical, part))
				throw new Error(`Isolation directory was redirected: ${child}`);
			return child;
		}),
	);
	const [userData, piAgent] = paths;
	const dataHome = join(canonical, "ling-home");
	await mkdir(dataHome, { recursive: true, mode: 0o700 });
	if ((await realpath(dataHome)) !== dataHome)
		throw new Error(`Data home isolation directory was redirected: ${dataHome}`);
	return { ...process.env, LING_USER_DATA_DIR: userData, PI_CODING_AGENT_DIR: piAgent, LING_HOME: dataHome };
}

async function createRun(id: string | undefined): Promise<void> {
	const path = runPath(id);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await mkdir(path, { mode: 0o700 });
	for (const part of ["userdata", "pi-agent", "projects", "browser", "logs", "shots", "evidence"]) {
		await mkdir(join(path, part), { mode: 0o700 });
	}
	const metadata: RunMetadata = {
		format: "ling/dev-run/1",
		id: id!,
		createdAt: new Date().toISOString(),
		purpose: args.filter((arg) => arg !== "--keep").join(" ") || id!,
		keep: args.includes("--keep"),
		commit: git("rev-parse", "HEAD").toString().trim(),
		candidate: await candidateHash(),
	};
	await writeFile(join(path, "meta.json"), JSON.stringify(metadata, null, 2) + "\n", { flag: "wx", mode: 0o600 });
	console.log(path);
}

async function seed(path: string): Promise<void> {
	await environment(path);
	const project = join(path, "projects", "example");
	await mkdir(project);
	await writeFile(
		join(project, "README.md"),
		"# Ling development fixture\n\nAn isolated project for runtime acceptance.\n",
	);
	for (const arguments_ of [
		["init"],
		["add", "README.md"],
		["-c", "user.name=Ling fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "Seed fixture"],
	]) {
		execFileSync("git", arguments_, { cwd: project, stdio: "ignore" });
	}
	// Sessions are created through Host/Pi during acceptance, rather than writing a guessed SDK format.
	console.log(project);
}

interface RunStep {
	executable: string;
	arguments: string[];
}

async function run(path: string, steps: RunStep[], withAuth: boolean): Promise<void> {
	const env = await environment(path);
	const lock = join(path, "active.json");
	const handle = await open(lock, "wx", 0o600);
	const authPath = join(path, "pi-agent", "auth.json");
	let copiedAuth = false;
	try {
		await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
		if (withAuth) {
			await copyFile(join(homedir(), ".pi/agent/auth.json"), authPath, constants.COPYFILE_EXCL);
			copiedAuth = true;
			await chmod(authPath, 0o600);
		}
		await writeFile(
			join(path, "evidence", "candidate.json"),
			JSON.stringify(
				{
					commit: git("rev-parse", "HEAD").toString().trim(),
					candidate: await candidateHash(),
					steps,
					startedAt: new Date().toISOString(),
				},
				null,
				2,
			),
			{ mode: 0o600 },
		);
		for (const step of steps) {
			if (!(await runChild(path, env, step))) break;
		}
	} finally {
		try {
			if (copiedAuth) await rm(authPath, { force: true });
		} finally {
			await handle.close();
			await rm(lock);
		}
	}
}

async function runChild(path: string, env: NodeJS.ProcessEnv, step: RunStep): Promise<boolean> {
	const log = createWriteStream(join(path, "logs", `${command}-${Date.now()}.log`), { flags: "wx", mode: 0o600 });
	const child = spawn(step.executable, step.arguments, {
		cwd: repository,
		env,
		stdio: ["inherit", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let stopping = false;
	let logFailed = false;
	const signal = (value: NodeJS.Signals, group = false): void => {
		if (!child.pid) return;
		try {
			if (!group || process.platform === "win32") child.kill(value);
			else process.kill(-child.pid, value);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	};
	const stop = (): void => {
		stopping = true;
		// Let the runtime stop admission and drain its workers before signaling descendants.
		signal("SIGTERM");
		// Host/Desktop have a 20-second fatal drain. Allow them to finish before forcing this run's group.
		killTimer ??= setTimeout(() => signal("SIGKILL", true), 30_000);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	log.on("error", (error) => {
		logFailed = true;
		console.error(error);
		stop();
	});
	child.stdout.on("data", (chunk: Buffer) => {
		process.stdout.write(chunk);
		log.write(chunk);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		process.stderr.write(chunk);
		log.write(chunk);
	});
	try {
		const code = await new Promise<number>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve(code ?? (signal === "SIGTERM" ? 0 : 1)));
		});
		process.exitCode = logFailed ? 1 : code;
		return code === 0 && !stopping && !logFailed;
	} finally {
		if (killTimer) clearTimeout(killTimer);
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		await new Promise<void>((resolve) => log.end(resolve));
	}
}

async function listOrClean(clean: boolean): Promise<void> {
	await mkdir(join(root, "runs"), { recursive: true, mode: 0o700 });
	for (const entry of await readdir(join(root, "runs"), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const path = join(root, "runs", entry.name);
		let metadata: RunMetadata;
		try {
			metadata = await readMetadata(path);
		} catch {
			console.log(`${entry.name}: unmanaged; preserved`);
			continue;
		}
		let active = false;
		try {
			await lstat(join(path, "active.json"));
			active = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const expired = Date.now() - Date.parse(metadata.createdAt) > retentionMs;
		if (clean && expired && !metadata.keep && !active) {
			await rm(path, { recursive: true });
			console.log(`${entry.name}: removed`);
		} else console.log(`${entry.name}: ${active ? "active" : metadata.keep ? "keep" : expired ? "expired" : "recent"}`);
	}
}

async function main(): Promise<void> {
	const fromRepository = relative(repository, root);
	if (
		fromRepository === "" ||
		(!isAbsolute(fromRepository) && fromRepository !== ".." && !fromRepository.startsWith(`..${sep}`))
	) {
		throw new Error("LING_DEV_ROOT must be outside the repository");
	}
	if (!isAbsolute(rootInput)) throw new Error("LING_DEV_ROOT must be absolute");
	switch (command) {
		case "create":
			return createRun(name);
		case "list":
			return listOrClean(false);
		case "clean":
			return listOrClean(true);
		case "seed":
			return seed(runPath(name));
		case "host":
			return run(
				runPath(name),
				[
					{ executable: "pnpm", arguments: ["build:web"] },
					{ executable: "pnpm", arguments: ["build:host"] },
					{
						executable: process.execPath,
						arguments: [
							"packages/host/dist/index.js",
							"--app-root=.",
							"--resources-dir=.",
							"--static-dir=apps/web/dist",
						],
					},
				],
				args.includes("--with-auth"),
			);
		case "desktop":
			return run(runPath(name), [{ executable: "pnpm", arguments: ["dev"] }], args.includes("--with-auth"));
		case "exec": {
			const split = args.indexOf("--");
			const executable = args[split + 1];
			if (split < 0 || !executable) throw new Error("Usage: dev-run exec <run> [--with-auth] -- <command> [args]");
			return run(
				runPath(name),
				[{ executable, arguments: args.slice(split + 2) }],
				args.slice(0, split).includes("--with-auth"),
			);
		}
		case "shots": {
			const path = runPath(name);
			await environment(path);
			const url = args[0];
			if (!url) throw new Error("Usage: dev-run shots <run> <launch-url> [chrome-executable]");
			return captureScreenshots(path, url, args[1]);
		}
		default:
			console.log(
				"dev-run create <YYYYMMDD-slug> [purpose] [--keep]\ndev-run seed|host|desktop <run> [--with-auth]\ndev-run exec <run> [--with-auth] -- <command> [args]\ndev-run shots <run> <launch-url> [chrome-executable]\ndev-run list|clean",
			);
	}
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
