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
			const bundleRoot = resolve(context.workspaceRoot, '.treeseed/operations/agent-lab', context.operationId, 'bundle');
			const snapshotPath = resolve(bundleRoot, 'scenes', 'scene.yaml');
			await mkdir(dirname(snapshotPath), { recursive: true });
			await writeFile(snapshotPath, sceneSource, { encoding: 'utf8', mode: 0o600 });
			for (const seed of Array.isArray(input.seedSources) ? input.seedSources.map(record) : []) {
				const name = text(seed.name); const source = text(seed.source); if (!name || !source || !/^[a-z0-9._-]+$/u.test(name)) throw new Error('Agent Lab simulation contains an invalid prerequisite seed bundle.');
				const seedPath = resolve(bundleRoot, 'seeds', `${name}.yaml`); await mkdir(dirname(seedPath), { recursive: true }); await writeFile(seedPath, source, { encoding: 'utf8', mode: 0o600 });
			}
			const executor = createProductionAgentLabExecutor({ env: process.env });
			let reportPath: string | null = null;
			const report = await runScene({ projectRoot: bundleRoot, scene: snapshotPath, environment: 'local', runId: context.operationId, agentLabContentRef: immutableRef, agentLabExecutor: executor, onProgress: (event) => { void context.emit({ kind: `agent_lab.${event.type}`, data: record(event.data) }); }, onAgentLabReportReady: async ({ path }) => { reportPath = path; await context.checkpoint({ phase: 'agent-lab.report.ready', reportPath: path }, { kind: 'agent_lab.report.ready', data: { reportPath: path } }); } });
			if (!report.ok) throw new Error(report.blockers?.map((entry) => entry.message).join('; ') || 'Agent Lab scene failed.');
			return { ok: true, sceneId: report.sceneId, runId: report.runId, immutableRef, sceneSnapshotPath: snapshotPath, reportPath, artifacts: report.artifacts, executingServicePrincipalId };
		},
	};
}
