import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Run against a checkout of can1357/oh-my-pi at v18.3.4 (see README).
const root = path.dirname(import.meta.path);
const source = path.join(root, "upstream/packages/coding-agent/src/session/session-manager.ts");
const [mode, directory] = process.argv.slice(2);
if (!fs.existsSync(source)) throw new Error(`Missing upstream checkout: ${source}`);

function messages(file: string): string[] {
	return fs.readFileSync(file, "utf8").trim().split("\n")
		.map(line => JSON.parse(line))
		.filter(entry => entry.type === "message" && entry.message.role === "user")
		.map(entry => entry.message.content as string);
}

async function waitFor(file: string): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (!fs.existsSync(file)) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`);
		await Bun.sleep(20);
	}
}

if (mode && directory) {
	// The checkout is supplied at runtime; a static import would require it at build time.
	const { SessionManager } = await import(source);
	const file = path.join(directory, "session.jsonl");
	if (mode === "seed") {
		const session = await SessionManager.open(file, directory, undefined, { initialCwd: directory });
		await session.close();
	} else if (mode === "a") {
		const session = await SessionManager.open(file, directory);
		const notices: string[] = [];
		session.onPersistenceError(error => notices.push(error.message));
		fs.writeFileSync(path.join(directory, "a-open"), "");
		await waitFor(path.join(directory, "continue"));
		// A's hot append succeeds even though B advanced the file behind its back.
		session.appendMessage({ role: "user", content: "A hot-path turn before conflict", timestamp: Date.now() });
		let conflict = "";
		try {
			await session.rewriteEntries();
		} catch (error) {
			conflict = String(error);
		}
		// Mimics subsequent successful-looking user turns in the still-running TUI.
		session.appendMessage({ role: "user", content: "A turn 1 after conflict", timestamp: Date.now() });
		session.appendMessage({ role: "user", content: "A turn 2 after conflict", timestamp: Date.now() });
		let flushError = "";
		try {
			await session.flush();
		} catch (error) {
			flushError = String(error);
		}
		fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify({ conflict, flushError, notices,
			inMemory: session.getEntries().filter(entry => entry.type === "message").length }));
		// No close(): close may reject the same conflict. Process exit releases resources.
	} else if (mode === "b") {
		const session = await SessionManager.open(file, directory);
		session.appendMessage({ role: "user", content: "B durable turn", timestamp: Date.now() });
		await session.flush();
		await session.close();
	} else {
		throw new Error(`Unknown mode: ${mode}`);
	}
} else {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-concurrent-repro-"));
	const home = path.join(directory, "home");
	fs.mkdirSync(home);
	const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_STATE_HOME: path.join(home, ".local/state"), XDG_CACHE_HOME: path.join(home, ".cache") };
	const child = (mode: string) => Bun.spawn([process.execPath, import.meta.path, mode, directory], { env, stdout: "pipe", stderr: "pipe" });
	async function check(proc: { exited: Promise<number>; stderr: ReadableStream<Uint8Array> }, label: string): Promise<void> {
		const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		if (code !== 0) throw new Error(`${label} exited ${code}: ${stderr}`);
	}
	try {
		await check(child("seed"), "seed");
		const a = child("a");
		await waitFor(path.join(directory, "a-open"));
		await check(child("b"), "writer B");
		const afterB = messages(path.join(directory, "session.jsonl"));
		fs.writeFileSync(path.join(directory, "continue"), "");
		await check(a, "writer A");
		const report = JSON.parse(fs.readFileSync(path.join(directory, "report.json"), "utf8"));
		const onDisk = messages(path.join(directory, "session.jsonl"));
		console.log(JSON.stringify({ afterB, onDisk, ...report }, null, 2));
		if (!report.conflict.includes("SessionWriteConflictError") || !afterB.includes("B durable turn") ||
			!onDisk.includes("B durable turn") || !onDisk.includes("A hot-path turn before conflict") ||
			onDisk.some((turn: string) => turn.includes("after conflict")) || report.inMemory !== 3) {
			throw new Error("Did not reproduce the expected conflict and missing later turns");
		}
		console.log("BUG REPRODUCED: both later in-memory turns are missing from disk");
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}
