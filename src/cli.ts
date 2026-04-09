import { spawnSync } from 'node:child_process';
import { createTreeseedCommandContext, executeTreeseedCommand } from '@treeseed/sdk/treeseed-cli';
import type { ApiCliCommandResponse, CliHttpCommandRequest } from './types.ts';

function splitCapturedLines(lines: string[]) {
	return lines
		.flatMap((line) => line.split(/\r?\n/))
		.map((line) => line.trimEnd())
		.filter(Boolean);
}

export async function executeCliHttpCommand(commandName: string, request: CliHttpCommandRequest): Promise<ApiCliCommandResponse> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const context = createTreeseedCommandContext({
		cwd: request.cwd ?? process.cwd(),
		env: {
			...process.env,
			...(request.env ?? {}),
		},
		outputFormat: 'json',
		write: (output, stream = 'stdout') => {
			(stream === 'stderr' ? stderr : stdout).push(output);
		},
		spawn: (command, args, options) => {
			const result = spawnSync(command, args, {
				cwd: options.cwd,
				env: options.env,
				encoding: 'utf8',
			});
			if (result.stdout) stdout.push(result.stdout);
			if (result.stderr) stderr.push(result.stderr);
			return { status: result.status };
		},
	});

	const exitCode = await executeTreeseedCommand(commandName, request.argv ?? [], context);
	const payloadCandidate = [...stdout, ...stderr].find((line) => line.trim().startsWith('{'));
	const parsedReport =
		payloadCandidate
			? (() => {
					try {
						return JSON.parse(payloadCandidate) as Record<string, unknown>;
					} catch {
						return null;
					}
			  })()
			: null;

	return {
		ok: typeof parsedReport?.ok === 'boolean' ? Boolean(parsedReport.ok) : exitCode === 0,
		command: commandName,
		exitCode,
		stdout: parsedReport ? splitCapturedLines(parsedReport.stdout as string[] ?? []) : splitCapturedLines(stdout),
		stderr: parsedReport ? splitCapturedLines(parsedReport.stderr as string[] ?? []) : splitCapturedLines(stderr),
		report: parsedReport,
	};
}
