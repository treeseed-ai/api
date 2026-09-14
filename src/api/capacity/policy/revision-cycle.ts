import type {
	DecisionAssignmentGraph,DecisionAssignmentGraphEdge,DecisionAssignmentGraphNode,DeliverableContract,
	GovernedRevisionCycleResult,GovernedRevisionCycleInput,
} from '@treeseed/sdk/agent-capacity';

function nextCycle(graph: DecisionAssignmentGraph) {
	return Math.max(0,...graph.nodes.map((node)=>Number(node.metadata?.revisionCycle??0)).filter(Number.isFinite))+1;
}

/** Adds a new acting/review pair without reopening or mutating prior assignments. */
export function compileGovernedRevisionCycle(graph:DecisionAssignmentGraph,input:GovernedRevisionCycleInput):GovernedRevisionCycleResult|null {
	const rejected=graph.nodes.find((node)=>node.id===input.rejectedReviewNodeId&&node.activityType==='reviewing'); if(!rejected)return null;
	const maximum=Math.max(0,Number(rejected.metadata?.maximumRevisionCycles??graph.metadata?.maximumRevisionCycles??1)); const revisionCycle=nextCycle(graph); if(revisionCycle>maximum)return null;
	const prefix=`${graph.id}:revision:${revisionCycle}`;
	const revisionContract:DeliverableContract={id:`${prefix}:deliverable:checkpoint`,teamId:graph.teamId,projectId:graph.projectId,decisionId:graph.decisionId,
		deliverableType:'implementation_revision',producerAgentClasses:[input.actorAgentClass],acceptanceCriteria:[`Resolve immutable findings ${input.findingsRef} against checkpoint ${input.rejectedCheckpointRef}.`],status:'required',
		metadata:{revisionCycle,rejectedReviewNodeId:rejected.id,rejectedCheckpointRef:input.rejectedCheckpointRef,findingsRef:input.findingsRef}};
	const reviewContract:DeliverableContract={id:`${prefix}:deliverable:review`,teamId:graph.teamId,projectId:graph.projectId,decisionId:graph.decisionId,
		deliverableType:'review_disposition',producerAgentClasses:[input.reviewerAgentClass],reviewerAgentClasses:[input.reviewerAgentClass],acceptanceCriteria:['Review the exact revised checkpoint; any prior approval is stale.'],status:'required',metadata:{revisionCycle,reviewedContractId:revisionContract.id}};
	const revisionNode:DecisionAssignmentGraphNode={id:`${prefix}:node:acting`,decisionId:graph.decisionId,projectId:graph.projectId,targetAgentClass:input.actorAgentClass,activityType:'acting',requiredCapabilities:['treeseed.engineering.code-change'],requiredDeliverableContractIds:[],
		inputRefs:[{model:'note',collection:'notes',slug:input.findingsRef,id:input.findingsRef}],outputRequirements:[{id:revisionContract.id,outputType:'implementation_revision',required:true}],capacity:{expectedSeconds:input.availableSeconds,maxSeconds:input.availableSeconds},status:'ready',
		metadata:{stage:'revision',revisionCycle,priorCheckpointRef:input.rejectedCheckpointRef,findingsRef:input.findingsRef,producesDeliverableContractId:revisionContract.id,contributingEstimateIds:rejected.metadata?.contributingEstimateIds??[]}};
	const reviewNode:DecisionAssignmentGraphNode={id:`${prefix}:node:review`,decisionId:graph.decisionId,projectId:graph.projectId,targetAgentClass:input.reviewerAgentClass,activityType:'reviewing',requiredCapabilities:['treeseed.engineering.review'],requiredDeliverableContractIds:[revisionContract.id],inputRefs:[],
		outputRequirements:[{id:reviewContract.id,outputType:'review_disposition',required:true}],capacity:{expectedSeconds:Math.max(1,Math.floor(input.availableSeconds/3)),maxSeconds:Math.max(1,Math.floor(input.availableSeconds/3))},status:'pending',
		metadata:{stage:'review',revisionCycle,reviewedNodeId:revisionNode.id,reviewedContractId:revisionContract.id,exactCheckpointRequired:true,maximumRevisionCycles:maximum,rejectionCreatesRevision:true,producesDeliverableContractId:reviewContract.id,contributingEstimateIds:rejected.metadata?.contributingEstimateIds??[]}};
	const integration=graph.nodes.find((node)=>node.metadata?.platformControlled===true&&node.metadata?.stage==='integration');
	const edges:DecisionAssignmentGraphEdge[]=graph.edges.filter((edge)=>!integration||edge.fromNodeId!==rejected.id||edge.toNodeId!==integration.id);
	edges.push({fromNodeId:rejected.id,toNodeId:revisionNode.id,edgeType:'blocks-start',reason:input.reason},{fromNodeId:revisionNode.id,toNodeId:reviewNode.id,edgeType:'blocks-start',reason:'The revised checkpoint requires a new independent review.'});
	if(integration)edges.push({fromNodeId:reviewNode.id,toNodeId:integration.id,edgeType:'blocks-start',reason:'Platform integration waits for the revised checkpoint review.'});
	return {revisionCycle,newContracts:[revisionContract,reviewContract],graph:{...graph,status:'executing',deliverableContracts:[...graph.deliverableContracts.map((contract)=>contract.id===rejected.metadata?.producesDeliverableContractId?{...contract,status:'rejected' as const}:contract.status==='approved'&&contract.metadata?.reviewedContractId===rejected.metadata?.reviewedContractId?{...contract,status:'stale' as const}:contract),revisionContract,reviewContract],
		nodes:[...graph.nodes.map((node)=>node.id===rejected.id?{...node,status:'completed' as const}:node.id===integration?.id?{...node,requiredDeliverableContractIds:[...node.requiredDeliverableContractIds,reviewContract.id],status:'pending' as const}:node),revisionNode,reviewNode],edges,metadata:{...(graph.metadata??{}),revisionCycles:revisionCycle,latestRevisionReason:input.reason}}};
}
