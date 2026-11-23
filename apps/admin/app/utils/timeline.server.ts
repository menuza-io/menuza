import { AuditAction } from '@repo/audit'
import {
	type OrganizationEventKind,
	type TimelineFilter,
	type TimelineLink,
	ORGANIZATION_EVENT_DEFINITIONS,
	isOrganizationEventKind,
	organizationEventLink,
	readStoredEventPayload,
} from '@repo/common/organization-events'
import {
	ASSIGNMENT_ROLE_LABELS,
	isAssignmentRole,
} from '@repo/common/support-assignments'
import {
	AuditLog,
	Feedback,
	Organization,
	OrganizationAssignment,
	OrganizationEvent,
	OrganizationLocation,
	SupportNote,
	User,
	UserOrganization,
	and,
	db,
	desc,
	eq,
	inArray,
	like,
	lt,
	or,
} from '@repo/database'

/**
 * One restaurant's account timeline for support (#279), newest first. It joins
 * what already exists instead of copying it: `OrganizationEvent` rows for the
 * payment, domain, billing, plan, launch and reminder events nothing else
 * records; the audit log for ordering pauses, texting lines, impersonation,
 * sign-in help and caller verification; support requests; assignments; and
 * support's own notes. Every entry is an id, a state or a date with a title the
 * Admin screen writes: no guest name, phone, email or order is read.
 */

export type TimelineEntry = {
	id: string
	at: Date
	filter: TimelineFilter
	title: string
	/** Plain facts: a plan name, a host, a status. Never free text from a guest. */
	detail: string | null
	locationId: string | null
	locationName: string | null
	link: TimelineLink | null
}

const PER_SOURCE = 120
const PAGE_SIZE = 40

/** Audit actions recorded against the organization itself. */
const ORG_AUDIT: Partial<
	Record<string, { filter: TimelineFilter; title: string }>
> = {
	[AuditAction.LOCATION_ORDERING_PAUSED]: {
		filter: 'ordering',
		title: 'Ordering paused',
	},
	[AuditAction.LOCATION_ORDERING_RESUMED]: {
		filter: 'ordering',
		title: 'Ordering resumed',
	},
	[AuditAction.PHONE_AGENT_NUMBER_ADDED]: {
		filter: 'texting',
		title: 'Phone number added',
	},
	[AuditAction.PHONE_AGENT_NUMBER_REMOVED]: {
		filter: 'texting',
		title: 'Phone number removed',
	},
	[AuditAction.PHONE_AGENT_LINE_VERIFICATION_SENT]: {
		filter: 'texting',
		title: 'Line verification code sent',
	},
	[AuditAction.PHONE_AGENT_LINE_VERIFIED]: {
		filter: 'texting',
		title: 'Business line verified',
	},
	[AuditAction.MARKETING_TEXT_SENDS_GRANTED]: {
		filter: 'texting',
		title: 'Text sends granted',
	},
	[AuditAction.ADMIN_OWNERSHIP_TRANSFER_STARTED]: {
		filter: 'access',
		title: 'Ownership transfer started',
	},
	[AuditAction.SUPPORT_REQUEST_REPLIED]: {
		filter: 'support',
		title: 'Support request reply',
	},
	[AuditAction.SUPPORT_REQUEST_STATUS_CHANGED]: {
		filter: 'support',
		title: 'Support request status changed',
	},
}

/** Audit actions recorded against a person, shown on the restaurants they belong to. */
const USER_AUDIT: Partial<
	Record<string, { filter: TimelineFilter; title: string }>
> = {
	[AuditAction.CALLER_VERIFICATION_REQUESTED]: {
		filter: 'access',
		title: 'Caller verification requested',
	},
	[AuditAction.CALLER_VERIFICATION_CODE_SHOWN]: {
		filter: 'access',
		title: 'Verification code shown to the member',
	},
	[AuditAction.CALLER_VERIFICATION_RESULT]: {
		filter: 'access',
		title: 'Caller verification result',
	},
	[AuditAction.SIGN_IN_HELP_LOOKUP]: {
		filter: 'access',
		title: 'Sign-in help lookup',
	},
	[AuditAction.SIGN_IN_HELP_PHONE_CHECK]: {
		filter: 'access',
		title: 'Phone number checked',
	},
	[AuditAction.SIGN_IN_HELP_RESEND]: {
		filter: 'access',
		title: 'Sign-in code resent',
	},
	[AuditAction.SIGN_IN_HELP_SESSIONS_ENDED]: {
		filter: 'access',
		title: 'All sessions ended',
	},
	[AuditAction.ADMIN_USER_EMAIL_CHANGED]: {
		filter: 'access',
		title: 'Email changed by support',
	},
	[AuditAction.ADMIN_USER_TWO_FACTOR_RESET]: {
		filter: 'access',
		title: 'Two-factor sign-in reset',
	},
	[AuditAction.ADMIN_SUPPORT_ACTION_REFUSED]: {
		filter: 'access',
		title: 'Sensitive action refused',
	},
}

const IMPERSONATION_ACTIONS = [
	AuditAction.ADMIN_IMPERSONATION_START,
	AuditAction.ADMIN_IMPERSONATION_END,
]

function parseMeta(raw: string | null): Record<string, unknown> {
	if (!raw) return {}
	try {
		const value: unknown = JSON.parse(raw)
		return value && typeof value === 'object'
			? (value as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}

const text = (value: unknown) =>
	typeof value === 'string' && value ? value.slice(0, 80) : null

/** The agent's name and a state word from an audit row, never its free-text details. */
function auditDetail(meta: Record<string, unknown>): string | null {
	const parts = [
		text(meta.agentName) ? `by ${text(meta.agentName)}` : null,
		text(meta.outcome) ? `result: ${text(meta.outcome)}` : null,
		text(meta.status) ? `status: ${text(meta.status)}` : null,
		text(meta.sensitiveAction) ? `action: ${text(meta.sensitiveAction)}` : null,
	].filter(Boolean)
	return parts.length ? parts.join(' · ') : null
}

function eventDetail(
	kind: OrganizationEventKind,
	payload: Record<string, unknown>,
): string | null {
	const pick = (...keys: string[]) =>
		keys
			.map((key) => payload[key])
			.filter((value) => value !== null && value !== undefined && value !== '')
			.map(String)
			.join(' · ') || null
	switch (kind) {
		case 'plan_changed':
			return pick('planName', 'subscriptionStatus')
		case 'launch_step_completed':
			return pick('stepKey')
		case 'payment_account_connected':
		case 'payment_account_needs_action':
			return `charges ${payload.chargesEnabled ? 'on' : 'off'} · payouts ${payload.payoutsEnabled ? 'on' : 'off'}`
		case 'payout_failed':
			return pick('failureCode')
		case 'domain_live':
		case 'domain_registered':
		case 'domain_failing':
			return pick('host', 'state')
		case 'billing_payment_failed':
			return payload.attemptCount ? `attempt ${payload.attemptCount}` : null
		case 'integration_connected':
		case 'integration_disconnected':
			return pick('provider')
		case 'reminder_sent':
			return pick('reminderKind')
		default:
			return null
	}
}

export async function loadTimeline(input: {
	organizationId: string
	filters?: TimelineFilter[]
	locationId?: string | null
	before?: Date | null
}): Promise<{
	entries: TimelineEntry[]
	pinned: Array<{
		id: string
		body: string
		authorName: string | null
		createdAt: Date
	}>
	locations: Array<{ id: string; name: string }>
	nextBefore: Date | null
}> {
	const { organizationId } = input
	const before = input.before ?? new Date(Date.now() + 60_000)
	const wanted = input.filters?.length ? new Set(input.filters) : null
	const wants = (filter: TimelineFilter) => !wanted || wanted.has(filter)

	const [organization] = await db_org(organizationId)
	if (!organization)
		return { entries: [], pinned: [], locations: [], nextBefore: null }

	const [locations, members] = await Promise.all([
		dbSelectLocations(organizationId),
		dbSelectMembers(organizationId),
	])
	const locationName = new Map(locations.map((l) => [l.id, l.name]))
	const memberIds = members.map((m) => m.userId)
	const entries: TimelineEntry[] = []
	const push = (entry: Omit<TimelineEntry, 'locationName'>) => {
		if (!wants(entry.filter)) return
		if (
			input.locationId &&
			entry.locationId &&
			entry.locationId !== input.locationId
		)
			return
		// A location filter hides what belongs to a different place; restaurant-wide
		// entries stay.
		entries.push({
			...entry,
			locationName: entry.locationId
				? (locationName.get(entry.locationId) ?? null)
				: null,
		})
	}

	// 1. Written events.
	const eventRows = await dbEvents(organizationId, before)
	for (const row of eventRows) {
		if (!isOrganizationEventKind(row.kind)) continue
		const definition = ORGANIZATION_EVENT_DEFINITIONS[row.kind]
		const payload = readStoredEventPayload(row.kind, row.payload)
		push({
			id: `event:${row.id}`,
			at: row.createdAt,
			filter: definition.group as TimelineFilter,
			title: definition.label,
			detail: eventDetail(row.kind, payload),
			locationId: row.locationId,
			link: organizationEventLink(row.kind, payload, organizationId),
		})
	}

	// 2. Sign-up: the organization's own created date.
	if (organization.createdAt < before) {
		push({
			id: `signup:${organization.id}`,
			at: organization.createdAt,
			filter: 'plan',
			title: 'Signed up',
			detail: null,
			locationId: null,
			link: {
				label: 'Open the restaurant',
				href: `/organizations/${organizationId}`,
				external: false,
			},
		})
	}

	// 3. Audit rows: read, not copied.
	const auditRows = await dbAudit({ organizationId, memberIds, before })
	for (const row of auditRows) {
		const meta = parseMeta(row.metadata)
		const isOrgRow = row.organizationId === organizationId
		const mapped = isOrgRow
			? ORG_AUDIT[row.action]
			: (USER_AUDIT[row.action] ??
				(IMPERSONATION_ACTIONS.includes(row.action as AuditAction)
					? {
							filter: 'access' as const,
							title:
								row.action === AuditAction.ADMIN_IMPERSONATION_START
									? 'Support impersonation started'
									: 'Support impersonation ended',
						}
					: undefined))
		// An organization row may also be a person row (a verification names the
		// organization it concerns): accept either map for it.
		const entry = mapped ?? USER_AUDIT[row.action]
		if (!entry) continue
		push({
			id: `audit:${row.id}`,
			at: row.createdAt,
			filter: entry.filter,
			title: entry.title,
			detail: auditDetail(meta),
			locationId: text(meta.locationId),
			link: {
				label: 'Open the audit log',
				// The audit log page filters by restaurant and searches the action.
				href: `/audit-logs?${row.organizationId ? `organizationId=${encodeURIComponent(row.organizationId)}&` : ''}search=${encodeURIComponent(row.action)}`,
				external: false,
			},
		})
	}

	// 4. Support requests.
	const requests = await dbRequests(organizationId, before)
	for (const row of requests) {
		push({
			id: `support:${row.id}`,
			at: row.createdAt,
			filter: 'support',
			title: row.kind === 'problem' ? 'Problem reported' : 'Support requested',
			detail: null,
			locationId: null,
			link: {
				label: 'Open the request',
				href: `/feedback/${row.id}`,
				external: false,
			},
		})
		if (row.closedAt && row.closedAt < before) {
			push({
				id: `support-closed:${row.id}`,
				at: row.closedAt,
				filter: 'support',
				title: 'Support request closed',
				detail: null,
				locationId: null,
				link: {
					label: 'Open the request',
					href: `/feedback/${row.id}`,
					external: false,
				},
			})
		}
	}

	// 5. Assignments.
	const assignments = await dbAssignments(organizationId)
	for (const row of assignments) {
		const role = isAssignmentRole(row.role)
			? ASSIGNMENT_ROLE_LABELS[row.role]
			: row.role
		const place = row.locationId
			? (locationName.get(row.locationId) ?? 'one location')
			: 'all locations'
		if (row.startedAt < before) {
			push({
				id: `assign:${row.id}`,
				at: row.startedAt,
				filter: 'assignments',
				title: `${role} assigned`,
				detail: `${row.adminName ?? 'Unknown'} · ${place}`,
				locationId: row.locationId,
				link: {
					label: 'Open the contacts',
					href: `/organizations/${organizationId}#contacts`,
					external: false,
				},
			})
		}
		if (row.endedAt && row.endedAt < before) {
			push({
				id: `unassign:${row.id}`,
				at: row.endedAt,
				filter: 'assignments',
				title: `${role} ended`,
				detail: `${row.adminName ?? 'Unknown'} · ${place}`,
				locationId: row.locationId,
				link: {
					label: 'Open the contacts',
					href: `/organizations/${organizationId}#contacts`,
					external: false,
				},
			})
		}
	}

	// 6. Notes.
	const notes = await dbNotes(organizationId)
	for (const row of notes) {
		if (row.createdAt >= before) continue
		push({
			id: `note:${row.id}`,
			at: row.createdAt,
			filter: 'notes',
			title: 'Note',
			detail: row.body,
			locationId: null,
			link: null,
		})
	}

	entries.sort((a, b) => b.at.getTime() - a.at.getTime())
	const page = entries.slice(0, PAGE_SIZE)
	const nextBefore =
		entries.length > PAGE_SIZE ? (page[page.length - 1]?.at ?? null) : null

	return {
		entries: page,
		pinned: notes
			.filter((note) => note.pinned)
			.map((note) => ({
				id: note.id,
				body: note.body,
				authorName: note.authorName,
				createdAt: note.createdAt,
			})),
		locations,
		nextBefore,
	}
}

// --- small queries, kept apart so the merge above reads top to bottom ---------

async function db_org(id: string) {
	return db
		.select({ id: Organization.id, createdAt: Organization.createdAt })
		.from(Organization)
		.where(eq(Organization.id, id))
		.limit(1)
}

async function dbSelectLocations(organizationId: string) {
	return db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organizationId))
}

async function dbSelectMembers(organizationId: string) {
	return db
		.select({ userId: UserOrganization.userId })
		.from(UserOrganization)
		.where(eq(UserOrganization.organizationId, organizationId))
		.limit(300)
}

async function dbEvents(organizationId: string, before: Date) {
	return db
		.select()
		.from(OrganizationEvent)
		.where(
			and(
				eq(OrganizationEvent.organizationId, organizationId),
				lt(OrganizationEvent.createdAt, before),
			),
		)
		.orderBy(desc(OrganizationEvent.createdAt))
		.limit(PER_SOURCE)
}

async function dbAudit(input: {
	organizationId: string
	memberIds: string[]
	before: Date
}) {
	const personActions = [...Object.keys(USER_AUDIT)]
	const rows = await db
		.select({
			id: AuditLog.id,
			action: AuditLog.action,
			organizationId: AuditLog.organizationId,
			metadata: AuditLog.metadata,
			createdAt: AuditLog.createdAt,
			targetUserId: AuditLog.targetUserId,
		})
		.from(AuditLog)
		.where(
			and(
				lt(AuditLog.createdAt, input.before),
				or(
					and(
						eq(AuditLog.organizationId, input.organizationId),
						inArray(AuditLog.action, [
							...Object.keys(ORG_AUDIT),
							...personActions,
						]),
					),
					input.memberIds.length
						? and(
								inArray(AuditLog.action, personActions),
								inArray(AuditLog.targetUserId, input.memberIds.slice(0, 90)),
							)
						: undefined,
				),
			),
		)
		.orderBy(desc(AuditLog.createdAt))
		.limit(PER_SOURCE)

	// Impersonation rows name their target in the metadata, not in a column.
	const impersonation: typeof rows = []
	for (let index = 0; index < input.memberIds.length; index += 30) {
		const chunk = input.memberIds.slice(index, index + 30)
		const found = await db
			.select({
				id: AuditLog.id,
				action: AuditLog.action,
				organizationId: AuditLog.organizationId,
				metadata: AuditLog.metadata,
				createdAt: AuditLog.createdAt,
				targetUserId: AuditLog.targetUserId,
			})
			.from(AuditLog)
			.where(
				and(
					inArray(AuditLog.action, IMPERSONATION_ACTIONS),
					lt(AuditLog.createdAt, input.before),
					or(
						...chunk.map((memberId) =>
							like(AuditLog.metadata, `%"targetUserId":"${memberId}"%`),
						),
					),
				),
			)
			.orderBy(desc(AuditLog.createdAt))
			.limit(PER_SOURCE)
		impersonation.push(...found)
	}
	const seen = new Set<string>()
	return [...rows, ...impersonation].filter((row) => {
		if (seen.has(row.id)) return false
		seen.add(row.id)
		return true
	})
}

async function dbRequests(organizationId: string, before: Date) {
	return db
		.select({
			id: Feedback.id,
			kind: Feedback.kind,
			createdAt: Feedback.createdAt,
			closedAt: Feedback.closedAt,
		})
		.from(Feedback)
		.where(
			and(
				eq(Feedback.organizationId, organizationId),
				inArray(Feedback.kind, ['support', 'problem']),
				lt(Feedback.createdAt, before),
			),
		)
		.orderBy(desc(Feedback.createdAt))
		.limit(PER_SOURCE)
}

async function dbAssignments(organizationId: string) {
	return db
		.select({
			id: OrganizationAssignment.id,
			role: OrganizationAssignment.role,
			locationId: OrganizationAssignment.locationId,
			startedAt: OrganizationAssignment.startedAt,
			endedAt: OrganizationAssignment.endedAt,
			adminName: User.name,
		})
		.from(OrganizationAssignment)
		.leftJoin(User, eq(User.id, OrganizationAssignment.adminUserId))
		.where(eq(OrganizationAssignment.organizationId, organizationId))
		.orderBy(desc(OrganizationAssignment.startedAt))
		.limit(PER_SOURCE)
}

async function dbNotes(organizationId: string) {
	return db
		.select({
			id: SupportNote.id,
			body: SupportNote.body,
			pinned: SupportNote.pinned,
			createdAt: SupportNote.createdAt,
			authorName: User.name,
		})
		.from(SupportNote)
		.leftJoin(User, eq(User.id, SupportNote.authorId))
		.where(eq(SupportNote.organizationId, organizationId))
		.orderBy(desc(SupportNote.createdAt))
		.limit(PER_SOURCE)
}
