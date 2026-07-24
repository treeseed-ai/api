import { isTreeDxCredentialBridgePath } from '../index.js';

export function bodyFactoryFor(path, method) {
    if (method === 'get')
        return null;
    if (path === '/v1/internal/github/app/webhook')
        return 'empty';
    if (isTreeDxCredentialBridgePath(path))
        return 'treedxCredentialBridge';
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
    if (path.includes('/teams') && path.includes('/repository-hosts'))
        return method === 'delete' ? 'empty' : 'repositoryHost';
    if (path.includes('/teams') && (path.includes('/web-hosts') || path.includes('/hosts')))
        return method === 'delete' ? 'empty' : path.endsWith('/validate') ? 'hostValidate' : 'webHost';
    if (path.includes('/teams') && path.includes('/capacity-grants'))
        return 'capacityGrant';
    if (path.includes('/teams') && path.includes('/capacity/allocation-sets'))
        return path.endsWith('/activate') ? 'empty' : 'capacityAllocationSet';
    if (path.includes('/teams') && path.includes('/capacity/assignments'))
        return 'providerAssignment';
    if (path.includes('/teams') && path.includes('/provider-credential-sessions'))
        return 'providerCredentialSession';
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
    if (path.startsWith('/v1/commerce/vendors/') && path.endsWith('/request'))
        return 'commerceVendorRequest';
    if (path.startsWith('/v1/commerce/vendors/') && path.endsWith('/approve'))
        return 'commerceVendorApproval';
    if (path.startsWith('/v1/commerce/vendors/') && path.endsWith('/stripe/onboarding'))
        return 'commerceStripeOnboarding';
    if (path.startsWith('/v1/commerce/vendors/') && path.endsWith('/stripe/return'))
        return 'commerceTransition';
    if (path.startsWith('/v1/commerce/vendors/') && path.endsWith('/stripe/login-link'))
        return 'empty';
    if (path === '/v1/commerce/services/requests')
        return method === 'get' ? 'empty' : 'commerceServiceRequest';
    if (path.startsWith('/v1/commerce/services/requests/') && path.endsWith('/cancel'))
        return 'commerceServiceDecision';
    if (path.startsWith('/v1/commerce/services/requests/') && path.endsWith('/scoping'))
        return 'commerceServiceDecision';
    if (path.startsWith('/v1/commerce/services/requests/') && path.endsWith('/quotes'))
        return method === 'get' ? 'empty' : 'commerceServiceQuote';
    if (path.startsWith('/v1/commerce/services/requests/'))
        return method === 'patch' ? 'commerceServiceRequestUpdate' : 'empty';
    if (path.startsWith('/v1/commerce/services/quotes/') && (path.endsWith('/submit') || path.endsWith('/buyer-approve') || path.endsWith('/vendor-approve') || path.endsWith('/reject')))
        return 'commerceServiceDecision';
    if (path.startsWith('/v1/commerce/services/contracts/') && path.endsWith('/checkout'))
        return 'commerceServiceContractCheckout';
    if (path.startsWith('/v1/commerce/services/contracts/') && path.endsWith('/link-work'))
        return 'commerceServiceWorkLink';
    if (path.startsWith('/v1/commerce/services/contracts/') && path.endsWith('/fulfill'))
        return 'commerceServiceFulfillment';
    if (path.startsWith('/v1/commerce/services/contracts/') && path.endsWith('/cancel'))
        return 'commerceServiceDecision';
    if (path.startsWith('/v1/commerce/services/'))
        return 'empty';
    if (path.startsWith('/v1/commerce/products/') && path.endsWith('/capacity-listing'))
        return method === 'get' ? 'empty' : 'commerceCapacityListing';
    if (path.startsWith('/v1/commerce/capacity-listings/') && path.endsWith('/inquiries'))
        return 'commerceCapacityInquiry';
    if (path.startsWith('/v1/commerce/capacity-listings/') && (path.endsWith('/submit') || path.endsWith('/approve') || path.endsWith('/reject') || path.endsWith('/suspend') || path.endsWith('/archive')))
        return 'commerceCapacityListingDecision';
    if (path.startsWith('/v1/commerce/capacity-listings/'))
        return method === 'patch' ? 'commerceCapacityListingUpdate' : 'empty';
    if (path.startsWith('/v1/commerce/capacity-listing-inquiries/') && (path.endsWith('/review') || path.endsWith('/approve-for-scoping') || path.endsWith('/decline') || path.endsWith('/cancel')))
        return 'commerceCapacityInquiryDecision';
    if (path.startsWith('/v1/commerce/capacity-listing-inquiries'))
        return 'empty';
    if (path.startsWith('/v1/commerce/orders/') && path.endsWith('/refunds'))
        return method === 'get' ? 'empty' : 'commerceRefund';
    if (path.startsWith('/v1/commerce/order-items/') && path.endsWith('/fulfillment/artifact'))
        return 'commerceFulfillment';
    if (path.startsWith('/v1/commerce/entitlements/') && path.endsWith('/revoke'))
        return 'commerceTransition';
    if (path === '/v1/commerce/cart')
        return 'commerceCart';
    if (path.startsWith('/v1/commerce/cart/') && path.endsWith('/items'))
        return 'commerceCartItem';
    if (path.startsWith('/v1/commerce/cart/') && path.includes('/items/'))
        return 'empty';
    if (path === '/v1/commerce/checkout')
        return 'commerceCheckout';
    if (path.startsWith('/v1/commerce/payment-groups/') && path.endsWith('/refresh'))
        return 'empty';
    if (path === '/v1/commerce/webhooks/stripe')
        return 'empty';
    if (path === '/v1/commerce/products')
        return 'commerceProductDraft';
    if (path.startsWith('/v1/commerce/products/') && path.endsWith('/ownership'))
        return 'commerceOwnership';
    if (path.startsWith('/v1/commerce/products/') && path.includes('/ownership/'))
        return 'commerceOwnershipUpdate';
    if (path.startsWith('/v1/commerce/products/') && path.endsWith('/stewards'))
        return 'commerceSteward';
    if (path.startsWith('/v1/commerce/products/') && path.includes('/stewards/') && path.endsWith('/end'))
        return 'commerceStewardEnd';
    if (path.startsWith('/v1/commerce/products/') && path.includes('/stewards/'))
        return 'commerceStewardUpdate';
    if (path.startsWith('/v1/commerce/products/') && path.endsWith('/contributions'))
        return 'commerceContribution';
    if (path.startsWith('/v1/commerce/products/') && path.includes('/contributions/'))
        return 'commerceContributionUpdate';
    if (path.startsWith('/v1/commerce/products/') && path.endsWith('/governance-policy'))
        return 'commerceGovernancePolicy';
    if (path.startsWith('/v1/commerce/products/') && path.includes('/governance-policy/'))
        return 'commerceGovernancePolicyUpdate';
    if (path.startsWith('/v1/commerce/products/') && path.includes('/ownership-transfer/') && (path.endsWith('/submit') || path.endsWith('/approve') || path.endsWith('/reject') || path.endsWith('/cancel')))
        return 'commerceOwnershipTransferDecision';
    if (path.startsWith('/v1/commerce/products/') && path.endsWith('/ownership-transfer'))
        return 'commerceOwnershipTransfer';
    if (path.startsWith('/v1/commerce/products/') && path.endsWith('/succession-events'))
        return method === 'get' ? 'empty' : 'commerceSuccessionEvent';
    if (path.startsWith('/v1/commerce/products/') && path.endsWith('/versions'))
        return 'commerceProductVersion';
    if (path.startsWith('/v1/commerce/products/') && path.endsWith('/submit'))
        return 'commerceTransition';
    if (path.startsWith('/v1/commerce/products/') && path.endsWith('/approve'))
        return 'commerceTransition';
    if (path.startsWith('/v1/commerce/products/') && path.includes('/versions/') && path.endsWith('/submit'))
        return 'commerceTransition';
    if (path.startsWith('/v1/commerce/products/') && path.includes('/versions/') && path.endsWith('/approve'))
        return 'commerceTransition';
    if (path === '/v1/commerce/offers')
        return 'commerceOffer';
    if (path.startsWith('/v1/commerce/offers/') && path.endsWith('/prices'))
        return 'commercePrice';
    if (path.startsWith('/v1/commerce/offers/') && path.endsWith('/submit'))
        return 'commerceTransition';
    if (path.startsWith('/v1/commerce/offers/') && path.endsWith('/approve'))
        return 'commerceTransition';
    if (path.startsWith('/v1/commerce/offers/') && path.endsWith('/stripe/reconcile'))
        return 'empty';
    if (path.startsWith('/v1/commerce/prices/') && path.endsWith('/stripe/reconcile'))
        return 'empty';
    if (path.startsWith('/v1/commerce/offers/'))
        return 'commerceOffer';
    if (path.startsWith('/v1/commerce/prices/') && path.endsWith('/activate'))
        return 'commerceTransition';
    if (path.startsWith('/v1/project-deployments/'))
        return 'projectDeployment';
    if (path.startsWith('/v1/projects/:projectId/secrets/github-actions/deploy'))
        return 'githubActionsSecretDeploy';
    if (path.startsWith('/v1/projects/:projectId/workflow-operations/') && path.endsWith('/dispatch'))
        return 'workflowOperationDispatch';
    if (path.startsWith('/v1/projects/:projectId/repositories/') && path.endsWith('/initialize'))
        return 'empty';
    if (path.startsWith('/v1/projects/:projectId'))
        return path.endsWith('/local-content/:collection') ? 'localContentWrite'
            : path.endsWith('/related') ? 'localContentRelated'
                : path.endsWith('/decisions/from-proposals') ? 'decisionFromProposals'
                    : path.includes('/approval') ? 'approvalDecision'
                        : path.includes('/agent-classes') ? 'projectAgentClass'
                            : path.includes('/runner/') ? 'runnerProjectBody'
                                : path.includes('/deployments') ? 'projectDeployment'
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
