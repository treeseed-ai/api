-- Additive metadata only. No secrets are copied, read, or rewritten.
CREATE TABLE vault_registrations (
  id text PRIMARY KEY,
  owner_team_id text REFERENCES teams(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
  backend text NOT NULL CHECK (backend IN ('managed-openbao','external-openbao','hashicorp-vault')),
  endpoint text NOT NULL CHECK (endpoint ~ '^https://[^/@?#[:space:]]+/?$'),
  secrets_mount text NOT NULL CHECK (secrets_mount ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*(/[A-Za-z0-9][A-Za-z0-9_.-]*)*$'),
  namespace text CHECK (namespace ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*(/[A-Za-z0-9][A-Za-z0-9_.-]*)*$'),
  network_route_id text NOT NULL,
  tls_trust_id text NOT NULL,
  auth_mount text NOT NULL,
  role_id text NOT NULL,
  bootstrap_credential_ref text NOT NULL,
  status text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','ready','unavailable','revoked')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- The resolver must also use Deployment's verified backend identity to detect endpoint aliases.
CREATE UNIQUE INDEX idx_vault_registered_location
  ON vault_registrations (lower(rtrim(endpoint,'/')),secrets_mount,coalesce(namespace,''));

CREATE TABLE vault_allocations (
  id text PRIMARY KEY,
  vault_id text NOT NULL REFERENCES vault_registrations(id) ON DELETE RESTRICT,
  team_id text NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  path_prefix text NOT NULL CHECK (length(path_prefix) <= 512 AND path_prefix ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*(/[A-Za-z0-9][A-Za-z0-9_.-]*)*$'),
  permissions text[] NOT NULL CHECK (cardinality(permissions) > 0 AND permissions <@ ARRAY['read','write','delete']::text[]),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (id,vault_id,team_id),
  UNIQUE (vault_id,path_prefix)
);

-- Serialize allocation changes per vault. Both exact and ancestor/descendant
-- collisions are rejected, even when the allocations belong to the same team.
CREATE FUNCTION enforce_vault_allocation_isolation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.vault_id <> OLD.vault_id OR NEW.team_id <> OLD.team_id OR NEW.path_prefix <> OLD.path_prefix) THEN
    RAISE EXCEPTION 'vault_allocation_relocation_requires_migration';
  END IF;
  -- A row write also forces stale REPEATABLE READ snapshots to serialize/fail;
  -- a lock-only read would not invalidate such a snapshot. Public version stays unchanged.
  UPDATE vault_registrations SET version=version WHERE id=NEW.vault_id;
  IF EXISTS (SELECT 1 FROM vault_allocations a WHERE a.vault_id=NEW.vault_id AND a.id<>NEW.id AND
    (a.path_prefix=NEW.path_prefix OR left(a.path_prefix,length(NEW.path_prefix)+1)=NEW.path_prefix||'/' OR
      left(NEW.path_prefix,length(a.path_prefix)+1)=a.path_prefix||'/')) THEN
    RAISE EXCEPTION 'vault_allocation_path_overlap';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER vault_allocation_isolation BEFORE INSERT OR UPDATE ON vault_allocations
  FOR EACH ROW EXECUTE FUNCTION enforce_vault_allocation_isolation();

-- One vault/allocation selection per connection. Credential profile references
-- are resolved beneath it; a connection cannot mix vaults per field/profile.
CREATE TABLE service_connection_vault_bindings (
  connection_id text PRIMARY KEY REFERENCES team_service_connections(id) ON DELETE RESTRICT,
  team_id text NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  vault_id text NOT NULL,
  allocation_id text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (connection_id,vault_id,allocation_id),
  FOREIGN KEY (allocation_id,vault_id,team_id) REFERENCES vault_allocations(id,vault_id,team_id) ON DELETE RESTRICT
);
CREATE FUNCTION enforce_connection_vault_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM team_service_connections c WHERE c.id=NEW.connection_id AND c.team_id=NEW.team_id) THEN
    RAISE EXCEPTION 'connection_vault_team_mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connection_vault_owner BEFORE INSERT OR UPDATE ON service_connection_vault_bindings
  FOR EACH ROW EXECUTE FUNCTION enforce_connection_vault_owner();

CREATE TABLE vault_credential_references (
  connection_id text NOT NULL,
  profile_id text NOT NULL,
  vault_id text NOT NULL,
  allocation_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('managed','existing')),
  record_path text NOT NULL CHECK (length(record_path) <= 512 AND record_path ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*(/[A-Za-z0-9][A-Za-z0-9_.-]*)*$'),
  field_mapping jsonb,
  pinned_version bigint CHECK (pinned_version > 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (connection_id,profile_id),
  FOREIGN KEY (connection_id,vault_id,allocation_id)
    REFERENCES service_connection_vault_bindings(connection_id,vault_id,allocation_id)
    DEFERRABLE INITIALLY IMMEDIATE,
  CHECK ((mode='managed' AND field_mapping IS NULL AND pinned_version IS NULL) OR
    (mode='existing' AND field_mapping IS NOT NULL AND jsonb_typeof(field_mapping)='object' AND field_mapping <> '{}'::jsonb))
);
