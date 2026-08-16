import { describe,expect,it } from 'vitest';
import { assignmentAuthorityProbe } from '../../../../../src/api/capacity/services/capacity/assignments/observability/assignment-authority-probe-service.ts';

describe('assignment authority probe service',()=>{
	it('reads only the immutable authority frozen into the assignment',()=>{
		const result=assignmentAuthorityProbe({ id:'assignment-1',mode:'planning',workspaceContext:{upstreamMutationPolicy:'denied'},
			metadata:{ activityType:'planning',configurationRevisions:{agentDefinitionRevision:'old'} },
			decisionInput:{ input:{ agentDefinition:{immutableRef:'exact-ref'},contextQueryRefs:[{id:'query',revision:2}],instructionTemplateRefs:[{id:'plan',revision:1}],
				authoritySnapshot:{ permissions:{content:{decision:{operations:['read']}},repository:{writePaths:[]}},tools:{allowed:['treeseed.content.read']},branchPolicy:{kind:'staging-content',base:'staging'} },
				signalPolicy:{publishes:['evidence-ready']},outputContract:{modelMutations:['note:create']} } } });
		expect(result).toMatchObject({ assignmentId:'assignment-1',activityType:'planning',passed:true,
			selection:{definitionRevision:'exact-ref',contextQueryRefs:[{id:'query',revision:2}]}});
		expect(result.denials).toHaveLength(5);
	});
});
