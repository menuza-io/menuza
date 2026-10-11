import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
	normalizeAssignments,
	parseRosterPaste,
	type StaffingTokenClaims,
	staffingTokenAllowsLocation,
	type StaffMemberInput,
	type StaffingSettings,
} from '@repo/staffing'
import {
	getTenantDb,
	staffAssignments,
	staffEvents,
	staffingSettings,
	staffMembers,
	staffPositions,
	type StaffAssignment,
	type StaffMember,
	type StaffPosition,
} from '@repo/tenant-db'

import { type StaffingAuth } from '../lib/staffing-auth.ts'

type TenantDatabase = Awaited<ReturnType<typeof getTenantDb>>
type Transaction = Parameters<Parameters<TenantDatabase['transaction']>[0]>[0]
type Writer = TenantDatabase | Transaction

export type ServiceResult<T> =
	{ ok: true; data: T } | { ok: false; status: 400 | 404 | 409; code: string }

const failure = (status: 400 | 404 | 409, code: string) =>
	({ ok: false, status, code }) as const

/** Thrown inside a transaction so a late validation failure rolls back. */
export class StaffingAbort extends Error {
	constructor(
		readonly result: { ok: false; status: 400 | 404 | 409; code: string },
	) {
		super(result.code)
	}
}

export async function withAbort<T>(
	run: () => Promise<ServiceResult<T>>,
): Promise<ServiceResult<T>> {
	try {
		return await run()
	} catch (error) {
		if (error instanceof StaffingAbort) return error.result
		throw error
	}
}

export async function recordStaffEvent(
	db: Writer,
	auth: Pick<StaffingAuth, 'actorRef'>,
	kind: string,
	staffId: string | null,
	detail?: Record<string, unknown>,
) {
	await db.insert(staffEvents).values({
		kind,
		staffId,
		actorRef: auth.actorRef,
		detail: detail ?? null,
	})
}

const DEFAULT_SETTINGS: StaffingSettings = {
	weekStart: 'monday',
	weeklyHoursThreshold: 40,
	lateGraceMinutes: 5,
}

export async function readStaffingSettings(
	db: Writer,
): Promise<StaffingSettings> {
	const [row] = await db.select().from(staffingSettings).limit(1)
	if (!row) return DEFAULT_SETTINGS
	return {
		weekStart: row.weekStart,
		weeklyHoursThreshold: row.weeklyHoursThreshold,
		lateGraceMinutes: row.lateGraceMinutes,
	}
}

function serializePosition(position: StaffPosition) {
	return {
		id: position.id,
		name: position.name,
		colorKey: position.colorKey,
		sortOrder: position.sortOrder,
		archived: position.archivedAt !== null,
	}
}

export type StaffView = ReturnType<typeof serializeStaff>

function serializeStaff(
	member: StaffMember & { pinSetAt?: Date | null },
	assignments: StaffAssignment[],
) {
	return {
		id: member.id,
		userId: member.userId,
		firstName: member.firstName,
		lastName: member.lastName,
		email: member.email,
		phone: member.phone,
		status: member.status,
		hiredOn: member.hiredOn,
		terminatedOn: member.terminatedOn,
		terminationReason: member.terminationReason,
		note: member.note,
		hasPin: Boolean(member.pinSetAt),
		assignments: assignments.map((assignment) => ({
			locationId: assignment.locationId,
			positionId: assignment.positionId,
			isPrimary: assignment.isPrimary,
		})),
		createdAt: member.createdAt.toISOString(),
		updatedAt: member.updatedAt.toISOString(),
	}
}

/**
 * A location-scoped token sees staff assigned to one of its locations. Staff
 * without assignments are visible only to organization-wide tokens.
 */
export function staffVisibleTo(
	claims: StaffingTokenClaims,
	assignments: readonly Pick<StaffAssignment, 'locationId'>[],
) {
	if (claims.locationIds === null) return true
	return assignments.some((assignment) =>
		staffingTokenAllowsLocation(claims, assignment.locationId),
	)
}

async function assignmentsByStaff(db: Writer, staffIds: string[]) {
	const map = new Map<string, StaffAssignment[]>()
	if (staffIds.length === 0) return map
	for (let index = 0; index < staffIds.length; index += 500) {
		const rows = await db
			.select()
			.from(staffAssignments)
			.where(
				inArray(staffAssignments.staffId, staffIds.slice(index, index + 500)),
			)
		for (const row of rows) {
			const list = map.get(row.staffId) ?? []
			list.push(row)
			map.set(row.staffId, list)
		}
	}
	return map
}

export async function getRosterContext(orgId: string) {
	const db = await getTenantDb(orgId)
	const [settings, positions] = await Promise.all([
		readStaffingSettings(db),
		db
			.select()
			.from(staffPositions)
			.orderBy(asc(staffPositions.sortOrder), asc(staffPositions.name)),
	])
	return { settings, positions: positions.map(serializePosition) }
}

export async function listStaff(
	orgId: string,
	claims: StaffingTokenClaims,
	options: { status?: 'active' | 'terminated' } = {},
) {
	const db = await getTenantDb(orgId)
	const members = await db
		.select()
		.from(staffMembers)
		.where(options.status ? eq(staffMembers.status, options.status) : undefined)
		.orderBy(asc(staffMembers.firstName), asc(staffMembers.lastName))
	const assignments = await assignmentsByStaff(
		db,
		members.map((member) => member.id),
	)
	return members
		.map((member) => ({
			member,
			assignments: assignments.get(member.id) ?? [],
		}))
		.filter(({ assignments: list }) => staffVisibleTo(claims, list))
		.map(({ member, assignments: list }) => serializeStaff(member, list))
}

export async function loadVisibleStaff(
	db: Writer,
	claims: StaffingTokenClaims,
	staffId: string,
) {
	const [member] = await db
		.select()
		.from(staffMembers)
		.where(eq(staffMembers.id, staffId))
		.limit(1)
	if (!member) return null
	const assignments = await db
		.select()
		.from(staffAssignments)
		.where(eq(staffAssignments.staffId, staffId))
	if (!staffVisibleTo(claims, assignments)) return null
	return { member, assignments }
}

async function validateAssignments(
	db: Writer,
	claims: StaffingTokenClaims,
	input: StaffMemberInput['assignments'],
	existingPositionIds: ReadonlySet<string> = new Set(),
): Promise<ServiceResult<ReturnType<typeof normalizeAssignments>>> {
	const assignments = normalizeAssignments(input)
	for (const assignment of assignments) {
		if (!staffingTokenAllowsLocation(claims, assignment.locationId)) {
			return failure(400, 'unknown_location')
		}
	}
	const positionIds = [...new Set(assignments.map((item) => item.positionId))]
	if (positionIds.length) {
		const positions = await db
			.select()
			.from(staffPositions)
			.where(inArray(staffPositions.id, positionIds))
		const byId = new Map(positions.map((position) => [position.id, position]))
		for (const id of positionIds) {
			const position = byId.get(id)
			if (!position) return failure(400, 'unknown_position')
			if (position.archivedAt && !existingPositionIds.has(id)) {
				return failure(400, 'position_archived')
			}
		}
	}
	return { ok: true, data: assignments }
}

function changedFields(before: StaffMember, input: StaffMemberInput) {
	const fields: string[] = []
	for (const key of [
		'firstName',
		'lastName',
		'email',
		'phone',
		'hiredOn',
		'note',
	] as const) {
		if ((before[key] ?? null) !== (input[key] ?? null)) fields.push(key)
	}
	return fields
}

export async function createStaff(
	orgId: string,
	auth: StaffingAuth,
	input: StaffMemberInput,
): Promise<ServiceResult<StaffView>> {
	const db = await getTenantDb(orgId)
	if (auth.claims.locationIds !== null && input.assignments.length === 0) {
		// Otherwise the new row would be invisible to the scoped manager.
		return failure(400, 'assignment_required')
	}
	return db.transaction(async (tx) => {
		const assignments = await validateAssignments(
			tx,
			auth.claims,
			input.assignments,
		)
		if (!assignments.ok) return assignments
		const [member] = await tx
			.insert(staffMembers)
			.values({
				firstName: input.firstName,
				lastName: input.lastName,
				email: input.email,
				phone: input.phone,
				hiredOn: input.hiredOn,
				note: input.note,
			})
			.returning()
		if (assignments.data.length) {
			await tx
				.insert(staffAssignments)
				.values(
					assignments.data.map((item) => ({ ...item, staffId: member!.id })),
				)
		}
		await recordStaffEvent(tx, auth, 'staff.created', member!.id)
		const saved = await tx
			.select()
			.from(staffAssignments)
			.where(eq(staffAssignments.staffId, member!.id))
		return { ok: true as const, data: serializeStaff(member!, saved) }
	})
}

export async function updateStaff(
	orgId: string,
	auth: StaffingAuth,
	staffId: string,
	input: StaffMemberInput,
): Promise<ServiceResult<StaffView>> {
	const db = await getTenantDb(orgId)
	return db.transaction(async (tx) => {
		const existing = await loadVisibleStaff(tx, auth.claims, staffId)
		if (!existing) return failure(404, 'not_found')
		// Assignments at locations outside a scoped token are preserved.
		const hidden = existing.assignments.filter(
			(item) => !staffingTokenAllowsLocation(auth.claims, item.locationId),
		)
		const assignments = await validateAssignments(
			tx,
			auth.claims,
			input.assignments,
			new Set(existing.assignments.map((item) => item.positionId)),
		)
		if (!assignments.ok) return assignments
		const fields = changedFields(existing.member, input)
		const [member] = await tx
			.update(staffMembers)
			.set({
				firstName: input.firstName,
				lastName: input.lastName,
				email: input.email,
				phone: input.phone,
				hiredOn: input.hiredOn,
				note: input.note,
				updatedAt: new Date(),
			})
			.where(eq(staffMembers.id, staffId))
			.returning()
		await tx
			.delete(staffAssignments)
			.where(eq(staffAssignments.staffId, staffId))
		const next = normalizeAssignments([...hidden, ...assignments.data])
		if (next.length) {
			await tx
				.insert(staffAssignments)
				.values(next.map((item) => ({ ...item, staffId })))
		}
		const assignmentsChanged =
			JSON.stringify(
				existing.assignments
					.map((item) => [item.locationId, item.positionId, item.isPrimary])
					.sort(),
			) !==
			JSON.stringify(
				next
					.map((item) => [item.locationId, item.positionId, item.isPrimary])
					.sort(),
			)
		if (assignmentsChanged) fields.push('assignments')
		if (fields.length) {
			await recordStaffEvent(tx, auth, 'staff.updated', staffId, { fields })
		}
		const saved = await tx
			.select()
			.from(staffAssignments)
			.where(eq(staffAssignments.staffId, staffId))
		return { ok: true as const, data: serializeStaff(member!, saved) }
	})
}

/** Hooks the schedule slice uses to release a terminated person's shifts. */
export type TerminationHook = (
	tx: Transaction,
	staffId: string,
	terminatedOn: string,
) => Promise<number>

const terminationHooks: TerminationHook[] = []
export function onStaffTerminated(hook: TerminationHook) {
	terminationHooks.push(hook)
}

export async function terminateStaff(
	orgId: string,
	auth: StaffingAuth,
	staffId: string,
	input: { terminatedOn: string; reason: string },
): Promise<ServiceResult<StaffView & { releasedShifts: number }>> {
	const db = await getTenantDb(orgId)
	return db.transaction(async (tx) => {
		const existing = await loadVisibleStaff(tx, auth.claims, staffId)
		if (!existing) return failure(404, 'not_found')
		if (existing.member.status === 'terminated') {
			return failure(409, 'already_terminated')
		}
		const [member] = await tx
			.update(staffMembers)
			.set({
				status: 'terminated',
				terminatedOn: input.terminatedOn,
				terminationReason: input.reason || null,
				updatedAt: new Date(),
			})
			.where(eq(staffMembers.id, staffId))
			.returning()
		let releasedShifts = 0
		for (const hook of terminationHooks) {
			releasedShifts += await hook(tx, staffId, input.terminatedOn)
		}
		await recordStaffEvent(tx, auth, 'staff.terminated', staffId, {
			terminatedOn: input.terminatedOn,
			releasedShifts,
		})
		return {
			ok: true as const,
			data: {
				...serializeStaff(member!, existing.assignments),
				releasedShifts,
			},
		}
	})
}

export async function rehireStaff(
	orgId: string,
	auth: StaffingAuth,
	staffId: string,
): Promise<ServiceResult<StaffView>> {
	const db = await getTenantDb(orgId)
	return db.transaction(async (tx) => {
		const existing = await loadVisibleStaff(tx, auth.claims, staffId)
		if (!existing) return failure(404, 'not_found')
		if (existing.member.status === 'active')
			return failure(409, 'already_active')
		const [member] = await tx
			.update(staffMembers)
			.set({
				status: 'active',
				terminatedOn: null,
				terminationReason: null,
				updatedAt: new Date(),
			})
			.where(eq(staffMembers.id, staffId))
			.returning()
		await recordStaffEvent(tx, auth, 'staff.rehired', staffId)
		return {
			ok: true as const,
			data: serializeStaff(member!, existing.assignments),
		}
	})
}

export async function importStaff(
	orgId: string,
	auth: StaffingAuth,
	input: { text: string; locationId: string; createPositions: boolean },
): Promise<
	ServiceResult<{
		created: number
		skippedExisting: number[]
		createdPositions: string[]
	}>
> {
	if (!staffingTokenAllowsLocation(auth.claims, input.locationId)) {
		return failure(400, 'unknown_location')
	}
	const parsed = parseRosterPaste(input.text)
	if (parsed.errors.length) return failure(400, 'invalid_rows')
	if (parsed.rows.length === 0) return failure(400, 'no_rows')
	const db = await getTenantDb(orgId)
	return withAbort(() =>
		db.transaction(async (tx) => {
			const emails = parsed.rows.flatMap((row) =>
				row.email ? [row.email] : [],
			)
			const existingEmails = new Set<string>()
			for (let index = 0; index < emails.length; index += 500) {
				const rows = await tx
					.select({ email: staffMembers.email })
					.from(staffMembers)
					.where(inArray(staffMembers.email, emails.slice(index, index + 500)))
				for (const row of rows) if (row.email) existingEmails.add(row.email)
			}
			const positions = await tx.select().from(staffPositions)
			const byName = new Map(
				positions.map((position) => [position.name.toLowerCase(), position]),
			)
			const createdPositions: string[] = []
			let created = 0
			const skippedExisting: number[] = []
			for (const row of parsed.rows) {
				if (row.email && existingEmails.has(row.email)) {
					skippedExisting.push(row.line)
					continue
				}
				let positionId: string | null = null
				if (row.positionName) {
					let position = byName.get(row.positionName.toLowerCase())
					if (!position) {
						if (!input.createPositions) {
							throw new StaffingAbort(failure(400, 'unknown_position'))
						}
						;[position] = await tx
							.insert(staffPositions)
							.values({ name: row.positionName, sortOrder: byName.size })
							.returning()
						byName.set(row.positionName.toLowerCase(), position!)
						createdPositions.push(position!.name)
					} else if (position.archivedAt) {
						throw new StaffingAbort(failure(400, 'position_archived'))
					}
					positionId = position!.id
				}
				const [member] = await tx
					.insert(staffMembers)
					.values({
						firstName: row.firstName,
						lastName: row.lastName,
						email: row.email,
						phone: row.phone,
					})
					.returning({ id: staffMembers.id })
				if (positionId) {
					await tx.insert(staffAssignments).values({
						staffId: member!.id,
						locationId: input.locationId,
						positionId,
						isPrimary: true,
					})
				} else if (auth.claims.locationIds !== null) {
					throw new StaffingAbort(failure(400, 'assignment_required'))
				}
				created += 1
			}
			await recordStaffEvent(tx, auth, 'staff.imported', null, {
				created,
				skipped: skippedExisting.length,
				createdPositions: createdPositions.length,
			})
			return {
				ok: true as const,
				data: { created, skippedExisting, createdPositions },
			}
		}),
	)
}

export async function createPosition(
	orgId: string,
	auth: StaffingAuth,
	input: { name: string; colorKey: string },
): Promise<ServiceResult<ReturnType<typeof serializePosition>>> {
	const db = await getTenantDb(orgId)
	return db.transaction(async (tx) => {
		const [duplicate] = await tx
			.select({ id: staffPositions.id })
			.from(staffPositions)
			.where(sql`lower(${staffPositions.name}) = ${input.name.toLowerCase()}`)
			.limit(1)
		if (duplicate) return failure(409, 'duplicate_name')
		const [{ count } = { count: 0 }] = await tx
			.select({ count: sql<number>`count(*)` })
			.from(staffPositions)
		const [position] = await tx
			.insert(staffPositions)
			.values({ name: input.name, colorKey: input.colorKey, sortOrder: count })
			.returning()
		await recordStaffEvent(tx, auth, 'position.created', null, {
			positionId: position!.id,
		})
		return { ok: true as const, data: serializePosition(position!) }
	})
}

export async function updatePosition(
	orgId: string,
	auth: StaffingAuth,
	positionId: string,
	input: { name?: string; colorKey?: string; archived?: boolean },
): Promise<ServiceResult<ReturnType<typeof serializePosition>>> {
	const db = await getTenantDb(orgId)
	return db.transaction(async (tx) => {
		const [existing] = await tx
			.select()
			.from(staffPositions)
			.where(eq(staffPositions.id, positionId))
			.limit(1)
		if (!existing) return failure(404, 'not_found')
		if (
			input.name &&
			input.name.toLowerCase() !== existing.name.toLowerCase()
		) {
			const [duplicate] = await tx
				.select({ id: staffPositions.id })
				.from(staffPositions)
				.where(sql`lower(${staffPositions.name}) = ${input.name.toLowerCase()}`)
				.limit(1)
			if (duplicate) return failure(409, 'duplicate_name')
		}
		const archivedAt =
			input.archived === undefined
				? existing.archivedAt
				: input.archived
					? (existing.archivedAt ?? new Date())
					: null
		const [position] = await tx
			.update(staffPositions)
			.set({
				name: input.name ?? existing.name,
				colorKey: input.colorKey ?? existing.colorKey,
				archivedAt,
			})
			.where(eq(staffPositions.id, positionId))
			.returning()
		await recordStaffEvent(tx, auth, 'position.updated', null, {
			positionId,
			fields: Object.keys(input),
		})
		return { ok: true as const, data: serializePosition(position!) }
	})
}

export async function saveStaffingSettings(
	orgId: string,
	auth: StaffingAuth,
	input: StaffingSettings,
) {
	const db = await getTenantDb(orgId)
	await db.transaction(async (tx) => {
		await tx
			.insert(staffingSettings)
			.values({ id: 'default', ...input, updatedAt: new Date() })
			.onConflictDoUpdate({
				target: staffingSettings.id,
				set: { ...input, updatedAt: new Date() },
			})
		await recordStaffEvent(tx, auth, 'settings.updated', null, {
			fields: Object.keys(input),
		})
	})
	return input
}

export async function listStaffEvents(
	orgId: string,
	claims: StaffingTokenClaims,
	staffId: string,
): Promise<
	ServiceResult<
		{
			id: string
			kind: string
			actorRef: string
			detail: unknown
			at: string
		}[]
	>
> {
	const db = await getTenantDb(orgId)
	const visible = await loadVisibleStaff(db, claims, staffId)
	if (!visible) return failure(404, 'not_found')
	const events = await db
		.select()
		.from(staffEvents)
		.where(and(eq(staffEvents.staffId, staffId)))
		.orderBy(desc(staffEvents.at))
		.limit(100)
	return {
		ok: true,
		data: events.map((event) => ({
			id: event.id,
			kind: event.kind,
			actorRef: event.actorRef,
			detail: event.detail,
			at: event.at.toISOString(),
		})),
	}
}
