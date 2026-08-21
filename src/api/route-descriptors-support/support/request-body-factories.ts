export function bodyFactoryFor(path, method) {
    if (method === 'get')
        return null;
	if (path === '/v1/operator/commands/read')
		return 'operatorRead';
	if (path === '/v1/operator/commands/mutations')
		return 'operatorMutation';
    if (path.includes('/auth/device/start'))
        return 'deviceStart';
    if (path === '/v1/feedback')
        return 'feedback';
    if (path.includes('/auth/device/poll'))
        return 'devicePoll';
    if (path.includes('/auth/device/approve'))
        return 'deviceApprove';
    if (path.includes('/auth/web/sign-up'))
        return 'webSignUp';
    if (path.includes('/auth/web/confirm-email'))
        return 'emailConfirm';
    if (path.includes('/auth/web/sign-in'))
        return 'webSignIn';
    if (path.includes('/auth/web/sessions/'))
        return 'sessionRevoke';
    if (path.includes('/auth/web/profile'))
        return 'webProfile';
    if (path.includes('/auth/web/appearance'))
        return 'webAppearance';
    if (path.includes('/auth/web/preferences'))
        return 'accountPreferences';
    if (path.includes('/auth/web/email'))
        return 'webEmail';
    if (path.includes('/auth/web/password-reset/request'))
        return 'passwordResetRequest';
    if (path.includes('/auth/web/password-reset/complete'))
        return 'passwordResetComplete';
    if (path.includes('/auth/web/password'))
        return 'webPassword';
    if (path.includes('/auth/token/refresh'))
        return 'refreshToken';
    if (path.startsWith('/v1/ui/governance/') && path.endsWith('/decision'))
        return 'approvalDecision';
    if (path.includes('/platform/operations') && path.endsWith('/cancel'))
        return 'platformOperationCancel';
    if (path.includes('/platform/operations') && path.endsWith('/retry'))
        return 'platformOperationRetry';
    if (path === '/v1/platform/operations')
        return 'platformOperationCreate';
    if (path.includes('/platform/runners/register'))
        return 'platformRunnerRegister';
    if (path.includes('/platform/runners/heartbeat'))
        return 'platformRunnerHeartbeat';
    if (path.includes('/platform/runners/jobs/claim'))
        return 'platformRunnerClaim';
    if (path.includes('/platform/runners/jobs/') && path.endsWith('/events'))
        return 'platformRunnerEvent';
    if (path.includes('/platform/runners/jobs/') && path.endsWith('/checkpoint'))
        return 'platformRunnerCheckpoint';
    if (path.includes('/platform/runners/jobs/') && path.endsWith('/renew-lease'))
        return 'platformRunnerRenew';
    if (path.includes('/platform/runners/jobs/') && path.endsWith('/cancel'))
        return 'platformRunnerCancel';
    if (path.includes('/platform/runners/jobs/') && path.endsWith('/complete'))
        return 'platformRunnerComplete';
    if (path.includes('/platform/runners/jobs/') && path.endsWith('/fail'))
        return 'platformRunnerFail';
    if (path.includes('/provider/assignments/next'))
        return 'providerNextAssignment';
    if (path.includes('/provider/assignments/') && path.endsWith('/mode-runs'))
        return 'agentModeRun';
    if (path.includes('/provider/assignments/') && path.includes('/workflow-operations/') && path.endsWith('/dispatch'))
        return 'providerAssignmentWorkflowOperationDispatch';
    if (path.includes('/provider/assignments/') && path.endsWith('/renew'))
        return 'providerAssignmentRenew';
    if (path.includes('/provider/assignments/') && path.endsWith('/return'))
        return 'providerAssignmentReturn';
    if (path.includes('/provider/assignments/') && path.endsWith('/completion-preflight'))
        return 'providerAssignmentComplete';
    if (path.includes('/provider/assignments/') && path.endsWith('/complete'))
        return 'providerAssignmentComplete';
    if (path.includes('/provider/assignments/') && path.endsWith('/fail'))
        return 'providerAssignmentFail';
    if (path.includes('/provider/assignments/') && path.endsWith('/usage'))
        return 'empty';
    if (path.includes('/provider/assignments/') && path.endsWith('/settle'))
        return 'empty';
    if (path.includes('/decisions/') && path.endsWith('/planning-input-requests'))
        return 'planningInputRequest';
    if (path.includes('/decisions/') && path.endsWith('/execution-inputs'))
        return 'decisionExecutionInput';
    if (path.includes('/decision-execution-inputs/') && path.endsWith('/accept'))
        return 'empty';
    if (path.includes('/decision-execution-inputs/') && path.endsWith('/request-revision'))
        return 'decisionExecutionRevision';
    if (path.includes('/decisions/') && path.endsWith('/capacity-plans'))
        return 'agentCapacityPlan';
    if (path.includes('/capacity-plans/') && (path.endsWith('/accept') || path.endsWith('/schedule')))
        return 'empty';
    if (path.includes('/capacity-plans/') && path.endsWith('/request-revision'))
        return 'decisionExecutionRevision';
    if (path.includes('/capacity-plans/') && path.endsWith('/supersede'))
        return 'decisionExecutionRevision';
    if (path === '/v1/workdays')
        return 'workdayCapacityEnvelope';
    if (path.includes('/workdays/') && (path.endsWith('/start') || path.endsWith('/pause') || path.endsWith('/resume') || path.endsWith('/complete') || path.endsWith('/cancel')))
        return 'empty';
    if (path.includes('/teams') && path.endsWith('/projects'))
        return 'projectCreate';
    if (path.includes('/teams') && path.endsWith('/projects/launch'))
        return 'projectLaunch';
    if (path.includes('/teams') && path.endsWith('/invites'))
        return 'teamInvite';
    if (path.includes('/teams') && path.includes('/members/'))
        return method === 'delete' ? 'empty' : 'teamMemberUpdate';
    if (path.includes('/teams') && path.includes('/capacity-grants'))
        return 'capacityGrant';
    if (path.includes('/teams') && path.includes('/capacity/allocation-sets'))
        return path.endsWith('/activate') ? 'empty' : 'capacityAllocationSet';
    if (path.includes('/teams') && path.includes('/capacity/assignments'))
        return 'providerAssignment';
    if (path.includes('/teams') && path.includes('/hosting-audit'))
        return 'hostingAudit';
    if (path.includes('/teams') && path.includes('/seeds/export'))
        return 'seedExport';
    if (path === '/v1/teams')
        return 'teamCreate';
    if (path === '/v1/commons/questions')
        return method === 'get' ? 'empty' : 'commonsQuestion';
    if (path.startsWith('/v1/commons/questions/') && path.endsWith('/answer'))
        return 'commonsQuestionAnswer';
    if (path.startsWith('/v1/commons/questions/') && path.endsWith('/convert-to-proposal'))
        return 'commonsProposal';
    if (path === '/v1/commons/proposals')
        return method === 'get' ? 'empty' : 'commonsProposal';
    if (path.startsWith('/v1/commons/proposals/') && path.endsWith('/back'))
        return 'commonsBacking';
    if (path.startsWith('/v1/commons/proposals/') && path.endsWith('/vote'))
        return 'commonsVote';
    if (path.startsWith('/v1/commons/proposals/') && path.endsWith('/steward-decision'))
        return 'commonsStewardDecision';
    if (path.startsWith('/v1/commons/proposals/'))
        return method === 'get' ? 'empty' : 'commonsDecision';
    if (path === '/v1/commons/delegations')
        return method === 'get' ? 'empty' : 'commonsDelegation';
    if (path.startsWith('/v1/commons/delegations/') && path.endsWith('/revoke'))
        return 'commonsDecision';
    if (path.startsWith('/v1/commons/participants/') && path.endsWith('/backfill'))
        return 'empty';
    if (path.startsWith('/v1/commons/'))
        return 'empty';
    if (path.startsWith('/v1/projects/:projectId/secrets/github-actions/deploy'))
        return 'githubActionsSecretDeploy';
    if (path.startsWith('/v1/projects/:projectId/workflow-operations/') && path.endsWith('/dispatch'))
        return 'workflowOperationDispatch';
    if (path.startsWith('/v1/projects/:projectId'))
		return path.includes('/approval') ? 'approvalDecision'
						: path.includes('/agent-classes') ? 'projectAgentClass'
                            : path.includes('/runner/') ? 'runnerProjectBody'
                                : path.includes('/resources') ? 'projectResource'
                                        : path.includes('/hosting') || path.includes('/environments') ? 'projectEnvironment'
                                            : path.includes('/workspace-links') ? 'workspaceLink'
                                                : path.includes('/update-plans') ? 'updatePlan'
                                                    : path.includes('/share') ? 'shareOperation'
                                                        : path.includes('/releases') ? 'releaseOperation'
                                                            : path.includes('/workstreams') ? 'workstreamOperation'
                                                                : path.includes('/capabilities') ? 'capability'
                                                                    : 'projectUpdate';
    if (path.startsWith('/v1/jobs/'))
        return 'jobOperation';
    if (path.startsWith('/v1/approval-requests/'))
        return 'approvalDecision';
    if (path.startsWith('/v1/seeds/'))
        return 'seedPlan';
    return 'empty';
}
