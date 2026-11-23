import { AuditAction } from '@repo/audit'
import {
	ALL_LOCATIONS,
	ASSIGNMENT_ROLE_LABELS,
	type AssignmentRole,
	isAssignmentRole,
	scopeKeyFor,
} from '@repo/common/support-assignments'
import {
	Organization,
	OrganizationAssignment,
	OrganizationLocation,
	Role,
	User,
	_RoleToUser,
	and,
	asc,
	db,
	desc,
	eq,
	inArray,
	isNull,
	sql,
} from '@repo/database'
import { auditSupportAction, getAgentName } from './support.server.ts'

type BatchStatement = Parameters<typeof db.batch>[0][number]

/**
 * Menuza contacts (#272): who looks after a restaurant, by role and location
 * scope. Assignment names a person and routes support requests; it grants no
 * access and changes no Admin permission. A row is never edited or deleted when
 * someone is reassigned: it ends (`endedAt`) and a new one starts, so the table
 * is the history.
 */

/** The Admin team: people with the `admin` role, who can be assigned. */
export async function listTeamMembers() {
	return db
		.select({ id: User.id, name: User.name, username: User.username })
		.from(User)
		.innerJoin(_RoleToUser, eq(_RoleToUser.B, User.id))
		.innerJoin(Role, eq(Role.id, _RoleToUser.A))
		.where(eq(Role.name, 'admin'))
		.orderBy(asc(User.name))
		.then((rows) =>
			rows.map((row) => ({ id: row.id, name: row.name || row.username })),
		)
}

async function isTeamMember(userId: string) {
	const [row] = await db
		.select({ id: User.id })
		.from(User)
		.innerJoin(_RoleToUser, eq(_RoleToUser.B, User.id))
		.innerJoin(Role, eq(Role.id, _RoleToUser.A))
		.where(and(eq(User.id, userId), eq(Role.name, 'admin')))
		.limit(1)
	return Boolean(row)
}

export type AssignmentView = {
	id: string
	role: AssignmentRole
	roleLabel: string
	adminUserId: string
	adminName: string
	locationId: string | null
	locationName: string | null
	startedAt: Date
	endedAt: Date | null
	assignedByName: string | null
	endedByName: string | null
}

/** The open assignments and the history of an organization, newest first. */
export async function listAssignments(
	organizationId: string,
): Promise<{ open: AssignmentView[]; history: AssignmentView[] }> {
	const rows = await db
		.select()
		.from(OrganizationAssignment)
		.where(eq(OrganizationAssignment.organizationId, organizationId))
		.orderBy(desc(OrganizationAssignment.startedAt))
		.limit(200)
	const userIds = [
		...new Set(
			rows.flatMap((row) =>
				[row.adminUserId, row.assignedById, row.endedById].filter(
					(id): id is string => Boolean(id),
				),
			),
		),
	]
	const people = userIds.length
		? await db
				.select({ id: User.id, name: User.name, username: User.username })
				.from(User)
				.where(inArray(User.id, userIds))
		: []
	const name = new Map(people.map((p) => [p.id, p.name || p.username]))
	const locations = await db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organizationId))
	const locationName = new Map(locations.map((l) => [l.id, l.name]))

	const views = rows
		.filter((row) => isAssignmentRole(row.role))
		.map((row): AssignmentView => {
			const role = row.role as AssignmentRole
			return {
				id: row.id,
				role,
				roleLabel: ASSIGNMENT_ROLE_LABELS[role],
				adminUserId: row.adminUserId,
				adminName: name.get(row.adminUserId) ?? row.adminUserId,
				locationId: row.locationId,
				locationName: row.locationId
					? (locationName.get(row.locationId) ?? null)
					: null,
				startedAt: row.startedAt,
				endedAt: row.endedAt,
				assignedByName: row.assignedById
					? (name.get(row.assignedById) ?? null)
					: null,
				endedByName: row.endedById ? (name.get(row.endedById) ?? null) : null,
			}
		})
	return {
		open: views.filter((view) => view.endedAt === null),
		history: views.filter((view) => view.endedAt !== null),
	}
}

export type AssignOutcome =
	| { status: 'assigned'; replaced: boolean }
	| { status: 'unchanged' }
	| {
			status:
				'not_team_member' | 'organization_not_found' | 'location_not_found'
	  }

/**
 * Assigns a team member to a role for all locations or one. Whoever held that
 * role and scope has their row ended in the same batch, so there is never a gap
 * and never two people at once (the unique index would refuse the second).
 */
export async function assignContact(input: {
	organizationId: string
	adminUserId: string
	role: AssignmentRole
	locationId: string | null
	byAgentId: string
	request?: Request
	now?: Date
}): Promise<AssignOutcome> {
	const now = input.now ?? new Date()
	if (!(await isTeamMember(input.adminUserId))) {
		return { status: 'not_team_member' }
	}
	const [organization] = await db
		.select({ id: Organization.id, name: Organization.name })
		.from(Organization)
		.where(eq(Organization.id, input.organizationId))
		.limit(1)
	if (!organization) return { status: 'organization_not_found' }
	if (input.locationId) {
		const [location] = await db
			.select({ id: OrganizationLocation.id })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.id, input.locationId),
					eq(OrganizationLocation.organizationId, input.organizationId),
				),
			)
			.limit(1)
		if (!location) return { status: 'location_not_found' }
	}
	const scopeKey = scopeKeyFor(input.locationId)
	const [current] = await db
		.select({
			id: OrganizationAssignment.id,
			adminUserId: OrganizationAssignment.adminUserId,
		})
		.from(OrganizationAssignment)
		.where(
			and(
				eq(OrganizationAssignment.organizationId, input.organizationId),
				eq(OrganizationAssignment.role, input.role),
				eq(OrganizationAssignment.scopeKey, scopeKey),
				isNull(OrganizationAssignment.endedAt),
			),
		)
		.limit(1)
	if (current?.adminUserId === input.adminUserId) return { status: 'unchanged' }

	const ended = current
		? db
				.update(OrganizationAssignment)
				.set({ endedAt: now, endedById: input.byAgentId })
				.where(eq(OrganizationAssignment.id, current.id))
		: null
	const started = db.insert(OrganizationAssignment).values({
		organizationId: input.organizationId,
		adminUserId: input.adminUserId,
		role: input.role,
		locationId: input.locationId,
		scopeKey,
		startedAt: now,
		assignedById: input.byAgentId,
	})
	// One batch: the old holder ends in the same write the new one starts.
	await db.batch(
		(ended ? [ended, started] : [started]) as unknown as Parameters<
			typeof db.batch
		>[0],
	)

	await auditSupportAction({
		action: AuditAction.ORG_ASSIGNMENT_CHANGED,
		agentId: input.byAgentId,
		organizationId: input.organizationId,
		targetUserId: input.adminUserId,
		resourceType: 'OrganizationAssignment',
		details: `${current ? 'Reassigned' : 'Assigned'} ${ASSIGNMENT_ROLE_LABELS[input.role]}`,
		metadata: {
			change: current ? 'reassigned' : 'assigned',
			role: input.role,
			scope: scopeKey,
			assignedUserId: input.adminUserId,
			previousUserId: current?.adminUserId ?? null,
			assignedName: await getAgentName(input.adminUserId),
		},
		request: input.request,
	})
	return { status: 'assigned', replaced: Boolean(current) }
}

export async function unassignContact(input: {
	assignmentId: string
	byAgentId: string
	request?: Request
	now?: Date
}): Promise<'ok' | 'not_found'> {
	const [row] = await db
		.select()
		.from(OrganizationAssignment)
		.where(
			and(
				eq(OrganizationAssignment.id, input.assignmentId),
				isNull(OrganizationAssignment.endedAt),
			),
		)
		.limit(1)
	if (!row) return 'not_found'
	await db
		.update(OrganizationAssignment)
		.set({ endedAt: input.now ?? new Date(), endedById: input.byAgentId })
		.where(eq(OrganizationAssignment.id, row.id))
	await auditSupportAction({
		action: AuditAction.ORG_ASSIGNMENT_CHANGED,
		agentId: input.byAgentId,
		organizationId: row.organizationId,
		targetUserId: row.adminUserId,
		resourceType: 'OrganizationAssignment',
		details: 'Removed a contact',
		metadata: {
			change: 'removed',
			role: row.role,
			scope: row.scopeKey,
			previousUserId: row.adminUserId,
		},
		request: input.request,
	})
	return 'ok'
}

/**
 * Hands every open assignment of one team member to another, for when someone
 * leaves the team. One batch, so nothing is half moved. A scope the new person
 * already holds for that role is just ended, never doubled.
 */
export async function bulkReassign(input: {
	fromUserId: string
	toUserId: string
	byAgentId: string
	roles?: AssignmentRole[]
	request?: Request
	now?: Date
}): Promise<
	| { status: 'ok'; moved: number }
	| { status: 'not_team_member' | 'same_person' }
> {
	if (input.fromUserId === input.toUserId) return { status: 'same_person' }
	if (!(await isTeamMember(input.toUserId)))
		return { status: 'not_team_member' }
	const now = input.now ?? new Date()
	const open = await db
		.select()
		.from(OrganizationAssignment)
		.where(
			and(
				eq(OrganizationAssignment.adminUserId, input.fromUserId),
				isNull(OrganizationAssignment.endedAt),
				input.roles?.length
					? inArray(OrganizationAssignment.role, input.roles)
					: undefined,
			),
		)
	if (open.length === 0) return { status: 'ok', moved: 0 }

	const targetHolds = await db
		.select({
			organizationId: OrganizationAssignment.organizationId,
			role: OrganizationAssignment.role,
			scopeKey: OrganizationAssignment.scopeKey,
		})
		.from(OrganizationAssignment)
		.where(
			and(
				eq(OrganizationAssignment.adminUserId, input.toUserId),
				isNull(OrganizationAssignment.endedAt),
			),
		)
	const held = new Set(
		targetHolds.map(
			(row) => `${row.organizationId}|${row.role}|${row.scopeKey}`,
		),
	)

	const statements: BatchStatement[] = open.flatMap((row) => {
		const ends = db
			.update(OrganizationAssignment)
			.set({ endedAt: now, endedById: input.byAgentId })
			.where(eq(OrganizationAssignment.id, row.id))
		if (held.has(`${row.organizationId}|${row.role}|${row.scopeKey}`)) {
			return [ends]
		}
		return [
			ends,
			db.insert(OrganizationAssignment).values({
				organizationId: row.organizationId,
				adminUserId: input.toUserId,
				role: row.role,
				locationId: row.locationId,
				scopeKey: row.scopeKey,
				startedAt: now,
				assignedById: input.byAgentId,
			}),
		]
	})
	// D1 allows 100 statements per batch call: send them in chunks of pairs.
	for (let index = 0; index < statements.length; index += 90) {
		const chunk = statements.slice(index, index + 90)
		await db.batch(chunk as unknown as Parameters<typeof db.batch>[0])
	}

	const toName = await getAgentName(input.toUserId)
	const fromName = await getAgentName(input.fromUserId)
	for (const organizationId of new Set(open.map((row) => row.organizationId))) {
		await auditSupportAction({
			action: AuditAction.ORG_ASSIGNMENT_CHANGED,
			agentId: input.byAgentId,
			organizationId,
			targetUserId: input.toUserId,
			resourceType: 'OrganizationAssignment',
			details: 'Bulk reassigned a contact',
			metadata: {
				change: 'bulk_reassigned',
				previousUserId: input.fromUserId,
				previousName: fromName,
				assignedUserId: input.toUserId,
				assignedName: toName,
			},
			request: input.request,
		})
	}
	return { status: 'ok', moved: open.length }
}

/**
 * The SQL condition of the list filter: `me`, `unassigned` or a team member's
 * id. Rows that hold an open assignment of that person (`unassigned`: none at
 * all). Used by the organizations list next to the stuck-in-setup filter.
 */
export function assigneeCondition(
	assignee: string | null | undefined,
	agentId: string,
) {
	if (!assignee) return undefined
	if (assignee === 'unassigned') {
		return sql`not exists (
			select 1 from "OrganizationAssignment" as contact
			where contact."organizationId" = ${Organization.id}
				and contact."endedAt" is null
		)`
	}
	const personId = assignee === 'me' ? agentId : assignee
	return sql`exists (
		select 1 from "OrganizationAssignment" as contact
		where contact."organizationId" = ${Organization.id}
			and contact."endedAt" is null
			and contact."adminUserId" = ${personId}
	)`
}

export { ALL_LOCATIONS }
