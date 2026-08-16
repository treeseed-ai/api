import { describe,expect,it } from 'vitest';
import { assignmentConfigurationAttribution,compilePlanningAllowedOutputs,compilePlanningAssignmentInput,resolveAssignmentContentBaseRef } from '../../../../../src/api/capacity/services/capacity/assignments/planning/assignment-function.ts';

describe('workday assignment input', () => {
	it('attributes performance to the exact frozen groups and configuration snapshot', () => {
		const value=assignmentConfigurationAttribution({payload:{groupIds:['editorial-team','research'],planningGraph:{revision:'graph-1'},
			agentDefinition:{immutableRef:'a'.repeat(40)},contextQueryRefs:[{kind:'query-set',id:'guide-work',revision:2}],
			instructionTemplateRefs:[{id:'assignment-plan',revision:1}],permissions:{content:{}},toolPolicy:{allowed:['read']},
			signalPolicy:{publishes:['evidence-ready']},outputContract:{modelMutations:['linked_note:create']}},
			projectAgentClassId:'project:evidence',activityType:'planning',handlerId:'writer',contentBaseRef:'b'.repeat(40),
			executionProvider:{metadata:{configurationRevision:'provider-config-1'}}});
		expect(value.groupIds).toEqual(['editorial-team','research']);
		expect(value.configurationRevisions).toMatchObject({planningGraphRevision:'graph-1',agentDefinitionRevision:'a'.repeat(40),executionProviderConfigurationRevision:'provider-config-1'});
		for(const [key,revision] of Object.entries(value.configurationRevisions)) expect(revision, key).toBeTruthy();
	});
	it('projects the complete resolved intent into the handler payload', () => {
		const relatedArtifacts = [{
			model: 'note', contentPath: 'src/content/notes/editorial/plan.mdx',
			commitSha: 'commit-a', artifactKind: 'planning_note',
		}];
		expect(compilePlanningAssignmentInput({
			intent: { stale: 'nested copy remains forensic' }, planningSource: 'configured-idle-intent',
		}, {
			objective: 'Review the preceding planning artifact.', artifactKind: 'review_note',
			subjectModel: 'objective', subjectId: 'core', subjectPath: 'src/content/objectives/core.md',
			includeWorkdayArtifacts: true, relatedArtifacts,
		}, 'reviewing')).toMatchObject({
			activityType: 'reviewing', objective: 'Review the preceding planning artifact.', artifactKind: 'review_note',
			subjectModel: 'objective', subjectId: 'core', subjectPath: 'src/content/objectives/core.md',
			includeWorkdayArtifacts: true, relatedArtifacts,
		});
	});

	it('freezes the exact proposal type and signal contract into the assignment', () => {
		expect(compilePlanningAllowedOutputs({ signalPolicy: { publishes: ['proposal-ready'] } }, {
			artifactKind: 'planning_proposal',
			proposalTypes: ['guide-planning', 'governed-content-workflow'],
		}, 'proposing', ['src/content/proposals/**'])).toEqual({
			paths: ['src/content/proposals/**'],
			types: ['content_artifact_refs', 'planning_proposal'],
			proposalTypes: ['guide-planning', 'governed-content-workflow'],
			publishedSignals: ['proposal-ready'],
		});
	});

	it('advances sequential workday assignments from the newest durable artifact commit', () => {
		expect(resolveAssignmentContentBaseRef({
			contentBaseRef: 'refs/heads/main',
			intent: { relatedArtifacts: [
				{ contentPath: 'src/content/notes/latest.mdx', commitSha: 'commit-latest' },
				{ contentPath: 'src/content/notes/older.mdx', commitSha: 'commit-older' },
			] },
		})).toBe('commit-latest');
	});

	it('bases a proposal revision on the exact proposal version instead of a review-note commit', () => {
		const proposalVersion = 'a'.repeat(40);
		expect(resolveAssignmentContentBaseRef({
			contentBaseRef: 'refs/heads/main',
			intent: {
				subjectModel: 'proposal',
				relatedArtifact: {
					model: 'proposal', contentPath: 'src/content/proposals/platform.mdx',
					version: proposalVersion, commitSha: 'b'.repeat(40),
				},
				relatedArtifacts: [{
					model: 'note', contentPath: 'src/content/notes/review.mdx',
					commitSha: 'c'.repeat(40),
				}],
			},
		})).toBe(proposalVersion);
	});

	it('bases an objective-scoped revision on its signal-routed proposal version', () => {
		const proposalVersion = 'd'.repeat(40);
		expect(resolveAssignmentContentBaseRef({
			contentBaseRef: 'refs/heads/main',
			intent: {
				subjectModel: 'objective', artifactKind: 'planning_proposal',
				upstreamEvidence: [{ payload: {
					proposalId: 'proposal:platform', version: proposalVersion,
					evidenceRefs: [{ model: 'proposal', version: proposalVersion }],
				} }],
			},
		})).toBe(proposalVersion);
	});
});
