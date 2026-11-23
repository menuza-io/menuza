import { AuditAction, auditService } from '@repo/audit'
import { ORG_PERMISSIONS, userHasOrganizationPermission } from '@repo/auth'
import {
	pickSupportContact,
	type PublicSupportContact,
	firstNameOf,
} from '@repo/common/support-assignments'
import {
	type FeedbackKind,
	type SupportRequestKind,
	type SupportRequestStatus,
	buildSupportContext,
	isUnreadFor,
	parseStoredSupportContext,
	statusAfterMessage,
} from '@repo/common/support-requests'
import {
	Feedback,
	FeedbackMessage,
	Organization,
	OrganizationAssignment,
	User,
	UserImage,
	UserOrganization,
	and,
	asc,
	db,
	desc,
	eq,
	inArray,
	isNull,
	or,
} from '@repo/database'

/**
 * Support requests from the App's side (#233, #406). One record: the
 * `Feedback` table with `kind` support or problem. Everything here is control
 * plane, so it works while the regional node is down, and nothing here reads
 * or stores a guest's name, phone, email or order.
 */

export type SupportOrganization = {
	id: string
	slug: string
	name: string
	canManageSupport: boolean
}

/** The organization when the user is an active member of it, with the support permission flag. */
export async function resolveSupportOrganization(
	userId: string,
	slug: string,
): Promise<SupportOrganization | null> {
	const [row] = await db
		.select({
			id: Organization.id,
			slug: Organization.slug,
			name: Organization.name,
		})
		.from(Organization)
		.innerJoin(
			UserOrganization,
			and(
				eq(UserOrganization.organizationId, Organization.id),
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
			),
		)
		.where(and(eq(Organization.slug, slug), eq(Organization.active, true)))
		.limit(1)
	if (!row) return null
	return {
		...row,
		canManageSupport: await userHasOrganizationPermission(
			userId,
			row.id,
			ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
		),
	}
}

/**
 * Members with the support permission (owners and admins by default) see every
 * request of their organization; any other member sees only the requests they
 * sent themselves, so a reply to them can still be opened.
 */
export function visibleRequestsCondition(
	user: { id: string },
	organization: Pick<SupportOrganization, 'id' | 'canManageSupport'>,
) {
	return and(
		eq(Feedback.organizationId, organization.id),
		inArray(Feedback.kind, ['support', 'problem']),
		organization.canManageSupport ? undefined : eq(Feedback.userId, user.id),
	)
}

/** The Menuza contact a restaurant sees in Help: first name and photo only. */
export async function loadSupportContact(
	organizationId: string,
	locationId?: string | null,
): Promise<PublicSupportContact | null> {
	const open = await db
		.select({
			role: OrganizationAssignment.role,
			scopeKey: OrganizationAssignment.scopeKey,
			adminUserId: OrganizationAssignment.adminUserId,
		})
		.from(OrganizationAssignment)
		.where(
			and(
				eq(OrganizationAssignment.organizationId, organizationId),
				isNull(OrganizationAssignment.endedAt),
			),
		)
	const contact = pickSupportContact(open, locationId)
	if (!contact) return null
	const [person] = await db
		.select({
			name: User.name,
			username: User.username,
			objectKey: UserImage.objectKey,
		})
		.from(User)
		.leftJoin(UserImage, eq(UserImage.userId, User.id))
		.where(eq(User.id, contact.adminUserId))
		.limit(1)
	if (!person) return null
	// Only these two fields leave this function: no surname, email or id.
	return {
		firstName: firstNameOf(person.name, 'Menuza'),
		imageObjectKey: person.objectKey ?? null,
	}
}

export type CreateSupportRequestInput = {
	userId: string
	organization: SupportOrganization
	kind: SupportRequestKind
	subject?: string | null
	message: string
	path?: string | null
	errorId?: string | null
	appVersion?: string | null
	locationId?: string | null
	screenshotKey?: string | null
	request?: Request
}

export async function createSupportRequest(input: CreateSupportRequestInput) {
	const now = new Date()
	const context = buildSupportContext({
		organizationId: input.organization.id,
		organizationSlug: input.organization.slug,
		locationId: input.locationId,
		path: input.path,
		appVersion: input.appVersion,
		errorId: input.errorId,
	})
	// Routed to the support contact first (#272): support, else account manager,
	// else launch specialist. Nobody assigned leaves it for the whole team.
	const open = await db
		.select({
			role: OrganizationAssignment.role,
			scopeKey: OrganizationAssignment.scopeKey,
			adminUserId: OrganizationAssignment.adminUserId,
		})
		.from(OrganizationAssignment)
		.where(
			and(
				eq(OrganizationAssignment.organizationId, input.organization.id),
				isNull(OrganizationAssignment.endedAt),
			),
		)
	const assignee =
		pickSupportContact(open, input.locationId)?.adminUserId ?? null

	const [row] = await db
		.insert(Feedback)
		.values({
			userId: input.userId,
			organizationId: input.organization.id,
			kind: input.kind,
			type: input.kind === 'problem' ? 'PROBLEM' : 'SUPPORT',
			status: 'open',
			subject: input.subject?.trim() || null,
			message: input.message,
			context: JSON.stringify(context),
			errorId: context.errorId ?? null,
			screenshotKey: input.screenshotKey ?? null,
			assigneeId: assignee,
			lastMessageAt: now,
			lastMessageSide: 'member',
			memberReadAt: now,
			createdAt: now,
		})
		.returning({ id: Feedback.id })

	await auditService.log({
		action: AuditAction.SUPPORT_REQUEST_CREATED,
		userId: input.userId,
		organizationId: input.organization.id,
		resourceType: 'Feedback',
		resourceId: row!.id,
		// Ids and the kind only: the message is not copied into the audit log.
		details: `Support request created (${input.kind})`,
		metadata: {
			kind: input.kind,
			hasScreenshot: Boolean(input.screenshotKey),
			routedToContact: Boolean(assignee),
		},
		request: input.request,
	})
	return { id: row!.id, assigneeId: assignee }
}

export type SupportRequestSummary = {
	id: string
	kind: FeedbackKind
	status: SupportRequestStatus
	subject: string | null
	preview: string
	createdAt: string
	lastMessageAt: string
	unread: boolean
	senderName: string | null
}

const PREVIEW_LENGTH = 140

export async function listSupportRequests(
	user: { id: string },
	organization: SupportOrganization,
): Promise<SupportRequestSummary[]> {
	const rows = await db
		.select({
			id: Feedback.id,
			kind: Feedback.kind,
			status: Feedback.status,
			subject: Feedback.subject,
			message: Feedback.message,
			createdAt: Feedback.createdAt,
			lastMessageAt: Feedback.lastMessageAt,
			lastMessageSide: Feedback.lastMessageSide,
			memberReadAt: Feedback.memberReadAt,
			supportReadAt: Feedback.supportReadAt,
			senderId: Feedback.userId,
			senderName: User.name,
		})
		.from(Feedback)
		.innerJoin(User, eq(User.id, Feedback.userId))
		.where(visibleRequestsCondition(user, organization))
		.orderBy(desc(Feedback.lastMessageAt))
		.limit(200)
	return rows.map((row) => ({
		id: row.id,
		kind: row.kind as FeedbackKind,
		status: row.status as SupportRequestStatus,
		subject: row.subject,
		preview: row.message.slice(0, PREVIEW_LENGTH),
		createdAt: row.createdAt.toISOString(),
		lastMessageAt: (row.lastMessageAt ?? row.createdAt).toISOString(),
		unread: isUnreadFor('member', row),
		senderName: row.senderId === user.id ? null : row.senderName,
	}))
}

/** How many requests have a reply the member has not read (the badge). */
export async function countUnreadSupportRequests(
	userId: string,
	organizationId?: string | null,
): Promise<number> {
	const orgIds = organizationId
		? [organizationId]
		: (
				await db
					.select({ id: UserOrganization.organizationId })
					.from(UserOrganization)
					.where(
						and(
							eq(UserOrganization.userId, userId),
							eq(UserOrganization.active, true),
						),
					)
			).map((row) => row.id)
	if (orgIds.length === 0) return 0

	const rows = await db
		.select({
			id: Feedback.id,
			organizationId: Feedback.organizationId,
			userId: Feedback.userId,
			kind: Feedback.kind,
			status: Feedback.status,
			lastMessageAt: Feedback.lastMessageAt,
			lastMessageSide: Feedback.lastMessageSide,
			memberReadAt: Feedback.memberReadAt,
			supportReadAt: Feedback.supportReadAt,
		})
		.from(Feedback)
		.where(
			and(
				inArray(Feedback.organizationId, orgIds),
				inArray(Feedback.kind, ['support', 'problem']),
				or(eq(Feedback.status, 'open'), eq(Feedback.status, 'waiting_on_you')),
				eq(Feedback.lastMessageSide, 'support'),
			),
		)
		.limit(500)
	if (rows.length === 0) return 0
	// Which organizations let this member see every request.
	const manageable = new Set<string>()
	for (const organizationId of new Set(rows.map((row) => row.organizationId))) {
		if (
			await userHasOrganizationPermission(
				userId,
				organizationId,
				ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
			)
		) {
			manageable.add(organizationId)
		}
	}
	return rows.filter(
		(row) =>
			(manageable.has(row.organizationId) || row.userId === userId) &&
			isUnreadFor('member', row),
	).length
}

export type SupportThread = {
	id: string
	kind: FeedbackKind
	status: SupportRequestStatus
	subject: string | null
	unread: boolean
	context: ReturnType<typeof parseStoredSupportContext>
	hasScreenshot: boolean
	messages: Array<{
		id: string
		side: 'member' | 'support'
		authorName: string
		body: string
		createdAt: string
	}>
}

export async function getSupportThread(
	user: { id: string },
	organization: SupportOrganization,
	requestId: string,
): Promise<SupportThread | null> {
	const [row] = await db
		.select({
			id: Feedback.id,
			kind: Feedback.kind,
			status: Feedback.status,
			subject: Feedback.subject,
			message: Feedback.message,
			context: Feedback.context,
			screenshotKey: Feedback.screenshotKey,
			createdAt: Feedback.createdAt,
			lastMessageAt: Feedback.lastMessageAt,
			lastMessageSide: Feedback.lastMessageSide,
			memberReadAt: Feedback.memberReadAt,
			supportReadAt: Feedback.supportReadAt,
			senderName: User.name,
			senderUsername: User.username,
		})
		.from(Feedback)
		.innerJoin(User, eq(User.id, Feedback.userId))
		.where(
			and(
				eq(Feedback.id, requestId),
				visibleRequestsCondition(user, organization),
			),
		)
		.limit(1)
	if (!row) return null
	const replies = await db
		.select({
			id: FeedbackMessage.id,
			side: FeedbackMessage.side,
			body: FeedbackMessage.body,
			createdAt: FeedbackMessage.createdAt,
			authorName: User.name,
		})
		.from(FeedbackMessage)
		.leftJoin(User, eq(User.id, FeedbackMessage.authorId))
		.where(eq(FeedbackMessage.feedbackId, requestId))
		.orderBy(asc(FeedbackMessage.createdAt))
	return {
		id: row.id,
		kind: row.kind as FeedbackKind,
		status: row.status as SupportRequestStatus,
		subject: row.subject,
		unread: isUnreadFor('member', row),
		context: parseStoredSupportContext(row.context),
		hasScreenshot: Boolean(row.screenshotKey),
		messages: [
			{
				id: `first-${row.id}`,
				side: 'member',
				authorName: row.senderName ?? row.senderUsername,
				body: row.message,
				createdAt: row.createdAt.toISOString(),
			},
			...replies.map((reply) => ({
				id: reply.id,
				side: reply.side as 'member' | 'support',
				// Support replies show the team's first name only.
				authorName:
					reply.side === 'support'
						? firstNameOf(reply.authorName, 'Menuza support')
						: (reply.authorName ?? ''),
				body: reply.body,
				createdAt: reply.createdAt.toISOString(),
			})),
		],
	}
}

/** The member opened the thread: replies up to now are read. */
export async function markSupportThreadRead(
	user: { id: string },
	organization: SupportOrganization,
	requestId: string,
) {
	await db
		.update(Feedback)
		.set({ memberReadAt: new Date() })
		.where(
			and(
				eq(Feedback.id, requestId),
				visibleRequestsCondition(user, organization),
			),
		)
}

export type ReplyResult = 'ok' | 'not_found'

export async function postMemberReply(input: {
	user: { id: string }
	organization: SupportOrganization
	requestId: string
	body: string
	request?: Request
}): Promise<ReplyResult> {
	const [row] = await db
		.select({ id: Feedback.id, status: Feedback.status })
		.from(Feedback)
		.where(
			and(
				eq(Feedback.id, input.requestId),
				visibleRequestsCondition(input.user, input.organization),
			),
		)
		.limit(1)
	if (!row) return 'not_found'
	const now = new Date()
	await db.batch([
		db.insert(FeedbackMessage).values({
			feedbackId: row.id,
			side: 'member',
			authorId: input.user.id,
			body: input.body,
			createdAt: now,
		}),
		db
			.update(Feedback)
			.set({
				status: statusAfterMessage(
					'member',
					row.status as SupportRequestStatus,
				),
				closedAt: null,
				closedById: null,
				lastMessageAt: now,
				lastMessageSide: 'member',
				memberReadAt: now,
			})
			.where(eq(Feedback.id, row.id)),
	])
	await auditService.log({
		action: AuditAction.SUPPORT_REQUEST_REPLIED,
		userId: input.user.id,
		organizationId: input.organization.id,
		resourceType: 'Feedback',
		resourceId: row.id,
		details: 'Member replied to a support request',
		metadata: { side: 'member' },
		request: input.request,
	})
	return 'ok'
}

/** A member closes their own request ("solved"). A new reply opens it again. */
export async function closeSupportRequest(input: {
	user: { id: string }
	organization: SupportOrganization
	requestId: string
	request?: Request
}): Promise<ReplyResult> {
	const updated = await db
		.update(Feedback)
		.set({ status: 'closed', closedAt: new Date(), closedById: input.user.id })
		.where(
			and(
				eq(Feedback.id, input.requestId),
				visibleRequestsCondition(input.user, input.organization),
			),
		)
		.returning({ id: Feedback.id })
	if (updated.length === 0) return 'not_found'
	await auditService.log({
		action: AuditAction.SUPPORT_REQUEST_STATUS_CHANGED,
		userId: input.user.id,
		organizationId: input.organization.id,
		resourceType: 'Feedback',
		resourceId: input.requestId,
		details: 'Support request closed by the member',
		metadata: { status: 'closed', side: 'member' },
		request: input.request,
	})
	return 'ok'
}
