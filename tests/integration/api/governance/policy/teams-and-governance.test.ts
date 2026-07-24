// Import-only collector groups API scenarios by bounded context.
import '../../projects/governance/creates-accepted-governance-decisions-from-project-proposals-through-admin-approval.scenarios.ts';
import '../../teams/manages-team-profiles-invites-member-roles-and-guarded-deletion.scenarios.ts';
import '../../projects/governance/allows-project-leads-to-manage-team-settings-while-hiding-controls-from-contributors.scenarios.ts';
import '../../projects/deletion/blocks-team-deletion-while-the-team-owns-projects.scenarios.ts';
import './enforces-deployment-governance-and-audit-redaction-boundaries.scenarios.ts';
