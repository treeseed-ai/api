import { randomUUID } from 'node:crypto';
import { agentLabMetricKeys } from '@treeseed/sdk/agent-capacity';
import type { Hono } from 'hono';
import type { WorkdayRouteDependencies } from '../workday-route-dependencies.ts';
import { readCapacityRequestObject } from '../request-json.ts';

export function installAgentLabTargetRoutes(app: Hono, dependencies: WorkdayRouteDependencies) {
	app.patch('/v1/teams/:teamId/agent-lab/targets', async (c) => {
		const access = await dependencies.manage(c); if (access.response) return access.response;
		const body = await readCapacityRequestObject(c, { optional: true }); const requested = body.targets;
		if (!requested || typeof requested !== 'object' || Array.isArray(requested)) return c.json({ ok: false, code: 'agent_lab_targets_invalid', error: 'Provide metric targets as an object.' }, 400);
		const team = await dependencies.store.first('SELECT metadata_json, updated_at FROM teams WHERE id = ? LIMIT 1', [c.req.param('teamId')]);
		if (!team) return dependencies.notFound(c, 'Unknown team.');
		if (typeof body.expectedRevision === 'string' && body.expectedRevision !== team.updated_at) return c.json({ ok: false, code: 'agent_lab_targets_stale', error: 'Metric targets changed. Reload before saving again.' }, 409);
		const metadataValue = typeof team.metadata_json === 'string' ? (() => { try { return JSON.parse(team.metadata_json); } catch { return {}; } })() : {};
		const metadata = metadataValue && typeof metadataValue === 'object' && !Array.isArray(metadataValue) ? metadataValue : {};
		const prior = metadata.agentLab?.metricTargets && typeof metadata.agentLab.metricTargets === 'object' ? metadata.agentLab.metricTargets : {};
		const targets: Record<string, number> = Object.fromEntries(Object.entries(prior).filter(([key, value]) => agentLabMetricKeys.includes(key as typeof agentLabMetricKeys[number]) && typeof value === 'number' && Number.isFinite(value) && value >= 0));
		const input = requested as Record<string, unknown>;
		for (const key of agentLabMetricKeys) {
			if (!(key in input)) continue;
			if (input[key] === null || input[key] === '') { delete targets[key]; continue; }
			const value = Number(input[key]); if (!Number.isFinite(value) || value < 0) return c.json({ ok: false, code: 'agent_lab_target_invalid', error: `${key} target must be a nonnegative number.` }, 400);
			targets[key] = value;
		}
		const now = new Date().toISOString(); metadata.agentLab = { ...(metadata.agentLab ?? {}), metricTargets: targets };
		await dependencies.store.run('UPDATE teams SET metadata_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(metadata), now, c.req.param('teamId')]);
		await dependencies.store.run("INSERT INTO audit_events (id, actor_type, actor_id, event_type, target_type, target_id, data_json, created_at) VALUES (?, 'user', ?, 'agent_lab.metric_targets.updated', 'team', ?, ?, ?)", [randomUUID(), access.principal?.id ?? null, c.req.param('teamId'), JSON.stringify({ metricKeys: Object.keys(targets) }), now]);
		return c.json({ ok: true, payload: { targets, revision: now } });
	});
}
