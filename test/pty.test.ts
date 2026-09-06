import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { type IDisposable, spawn } from "node-pty";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

it("round-trips input through a resized TTY", async () => {
	const marker = `pi-ahp-${randomUUID()}`;
	const resized = { cols: 97, rows: 31 };
	const pty = spawn(
		"sh",
		[
			"-c",
			'test -t 0 && test -t 1 && test -t 2 || exit 70; test "$TERM" = xterm-256color || exit 71; IFS= read -r line; set -- $(stty size); printf "PTY:%s:%sx%s\\n" "$line" "$1" "$2"',
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
			pty.resize(resized.cols, resized.rows);
			pty.write(`${marker}\r`);
		});

		assert.equal(result.exitCode, 0, `PTY setup failed; output: ${JSON.stringify(output)}`);
		const expected = `PTY:${marker}:${resized.rows}x${resized.cols}`;
		assert.ok(output.includes(expected), `missing ${expected} in ${JSON.stringify(output)}`);
	} finally {
		if (timer) clearTimeout(timer);
		dataListener.dispose();
		exitListener?.dispose();
		if (!exited) pty.kill();
	}
});

it("delivers Ctrl-C to the foreground job without killing the shell", async () => {
	const marker = randomUUID().replaceAll("-", "");
	const childScript =
		'trap \'printf "INT:%s\\n" "$MARKER"; exit 42\' INT; printf "READY:%s\\n" "$MARKER"; while :; do sleep 1; done';
	const pty = spawn("sh", [], { name: "xterm-256color", cols: 80, rows: 24 });
	let output = "";
	let stage = 0;
	let exited = false;
	let exitListener: IDisposable | undefined;
	let timer: NodeJS.Timeout | undefined;
	const dataListener = pty.onData((data) => {
		output += data;
		if (stage === 0 && output.includes(`READY:${marker}`)) {
			stage = 1;
			pty.write("\x03");
		}
		if (stage === 1 && output.includes(`INT:${marker}`)) {
			stage = 2;
			pty.write(`printf 'AFTER:%s\\n' '${marker}'; exit\r`);
		}
	});

	try {
		const result = await new Promise<{ exitCode: number }>((resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(`PTY did not exit at stage ${stage}: ${JSON.stringify(output)}`)),
				5_000,
			);
			exitListener = pty.onExit((event) => {
				exited = true;
				resolve(event);
			});
			// Expected markers are assembled by the child, so terminal echo cannot satisfy them.
			pty.write(`MARKER='${marker}' sh -c ${shellQuote(childScript)}\r`);
		});

		assert.equal(result.exitCode, 0, `interactive shell died: ${JSON.stringify(output)}`);
		assert.equal(stage, 2, `Ctrl-C flow stopped early: ${JSON.stringify(output)}`);
		assert.ok(output.includes(`AFTER:${marker}`), `shell did not resume: ${JSON.stringify(output)}`);
	} finally {
		if (timer) clearTimeout(timer);
		dataListener.dispose();
		exitListener?.dispose();
		if (!exited) pty.kill();
	}
});
