-- Breaking custody cutover. Historical migration files are immutable; no legacy reader is retained.
-- Credentials must be entered into core OpenBao. Existing browser envelopes are intentionally discarded.
DROP TABLE IF EXISTS service_operation_leases;
DROP TABLE IF EXISTS team_service_credential_envelopes;
DROP TABLE IF EXISTS team_service_vault_grants;
DROP TABLE IF EXISTS team_service_vaults;
DROP TABLE IF EXISTS user_service_vault_keys;
DELETE FROM provider_credential_authorities WHERE scheme NOT IN ('openbao', 'app-installation');
UPDATE provider_credential_authorities SET status = 'revoked'
WHERE scheme = 'openbao';
UPDATE team_service_credential_profiles SET custody_mode = CASE
  WHEN definition_id IN ('github-repository-app', 'github-workflow-app') THEN 'app-installation'
  ELSE 'openbao' END, status = 'pending';
