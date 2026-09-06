import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {acceptOrganizationTeamInvitation, type OrganizationDatabase} from '../../../../src/api/control-plane/repositories/services/organization-attachment.ts';

describe('organization migration on isolated PostgreSQL',()=>{
  it('requires current authority on both sides and commits attachment atomically',async()=>{
    const db=new PGlite();
    try {
      await db.exec(`CREATE TABLE teams(id text PRIMARY KEY); CREATE TABLE users(id text PRIMARY KEY);
        INSERT INTO teams VALUES ('team'); INSERT INTO users VALUES ('owner'),('admin'),('outsider');
        CREATE TABLE roles(id text PRIMARY KEY,key text); INSERT INTO roles VALUES ('role','team_owner');
        CREATE TABLE team_memberships(id text PRIMARY KEY,team_id text,user_id text,status text);
        INSERT INTO team_memberships VALUES ('membership','team','owner','active');
        CREATE TABLE team_role_bindings(team_membership_id text,role_id text);
        INSERT INTO team_role_bindings VALUES ('membership','role');`);
      await db.exec(readFileSync('drizzle/control-plane/0013_organizations.sql','utf8'));
      await db.exec(`INSERT INTO organizations(id,name) VALUES ('org','Organization');
        INSERT INTO organization_memberships(organization_id,user_id,role) VALUES ('org','admin','admin');
        INSERT INTO organization_team_invitations(id,organization_id,team_id,organization_authorized_by,expires_at,status)
        VALUES ('invitation','org','team','admin',now()+interval '1 hour','pending');`);
      await expect(acceptOrganizationTeamInvitation(db,'outsider','invitation',1)).rejects.toThrow('team_owner_required');
      await db.exec("UPDATE organization_memberships SET role='member'");
      await expect(acceptOrganizationTeamInvitation(db,'owner','invitation',1)).rejects.toThrow('organization_authority_revoked');
      expect((await db.query('SELECT * FROM organization_teams')).rows).toEqual([]);
      await db.exec("UPDATE organization_memberships SET role='admin'");
      const failingDatabase: OrganizationDatabase = {transaction: run => db.transaction(async tx => {
        await run(tx);
        throw new Error('injected_commit_failure');
      })};
      await expect(acceptOrganizationTeamInvitation(failingDatabase,'owner','invitation',1)).rejects.toThrow('injected_commit_failure');
      expect((await db.query('SELECT * FROM organization_teams')).rows).toEqual([]);
      expect((await db.query('SELECT status,version FROM organization_team_invitations')).rows).toEqual([{status:'pending',version:1}]);
      expect(await acceptOrganizationTeamInvitation(db,'owner','invitation',1)).toMatchObject({teamId:'team',organizationId:'org',version:2});
      await expect(acceptOrganizationTeamInvitation(db,'owner','invitation',1)).rejects.toThrow('version_conflict');
      expect((await db.query('SELECT user_id FROM team_memberships')).rows).toEqual([{user_id:'owner'}]);
    } finally {await db.close();}
  },15000);
  it('preserves existing teams and enforces membership and invitation constraints',async()=>{
    const db=new PGlite();
    try {
      await db.exec("CREATE TABLE teams(id text PRIMARY KEY); CREATE TABLE users(id text PRIMARY KEY); INSERT INTO teams VALUES ('team'); INSERT INTO users VALUES ('owner');");
      await db.exec(readFileSync('drizzle/control-plane/0013_organizations.sql','utf8'));
      expect((await db.query('SELECT * FROM teams')).rows).toEqual([{id:'team'}]);
      expect((await db.query('SELECT * FROM organization_teams')).rows).toEqual([]);
      await db.exec("INSERT INTO organizations(id,name) VALUES ('a','A'),('b','B'); INSERT INTO organization_teams(team_id,organization_id) VALUES ('team','a');");
      await expect(db.exec("INSERT INTO organization_teams(team_id,organization_id) VALUES ('team','b')")).rejects.toThrow();
      await expect(db.exec("INSERT INTO organization_memberships(organization_id,user_id,role) VALUES ('a','owner','superuser')")).rejects.toThrow();
      await expect(db.exec("INSERT INTO organization_team_invitations(id,organization_id,team_id,organization_authorized_by,expires_at,status) VALUES ('invite','a','team','owner',now()+interval '1 hour','accepted')")).rejects.toThrow();
      await expect(db.exec("DELETE FROM organizations WHERE id='a'")).rejects.toThrow();
    } finally {await db.close();}
  },15000);
});
