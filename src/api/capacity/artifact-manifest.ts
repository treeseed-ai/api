import type { AgentArtifactManifest } from '@treeseed/sdk/agent-capacity';

function ids(value: unknown) { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.replace(/_/gu, '-')) : []; }

export function validateAgentArtifactManifest(manifest: AgentArtifactManifest, expected: { publishedSignals?: unknown; artifactContracts?: unknown; signalContracts?: unknown } = {}) {
	if (!manifest || manifest.schemaVersion !== 1 || !manifest.assignmentId || !manifest.modeRunId || !manifest.teamId || !manifest.projectId) return { ok: false as const, reason: 'Artifact manifest identity and scope are required.' };
	if ((manifest.artifactReferences ?? []).some((reference) => reference.contract !== 'treeseed.artifact-ref/v1' || (typeof reference.sha256 === 'string' && !/^[0-9a-f]{64}$/u.test(reference.sha256)) || 'signedUrl' in reference || 'credentials' in reference)) return { ok: false as const, reason: 'Artifact references must be stable, digest-addressed, and secret-free.' };
	if ((manifest.mutationReceipts ?? []).some((receipt) => receipt.assignmentId !== manifest.assignmentId || receipt.modeRunId !== manifest.modeRunId || receipt.teamId !== manifest.teamId || receipt.projectId !== manifest.projectId)) return { ok: false as const, reason: 'Artifact mutation receipt is outside the manifest authority scope.' };
	if (!Array.isArray(manifest.citations) || manifest.citations.some((citation) => !citation || typeof citation !== 'object')) return { ok: false as const, reason: 'Artifact manifest citations are invalid.' };
	if (manifest.status !== 'completed') return { ok: true as const };
	const producedSignals = new Set(manifest.signals.map((signal) => signal.code.replace(/_/gu, '-'))); const missingSignals = [...ids(expected.publishedSignals), ...ids(expected.signalContracts)].filter((id) => !producedSignals.has(id));
	if (missingSignals.length) return { ok: false as const, reason: `Completed agent execution omitted validated publications: ${missingSignals.map((id) => `signal:${id}`).join(', ')}.` };
	const producedArtifacts = new Set(manifest.contentReferences.map((reference) => reference.artifactKind?.replace(/_/gu, '-')).filter(Boolean)); const missingArtifacts = ids(expected.artifactContracts).filter((id) => !producedArtifacts.has(id));
	if (missingArtifacts.length) return { ok: false as const, reason: `Completed agent execution omitted validated publications: ${missingArtifacts.map((id) => `artifact:${id}`).join(', ')}.` };
	if (manifest.contentReferences.some((reference) => reference.model === 'note' && (!reference.subjectId || !reference.subjectField))) return { ok: false as const, reason: 'Completed note receipt is missing its validated subject link.' };
	if (manifest.contentReferences.length || manifest.sourceWorktree || manifest.verification.length || manifest.controlPlaneReferences?.length) return { ok: true as const };
	return { ok: false as const, reason: 'Completed agent execution did not produce a TreeDX content receipt, durable control-plane output, source worktree change, or verification result.' };
}
