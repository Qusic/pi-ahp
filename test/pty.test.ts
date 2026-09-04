import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { type IDisposable, spawn } from "node-pty";

it("allocates a real TTY and round-trips input", async () => {
	const marker = `pi-ahp-${randomUUID()}`;
	const pty = spawn(
		"sh",
		[
			"-c",
			'test -t 0 && test -t 1 && test -t 2 || exit 70; test "$TERM" = xterm-256color || exit 71; IFS= read -r line; printf "PTY:%s\\n" "$line"',
		],
		{
			name: "xterm-256color",
			cols: 80,
			rows: 24,
		},
	);
	let output = "";
	let exited = false;
	let exitListener: IDisposable | undefined;
	let timer: NodeJS.Timeout | undefined;
	const dataListener = pty.onData((data) => {
		output += data;
	});

	try {
		const result = await new Promise<{ exitCode: number }>((resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`PTY did not exit; output: ${JSON.stringify(output)}`)), 5_000);
			exitListener = pty.onExit((event) => {
				exited = true;
				resolve(event);
			});
			pty.write(`${marker}\r`);
		});

		assert.equal(result.exitCode, 0, `PTY setup failed; output: ${JSON.stringify(output)}`);
		assert.ok(output.includes(`PTY:${marker}`), `missing round-trip marker in ${JSON.stringify(output)}`);
	} finally {
		if (timer) clearTimeout(timer);
		dataListener.dispose();
		exitListener?.dispose();
		if (!exited) pty.kill();
	}
});
