import {describe,expect,it} from 'vitest';
import {projectAgentActivityRefs} from '../../../../../src/api/capacity/services/projects/projects-core/project-agent-activity-refs.ts';

describe('agent context query layers',()=>{
	it('keeps general agent queries ahead of additive activity queries',()=>{
		const [agent]=projectAgentActivityRefs({agents:[{slug:'architect',name:'Architect',contextQueryRefs:[{id:'project-foundation',revision:1}],contextQuerySetRefs:[{id:'shared-knowledge',revision:2}],activities:{chat:{enabled:true,handler:'writer',contextQueryRefs:[{id:'chat-focus',revision:3}],contextQuerySetRefs:[{id:'discussion-context',revision:4}]}}}]},'chat');
		expect(agent.contextQueryLayers).toEqual({agent:{queryRefs:[{id:'project-foundation',revision:1}],querySetRefs:[{id:'shared-knowledge',revision:2}]},activity:{queryRefs:[{id:'chat-focus',revision:3}],querySetRefs:[{id:'discussion-context',revision:4}]}});
		expect(agent.contextQueryRefs.map((value)=>value.id)).toEqual(['project-foundation','chat-focus']);
	});
});
