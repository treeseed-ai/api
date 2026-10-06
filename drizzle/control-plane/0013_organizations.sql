-- Additive organization foundation. Existing teams remain independent.
-- No credential, provider identity, team role or service record is changed.
CREATE TABLE organizations (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_memberships (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE organization_teams (
  team_id text PRIMARY KEY REFERENCES teams(id) ON DELETE RESTRICT,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  attached_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_organization_teams_organization ON organization_teams(organization_id);

CREATE TABLE organization_team_invitations (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  team_id text NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
  organization_authorized_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  team_authorized_by text REFERENCES users(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','accepted','rejected','revoked','expired')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'accepted' OR team_authorized_by IS NOT NULL)
);
CREATE UNIQUE INDEX idx_organization_team_invitation_pending
  ON organization_team_invitations(organization_id,team_id) WHERE status = 'pending';
