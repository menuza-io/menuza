import {
	and,
	db,
	eq,
	isNull,
	or,
	OrganizationRole,
	sql,
	_OrganizationPermissionToRole,
} from '@repo/database'
import {
	getReservationsRolePreset,
	presetPermissionIds,
	type ReservationsRolePresetKey,
	RESERVATIONS_ROLE_PRESETS,
} from './role-presets.ts'

/**
 * Creates reservations role presets as ordinary tenant-owned custom roles.
 * Callers must already have checked that the user is a built-in admin and that
 * the Reservations module is on.
 */

const normalize = (name: string) => name.trim().toLowerCase()

async function takenNames(organizationId: string): Promise<Set<string>> {
	const rows = await db
		.select({ name: OrganizationRole.name })
		.from(OrganizationRole)
		.where(
			or(
				isNull(OrganizationRole.organizationId),
				eq(OrganizationRole.organizationId, organizationId),
			),
		)
	return new Set(rows.map((row) => normalize(row.name)))
}

/** Each preset with whether a role of that name already exists. */
export async function listReservationsRolePresets(organizationId: string) {
	const taken = await takenNames(organizationId)
	return RESERVATIONS_ROLE_PRESETS.map((preset) => ({
		key: preset.key,
		name: preset.name,
		description: preset.description,
		exists: taken.has(normalize(preset.name)),
	}))
}

export type CreateReservationsPresetResult =
	| { ok: true; roleId: string; name: string; permissionIds: string[] }
	| { ok: false; reason: 'exists' }

/**
 * Creates the preset's role with its permission grants in one transaction.
 * A role (custom or built-in) that already has the preset's name is left
 * alone: a preset never overwrites an admin's edits.
 */
export async function createReservationsRolePreset(
	organizationId: string,
	key: ReservationsRolePresetKey,
): Promise<CreateReservationsPresetResult> {
	const preset = getReservationsRolePreset(key)
	const permissionIds = presetPermissionIds(preset)

	try {
		return await db.transaction(async (tx) => {
			const [duplicate] = await tx
				.select({ id: OrganizationRole.id })
				.from(OrganizationRole)
				.where(
					and(
						or(
							isNull(OrganizationRole.organizationId),
							eq(OrganizationRole.organizationId, organizationId),
						),
						sql`lower(${OrganizationRole.name}) = lower(${preset.name})`,
					),
				)
				.limit(1)
			if (duplicate) return { ok: false as const, reason: 'exists' as const }

			const [role] = await tx
				.insert(OrganizationRole)
				.values({
					name: preset.name,
					description: preset.description,
					level: 0,
					organizationId,
				})
				.returning({ id: OrganizationRole.id })
			if (!role) throw new Error('Role insert returned no row')

			await tx.insert(_OrganizationPermissionToRole).values(
				permissionIds.map((permissionId) => ({
					A: role.id,
					B: permissionId,
				})),
			)
			return {
				ok: true as const,
				roleId: role.id,
				name: preset.name,
				permissionIds,
			}
		})
	} catch (error) {
		if (error instanceof Error && /unique/i.test(error.message)) {
			return { ok: false, reason: 'exists' }
		}
		throw error
	}
}
