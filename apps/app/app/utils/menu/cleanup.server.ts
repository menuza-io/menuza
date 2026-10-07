import {
	and,
	db,
	eq,
	OrganizationMenuLocationOverride,
	OrganizationMenuPosLink,
} from '@repo/database'

export type MenuEntityType =
	'menu' | 'category' | 'item' | 'modifier_group' | 'modifier_option'

type CleanupClient = Pick<typeof db, 'delete'>

/**
 * Location overrides use a polymorphic (entityType, entityId) pair with no FK,
 * and POS links keep a bare localId, so hard-deleting a menu entity otherwise
 * leaves dangling rows behind. Call this inside the same transaction as the
 * entity delete so the cleanup is atomic with it.
 */
export async function deleteMenuEntityReferences(
	organizationId: string,
	entityType: MenuEntityType,
	entityId: string,
	client: CleanupClient = db,
) {
	await client
		.delete(OrganizationMenuLocationOverride)
		.where(
			and(
				eq(OrganizationMenuLocationOverride.organizationId, organizationId),
				eq(OrganizationMenuLocationOverride.entityType, entityType),
				eq(OrganizationMenuLocationOverride.entityId, entityId),
			),
		)

	await client
		.delete(OrganizationMenuPosLink)
		.where(
			and(
				eq(OrganizationMenuPosLink.organizationId, organizationId),
				eq(OrganizationMenuPosLink.entityType, entityType),
				eq(OrganizationMenuPosLink.localId, entityId),
			),
		)
}
