type Row = Record<string, unknown>;

interface Store {
	first(query: string, values?: unknown[]): Promise<Row | null>;
}

interface Entity {
	kind: string;
	title: string;
	description: string;
	status?: string | null;
	projectName?: string | null;
	activityProfile?: string | null;
	occurredAt?: string | null;
}

function record(value: unknown): Row {
	if (value && typeof value === 'object' && !Array.isArray(value)) return value as Row;
	if (typeof value === 'string') try { return record(JSON.parse(value)); } catch { return {}; }
	return {};
}

function text(...values: unknown[]) {
	return String(values.find((value) => typeof value === 'string' && value.trim()) ?? '').trim();
}

function humanContent(kind: string, value: string) {
	if (kind !== 'proposal') return value;
	const evidenceBoundary = value.search(/\n\s*Agent evidence\s*:/iu);
	return evidenceBoundary < 0 ? value : value.slice(0, evidenceBoundary).trim();
}

function readableContent(kind: string, item: Entity, source: Row) {
	const selected = record(source.selected_input_json);
	const lifecycle = record(source.lifecycle_output_json);
	const output = record(source.outputs_json);
	const decision = record(source.decision_record_json);
	const metadata = record(source.metadata_json);
	const candidates: Record<string, unknown[]> = {
		proposal: [source.body, source.summary],
		decision: [decision.rationale, decision.summary, source.rationale, source.summary],
		question: [source.body, source.question, source.answer],
		artifact: [source.content, source.body, output.content, output.summary],
		error: [source.message, record(source.payload_json).message],
		agent: [source.description, selected.prompt, source.prompt],
		assignment: [source.lifecycle_reason, selected.request, selected.assignment, selected.prompt],
		execution: [lifecycle.summary, lifecycle.output, output.summary, output.content],
		simulation: [metadata.summary, source.summary, source.description],
		seed: [source.summary, source.description],
		workday: [metadata.summary, source.summary],
		note: [source.body, source.content, source.summary],
	};
	const strictContentKinds = new Set(['proposal', 'question', 'decision', 'note', 'artifact']);
	return humanContent(kind, text(...(candidates[kind] ?? []), ...(strictContentKinds.has(kind) ? [] : [item.description])));
}

function contentLabel(kind: string) {
	return ({ proposal: 'Proposal', question: 'Question', decision: 'Decision', note: 'Note', artifact: 'Result', error: 'What happened', agent: 'Purpose', assignment: 'Assignment request', execution: 'Execution outcome', simulation: 'Simulation', seed: 'Seed definition', workday: 'Workday summary' } as Record<string, string>)[kind] ?? 'Summary';
}

export async function commandPrimaryView(store: Store, kind: string, item: Entity, source: Row) {
	const metadata = record(source.metadata_json);
	const actorType = text(source.created_by_type, source.actor_type, metadata.actorType, source.user_id ? 'user' : '');
	const actorId = text(source.created_by_id, source.actor_id, source.user_id, metadata.actorId);
	const user = actorType === 'user' && actorId
		? await store.first('SELECT display_name, email, username FROM users WHERE id = ? LIMIT 1', [actorId]).catch(() => null)
		: null;
	const simulationActor = actorType === 'team_api_key' && Boolean(metadata.agentLab);
	const actorName = text(user?.display_name, user?.username, user?.email, source.created_by_name, metadata.actorName,
		actorType === 'agent' ? metadata.authorAgentId : null,
		simulationActor ? 'Agent Lab simulation operator' : actorType === 'team_api_key' ? 'Team automation' : actorType === 'agent' ? 'Agent participant' : actorType === 'user' ? 'Team member' : 'System participant');
	const actorDetail = simulationActor ? 'simulation service principal' : actorType.replace(/_/gu, ' ') || null;
	const body = readableContent(kind, item, source);
	const classification = text(source.proposal_type, source.artifact_kind, source.event_type, source.mode, kind.replace(/-/gu, ' '));
	const facts = [
		{ label: 'Status', value: item.status },
		{ label: 'Project', value: item.projectName },
		{ label: 'Activity', value: item.activityProfile },
	].filter((entry) => entry.value !== null && entry.value !== undefined && entry.value !== '');
	return {
		actor: { label: kind === 'proposal' ? 'Proposed by' : kind === 'question' ? 'Asked by' : 'Recorded by', name: actorName, detail: actorDetail },
		postedAt: text(source.created_at, source.started_at, item.occurredAt) || null,
		content: { label: contentLabel(kind), body, classification, missing: !body },
		facts,
	};
}
