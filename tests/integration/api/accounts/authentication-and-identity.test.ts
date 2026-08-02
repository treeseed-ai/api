// Import-only collector groups API scenarios by bounded context.
import '../capacity/workdays/rejects-unauthenticated-workday-run-mutation-without-local-acceptance-auth.scenarios.ts';
import '../capacity/workdays/allows-local-acceptance-admin-token-to-manage-workday-runs-in-local-mode.scenarios.ts';
import '../support/redirects-legacy-v1-browser-approval-links-to-the-web-approval-page.scenarios.ts';
import '../teams/keeps-public-usernames-and-team-slugs-in-one-namespace.scenarios.ts';
import '../teams/supports-multiple-verified-account-emails-for-login-primary-selection-deletion-reset-and-invite-lookup.scenarios.ts';
import './exposes-market-owned-v1-auth-market-registry-access-and-artifact-download-contracts.scenarios.ts';
import './persists-exact-notification-preferences-and-personal-themes-without-activating-creation.scenarios.ts';
