import { sql } from 'drizzle-orm'
import { db } from './client.ts'

const TRIGGER_DEFINITIONS: Array<{ name: string; create: string }> = [
	{
		name: 'UserOrganization_organizationRole_same_organization_insert',
		create: `CREATE TRIGGER \`UserOrganization_organizationRole_same_organization_insert\`
BEFORE INSERT ON \`UserOrganization\`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM \`OrganizationRole\`
	WHERE \`id\` = NEW.\`organizationRoleId\`
		AND \`organizationId\` IS NOT NULL
		AND \`organizationId\` <> NEW.\`organizationId\`
)
BEGIN
	SELECT RAISE(ABORT, 'Organization role belongs to a different organization');
END`,
	},
	{
		name: 'UserOrganization_organizationRole_same_organization_update',
		create: `CREATE TRIGGER \`UserOrganization_organizationRole_same_organization_update\`
BEFORE UPDATE OF \`organizationRoleId\`, \`organizationId\` ON \`UserOrganization\`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM \`OrganizationRole\`
	WHERE \`id\` = NEW.\`organizationRoleId\`
		AND \`organizationId\` IS NOT NULL
		AND \`organizationId\` <> NEW.\`organizationId\`
)
BEGIN
	SELECT RAISE(ABORT, 'Organization role belongs to a different organization');
END`,
	},
	{
		name: 'OrganizationInvitation_organizationRole_same_organization_insert',
		create: `CREATE TRIGGER \`OrganizationInvitation_organizationRole_same_organization_insert\`
BEFORE INSERT ON \`OrganizationInvitation\`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM \`OrganizationRole\`
	WHERE \`id\` = NEW.\`organizationRoleId\`
		AND \`organizationId\` IS NOT NULL
		AND \`organizationId\` <> NEW.\`organizationId\`
)
BEGIN
	SELECT RAISE(ABORT, 'Organization role belongs to a different organization');
END`,
	},
	{
		name: 'OrganizationInvitation_organizationRole_same_organization_update',
		create: `CREATE TRIGGER \`OrganizationInvitation_organizationRole_same_organization_update\`
BEFORE UPDATE OF \`organizationRoleId\`, \`organizationId\` ON \`OrganizationInvitation\`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM \`OrganizationRole\`
	WHERE \`id\` = NEW.\`organizationRoleId\`
		AND \`organizationId\` IS NOT NULL
		AND \`organizationId\` <> NEW.\`organizationId\`
)
BEGIN
	SELECT RAISE(ABORT, 'Organization role belongs to a different organization');
END`,
	},
	{
		name: 'OrganizationInviteLink_organizationRole_same_organization_insert',
		create: `CREATE TRIGGER \`OrganizationInviteLink_organizationRole_same_organization_insert\`
BEFORE INSERT ON \`OrganizationInviteLink\`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM \`OrganizationRole\`
	WHERE \`id\` = NEW.\`organizationRoleId\`
		AND \`organizationId\` IS NOT NULL
		AND \`organizationId\` <> NEW.\`organizationId\`
)
BEGIN
	SELECT RAISE(ABORT, 'Organization role belongs to a different organization');
END`,
	},
	{
		name: 'OrganizationInviteLink_organizationRole_same_organization_update',
		create: `CREATE TRIGGER \`OrganizationInviteLink_organizationRole_same_organization_update\`
BEFORE UPDATE OF \`organizationRoleId\`, \`organizationId\` ON \`OrganizationInviteLink\`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM \`OrganizationRole\`
	WHERE \`id\` = NEW.\`organizationRoleId\`
		AND \`organizationId\` IS NOT NULL
		AND \`organizationId\` <> NEW.\`organizationId\`
)
BEGIN
	SELECT RAISE(ABORT, 'Organization role belongs to a different organization');
END`,
	},
]

/** Reapply org-role assignment triggers (table recreation migrations can drop them). */
export async function ensureOrganizationRoleAssignmentTriggers() {
	await db.transaction(async (tx) => {
		for (const { name, create } of TRIGGER_DEFINITIONS) {
			await tx.run(sql.raw(`DROP TRIGGER IF EXISTS \`${name}\``))
			await tx.run(sql.raw(create))
		}
	})
}
