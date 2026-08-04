import { createProductionAgentLabExecutor, runScene } from '@treeseed/sdk/scenes';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function record(value: unknown) { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : null; }

export function createAgentLabSimulationExecutor(options: { config?: Record<string, unknown> } = {}) {
	return {
		namespace: 'agent-lab', operation: 'run-scene',
		async run(rawInput: unknown, context: any) {
			const input = record(rawInput); const environment = text(input.environment) ?? 'local';
			if (environment !== 'local') throw new Error('Agent Lab browser simulations are local-only while hosted execution is suspended.');
			const scenePath = text(input.scenePath); const immutableRef = text(input.immutableRef);
			const sceneSource = text(input.sceneSource);
			if (!scenePath || !immutableRef || !sceneSource) throw new Error('Agent Lab simulation requires a scene snapshot and immutable repository ref.');
			const executingServicePrincipalId = text(input.executingServicePrincipalId) ?? process.env.TREESEED_AGENT_LAB_SERVICE_PRINCIPAL_ID ?? null;
			await context.checkpoint({ phase: 'agent-lab.scene.starting', scenePath, immutableRef }, { kind: 'agent_lab.scene.starting', data: { scenePath, immutableRef, initiatingUserId: input.initiatingUserId ?? null, executingServicePrincipalId } });
			const snapshotPath = resolve(context.workspaceRoot, '.treeseed/operations/agent-lab', context.operationId, 'scene.yaml');
			await mkdir(dirname(snapshotPath), { recursive: true });
			await writeFile(snapshotPath, sceneSource, { encoding: 'utf8', mode: 0o600 });
			const executor = createProductionAgentLabExecutor({ env: process.env, assignmentExecutor: async () => { throw new Error('Ephemeral browser simulations require an Agent-owned execution bridge; use a seeded team-scoped scene.'); } });
			let reportPath: string | null = null;
			const report = await runScene({ projectRoot: context.workspaceRoot, scene: snapshotPath, environment: 'local', runId: context.operationId, agentLabExecutor: executor, onProgress: (event) => { void context.emit({ kind: `agent_lab.${event.type}`, data: record(event.data) }); }, onAgentLabReportReady: async ({ path }) => { reportPath = path; await context.checkpoint({ phase: 'agent-lab.report.ready', reportPath: path }, { kind: 'agent_lab.report.ready', data: { reportPath: path } }); } });
			if (!report.ok) throw new Error(report.blockers?.map((entry) => entry.message).join('; ') || 'Agent Lab scene failed.');
			return { ok: true, sceneId: report.sceneId, runId: report.runId, immutableRef, sceneSnapshotPath: snapshotPath, reportPath, artifacts: report.artifacts, executingServicePrincipalId };
		},
	};
}
