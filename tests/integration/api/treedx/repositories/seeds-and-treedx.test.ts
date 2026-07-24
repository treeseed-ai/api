// Import-only collector groups API scenarios by bounded context.
import '../../accounts/owns-web-auth-lifecycle-and-acceptance-session-seeding-in-the-api.scenarios.ts';
import '../../governance/commons/supports-commons-governance-participation.scenarios.ts';
import '../../capacity/providers/lists-generic-hosts-with-managed-web-and-capacity-provider-host-records.scenarios.ts';
import '../../capacity/providers/marks-managed-hosts-active-from-existing-platform-provider-env-vars.scenarios.ts';
import '../../hosting/launch-with-managed-cloudflare-host-records-paid-hosting-metadata.scenarios.ts';
import '../../hosting/launch-with-managed-cloudflare-host-fails-when-operational-credentials-are-missing.scenarios.ts';
import '../../operations/creates-platform-operations-and-lets-the-operations-runner-claim-and-complete-them.scenarios.ts';
import '../../accounts/lets-the-operations-runner-complete-a-queued-noop-operation-through-api-service-auth.scenarios.ts';
import '../../seeds/plans-and-applies-staging-seeds-with-audit-records-then-reports-unchanged.scenarios.ts';
import '../../commerce/catalog/gates-production-seed-apply-on-matching-approved-requests.scenarios.ts';
import './provisions-one-active-team-treedx-binding-and-exposes-mirrors-and-shares.scenarios.ts';
import '../federation/queues-public-federation-provisioning-instead-of-treating-it-as-a-metadata-only-attachment.scenarios.ts';
import './lets-trusted-deploy-services-bootstrap-the-default-public-treedx-federation-team.scenarios.ts';
import '../../projects/knowledge/runs-treedx-provisioning-through-railway-project-service-volume-variable-domain-and-deploy-adapters.scenarios.ts';
import '../../projects/knowledge/does-not-proxy-normal-treedx-project-calls-with-static-admin-tokens-or-implicit-local-secrets.scenarios.ts';
import '../../projects/knowledge/mints-scoped-issued-treedx-tokens-for-normal-project-proxy-calls.scenarios.ts';
import './automatically-provisions-private-treedx-and-central-public-mirror-trust-for-private-teams.scenarios.ts';
