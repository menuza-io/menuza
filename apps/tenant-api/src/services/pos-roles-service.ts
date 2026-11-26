import { and, eq, sql } from 'drizzle-orm'
import {
	BUILTIN_CASHIER_ROLE_ID,
	BUILTIN_MANAGER_ROLE_ID,
	CASHIER_PERMISSIONS,
	MANAGER_PERMISSIONS,
	ROLE_REVIEW_REASON,
	normalizeRolePermissions,
	refusedSaleAction,
	type PosPermission,
} from '@repo/common/pos-roles'
import { type PosOrderRequest } from '@repo/common/pos-orders'
import {
	posDevices,
	posManagers,
	posRoles,
	staffAuditLog,
	staffMembers,
	type PosDevice,
	type TenantDatabase,
} from '@repo/tenant-db'
import { type PosReview } from './pos-service.ts'

const BUILT_IN = [
	{
		id: BUILTIN_CASHIER_ROLE_ID,
		name: 'Cashier',
		permissions: CASHIER_PERMISSIONS,
	},
	{
		id: BUILTIN_MANAGER_ROLE_ID,
		name: 'Manager',
		permissions: MANAGER_PERMISSIONS,
	},
] as const

export async function ensureBuiltInRoles(
	db: TenantDatabase,
	now = Date.now(),
) {
	for (const role of BUILT_IN) {
		await db
			.insert(posRoles)
			.values({
				id: role.id,
				name: role.name,
				builtIn: true,
				permissions: JSON.stringify(role.permissions),
				createdBy: 'system',
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing()
	}
}

function parsePermissions(raw: string): PosPermission[] {
	try {
		const value = JSON.parse(raw) as unknown
		if (!Array.isArray(value)) return []
		return normalizeRolePermissions(value.filter((k) => typeof k === 'string'))
	} catch {
		return []
	}
}

export async function listRoles(db: TenantDatabase) {
	await ensureBuiltInRoles(db)
	const rows = await db.select().from(posRoles).orderBy(posRoles.createdAt)
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		builtIn: row.builtIn,
		permissions: parsePermissions(row.permissions),
	}))
}

async function audit(
	db: TenantDatabase,
	operatorId: string,
	action: string,
	roleId: string,
	changes: Record<string, unknown>,
) {
	await db.insert(staffAuditLog).values({
		actorKind: 'operator',
		actorId: operatorId,
		impersonated: false,
		action,
		entityType: 'pos_role',
		entityId: roleId,
		sensitivity: 'standard',
		changes,
		ipHash: null,
	})
}

export async function createRole(
	db: TenantDatabase,
	input: { name: string; permissions: readonly string[]; createdBy: string },
) {
	await ensureBuiltInRoles(db)
	const name = input.name.trim()
	if (!name || name.length > 40) return { ok: false as const, error: 'invalid_name' }
	const permissions = normalizeRolePermissions(input.permissions)
	const id = crypto.randomUUID()
	try {
		await db.insert(posRoles).values({
			id,
			name,
			builtIn: false,
			permissions: JSON.stringify(permissions),
			createdBy: input.createdBy,
		})
	} catch (error) {
		if (error instanceof Error && /UNIQUE/i.test(error.message)) {
			return { ok: false as const, error: 'name_taken' }
		}
		throw error
	}
	await audit(db, input.createdBy, 'pos.role.created', id, {
		name,
		permissions,
	})
	return { ok: true as const, id, permissions }
}

export async function updateRole(
	db: TenantDatabase,
	input: {
		id: string
		name: string
		permissions: readonly string[]
		updatedBy: string
	},
) {
	const [row] = await db
		.select()
		.from(posRoles)
		.where(eq(posRoles.id, input.id))
		.limit(1)
	if (!row) return { ok: false as const, error: 'not_found' }
	const name = input.name.trim()
	if (!name || name.length > 40) return { ok: false as const, error: 'invalid_name' }
	const permissions = row.builtIn
		? parsePermissions(row.permissions)
		: normalizeRolePermissions(input.permissions)
	const nextName = row.builtIn ? row.name : name
	await db
		.update(posRoles)
		.set({
			name: nextName,
			permissions: JSON.stringify(
				row.builtIn ? parsePermissions(row.permissions) : permissions,
			),
			updatedAt: Date.now(),
		})
		.where(eq(posRoles.id, row.id))
	await audit(db, input.updatedBy, 'pos.role.updated', row.id, {
		name: nextName,
		permissions: row.builtIn ? parsePermissions(row.permissions) : permissions,
	})
	return { ok: true as const }
}

export async function deleteRole(
	db: TenantDatabase,
	input: { id: string; deletedBy: string },
) {
	const [row] = await db
		.select()
		.from(posRoles)
		.where(eq(posRoles.id, input.id))
		.limit(1)
	if (!row) return { ok: false as const, error: 'not_found' }
	if (row.builtIn) return { ok: false as const, error: 'built_in' }
	const [used] = await db
		.select({ n: sql<number>`count(*)` })
		.from(staffMembers)
		.where(eq(staffMembers.posRoleId, row.id))
	if (Number(used?.n ?? 0) > 0) return { ok: false as const, error: 'in_use' }
	await db.delete(posRoles).where(eq(posRoles.id, row.id))
	await audit(db, input.deletedBy, 'pos.role.deleted', row.id, { name: row.name })
	return { ok: true as const }
}

export async function assignStaffRole(
	db: TenantDatabase,
	input: { staffId: string; roleId: string; assignedBy: string },
) {
	await ensureBuiltInRoles(db)
	const [role] = await db
		.select()
		.from(posRoles)
		.where(eq(posRoles.id, input.roleId))
		.limit(1)
	if (!role) return { ok: false as const, error: 'not_found' }
	const [staff] = await db
		.select({ id: staffMembers.id })
		.from(staffMembers)
		.where(eq(staffMembers.id, input.staffId))
		.limit(1)
	if (!staff) return { ok: false as const, error: 'not_found' }
	await db
		.update(staffMembers)
		.set({ posRoleId: role.id, updatedAt: Date.now() })
		.where(eq(staffMembers.id, staff.id))
	if (role.id === BUILTIN_MANAGER_ROLE_ID) {
		await db
			.insert(posManagers)
			.values({ staffId: staff.id, addedBy: input.assignedBy })
			.onConflictDoNothing()
	} else {
		await db.delete(posManagers).where(eq(posManagers.staffId, staff.id))
	}
	await audit(db, input.assignedBy, 'pos.role.assigned', role.id, {
		staffId: staff.id,
	})
	return { ok: true as const }
}

export async function permissionsForStaff(
	db: TenantDatabase,
	staffId: string | null,
): Promise<PosPermission[] | null> {
	if (!staffId) return null
	await ensureBuiltInRoles(db)
	const [member] = await db
		.select({ posRoleId: staffMembers.posRoleId })
		.from(staffMembers)
		.where(eq(staffMembers.id, staffId))
		.limit(1)
	if (!member) return null
	if (member.posRoleId) {
		const [role] = await db
			.select()
			.from(posRoles)
			.where(eq(posRoles.id, member.posRoleId))
			.limit(1)
		if (role) return parsePermissions(role.permissions)
	}
	const [manager] = await db
		.select({ id: posManagers.staffId })
		.from(posManagers)
		.where(eq(posManagers.staffId, staffId))
		.limit(1)
	return manager ? [...MANAGER_PERMISSIONS] : [...CASHIER_PERMISSIONS]
}

export function parseTerminalAllow(raw: string | null): string[] | null {
	if (!raw) return null
	try {
		const value = JSON.parse(raw) as unknown
		if (!Array.isArray(value)) return null
		return value.filter((key) => typeof key === 'string')
	} catch {
		return null
	}
}

/**
 * Flags a sale whose user could not do one of its actions. The sale is kept.
 */
export async function withRoleCheck(
	db: TenantDatabase,
	device: Pick<PosDevice, 'permissionAllow' | 'signInRequired'>,
	order: PosOrderRequest,
	review: PosReview,
): Promise<PosReview> {
	if (review.reviewReason) return review
	const terminalAllow = parseTerminalAllow(device.permissionAllow)
	const staffId = order.staff?.id ?? null
	const staffPermissions = await permissionsForStaff(db, staffId)
	const approverIds = new Set<string>()
	if (order.voidApprovedBy?.id) approverIds.add(order.voidApprovedBy.id)
	for (const refund of order.refunds) {
		if (refund.approvedBy?.id) approverIds.add(refund.approvedBy.id)
	}
	for (const line of order.lineVoids) {
		if (line.approvedBy?.id) approverIds.add(line.approvedBy.id)
	}
	for (const discount of order.discountApplications) {
		if (discount.approvedByStaffId) approverIds.add(discount.approvedByStaffId)
	}
	const approverPermissions = new Map<string, readonly string[]>()
	for (const id of approverIds) {
		const perms = await permissionsForStaff(db, id)
		if (perms) approverPermissions.set(id, perms)
	}
	const refused = refusedSaleAction({
		order,
		signInRequired: device.signInRequired,
		staffPermissions,
		approverPermissions,
		terminalAllow,
	})
	if (!refused) return review
	return { ...review, reviewReason: ROLE_REVIEW_REASON }
}

export async function setTerminalPermissions(
	db: TenantDatabase,
	input: { deviceId: string; allow: readonly string[] | null; updatedBy: string },
) {
	const allow =
		input.allow === null ? null : JSON.stringify(normalizeRolePermissions(input.allow))
	const [updated] = await db
		.update(posDevices)
		.set({ permissionAllow: allow })
		.where(and(eq(posDevices.id, input.deviceId)))
		.returning({ id: posDevices.id })
	if (!updated) return { ok: false as const, error: 'not_found' }
	await audit(db, input.updatedBy, 'pos.terminal.permissions', input.deviceId, {
		allow: allow === null ? null : JSON.parse(allow),
	})
	return { ok: true as const }
}
