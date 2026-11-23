import { AuditAction } from '@repo/audit'
import {
	type FeedbackKind,
	type SupportRequestStatus,
	isUnreadFor,
	parseStoredSupportContext,
	statusAfterMessage,
} from '@repo/common/support-requests'
import {
	Feedback,
	FeedbackMessage,
	Organization,
	User,
	and,
	asc,
	db,
	desc,
	eq,
	inArray,
	like,
	or,
	sql,
} from '@repo/database'
import { postToApp } from './app-service.server.ts'
import { auditSupportAction } from './support.server.ts'

/**
 * The Admin side of support requests (#233, #406): the same `Feedback` record
 * the App writes, with its reply thread. Replies and status changes are audited
 * with the agent's name; the sender is told through the App's notification
 * engine (`POST /resources/support/notify`), never by a second mailer here.
 */

export type RequestFilters = {
	kind?: 'all' | FeedbackKind
	status?: 'all' | SupportRequestStatus
	/** `me`: routed to the signed-in agent. */
	assignee?: 'me' | 'unassigned' | 'all'
	search?: string
}

export type RequestListRow = {
	id: string
	kind: FeedbackKind
	status: SupportRequestStatus
	type: string
	subject: string | null
	preview: string
	createdAt: Date
	lastMessageAt: Date
	unread: boolean
	hasError: boolean
	organization: { id: string; name: string }
	sender: { id: string; name: string | null; email: string }
	assigneeName: string | null
}

export async function listRequests(
	agentId: string,
	filters: RequestFilters = {},
): Promise<RequestListRow[]> {
	const search = filters.search?.trim()
	const rows = await db
		.select({
			id: Feedback.id,
			kind: Feedback.kind,
			status: Feedback.status,
			type: Feedback.type,
			subject: Feedback.subject,
			message: Feedback.message,
			errorId: Feedback.errorId,
			createdAt: Feedback.createdAt,
			lastMessageAt: Feedback.lastMessageAt,
			lastMessageSide: Feedback.lastMessageSide,
			memberReadAt: Feedback.memberReadAt,
			supportReadAt: Feedback.supportReadAt,
			assigneeId: Feedback.assigneeId,
			organizationId: Organization.id,
			organizationName: Organization.name,
			senderId: User.id,
			senderName: User.name,
			senderEmail: User.email,
		})
		.from(Feedback)
		.innerJoin(User, eq(User.id, Feedback.userId))
		.innerJoin(Organization, eq(Organization.id, Feedback.organizationId))
		.where(
			and(
				filters.kind && filters.kind !== 'all'
					? eq(Feedback.kind, filters.kind)
					: undefined,
				filters.status && filters.status !== 'all'
					? eq(Feedback.status, filters.status)
					: undefined,
				filters.assignee === 'me'
					? eq(Feedback.assigneeId, agentId)
					: undefined,
				filters.assignee === 'unassigned'
					? sql`${Feedback.assigneeId} IS NULL`
					: undefined,
				search
					? or(
							like(Organization.name, `%${search}%`),
							like(User.email, `%${search}%`),
							like(Feedback.subject, `%${search}%`),
						)
					: undefined,
			),
		)
		.orderBy(
			desc(sql`coalesce(${Feedback.lastMessageAt}, ${Feedback.createdAt})`),
		)
		.limit(300)

	const assigneeIds = [
		...new Set(rows.map((row) => row.assigneeId).filter(Boolean)),
	] as string[]
	const assignees = assigneeIds.length
		? await db
				.select({ id: User.id, name: User.name, username: User.username })
				.from(User)
				.where(inArray(User.id, assigneeIds))
		: []
	const assigneeName = new Map(
		assignees.map((person) => [person.id, person.name || person.username]),
	)

	return rows.map((row) => ({
		id: row.id,
		kind: row.kind as FeedbackKind,
		status: row.status as SupportRequestStatus,
		type: row.type,
		subject: row.subject,
		preview: row.message.slice(0, 140),
		createdAt: row.createdAt,
		lastMessageAt: row.lastMessageAt ?? row.createdAt,
		unread: isUnreadFor('support', row),
		hasError: Boolean(row.errorId),
		organization: { id: row.organizationId, name: row.organizationName },
		sender: { id: row.senderId, name: row.senderName, email: row.senderEmail },
		assigneeName: row.assigneeId
			? (assigneeName.get(row.assigneeId) ?? null)
			: null,
	}))
}

export type RequestThread = {
	id: string
	kind: FeedbackKind
	status: SupportRequestStatus
	subject: string | null
	organization: { id: string; name: string; slug: string }
	sender: { id: string; name: string | null; email: string }
	context: ReturnType<typeof parseStoredSupportContext>
	errorId: string | null
	hasScreenshot: boolean
	assigneeName: string | null
	messages: Array<{
		id: string
		side: 'member' | 'support'
		authorName: string
		body: string
		createdAt: Date
	}>
}

/** One request with its thread. Opening it reads it for support (`supportReadAt`). */
export async function getRequestThread(
	requestId: string,
	options: { markRead?: boolean } = {},
): Promise<RequestThread | null> {
	const [row] = await db
		.select({
			id: Feedback.id,
			kind: Feedback.kind,
			status: Feedback.status,
			subject: Feedback.subject,
			message: Feedback.message,
			context: Feedback.context,
			errorId: Feedback.errorId,
			screenshotKey: Feedback.screenshotKey,
			createdAt: Feedback.createdAt,
			assigneeId: Feedback.assigneeId,
			organizationId: Organization.id,
			organizationName: Organization.name,
			organizationSlug: Organization.slug,
			senderId: User.id,
			senderName: User.name,
			senderEmail: User.email,
			senderUsername: User.username,
		})
		.from(Feedback)
		.innerJoin(User, eq(User.id, Feedback.userId))
		.innerJoin(Organization, eq(Organization.id, Feedback.organizationId))
		.where(eq(Feedback.id, requestId))
		.limit(1)
	if (!row) return null

	const [replies, assignee] = await Promise.all([
		db
			.select({
				id: FeedbackMessage.id,
				side: FeedbackMessage.side,
				body: FeedbackMessage.body,
				createdAt: FeedbackMessage.createdAt,
				authorName: User.name,
				authorUsername: User.username,
			})
			.from(FeedbackMessage)
			.leftJoin(User, eq(User.id, FeedbackMessage.authorId))
			.where(eq(FeedbackMessage.feedbackId, requestId))
			.orderBy(asc(FeedbackMessage.createdAt)),
		row.assigneeId
			? db
					.select({ name: User.name, username: User.username })
					.from(User)
					.where(eq(User.id, row.assigneeId))
					.limit(1)
			: Promise.resolve([]),
	])

	if (options.markRead && row.kind !== 'feedback') {
		await db
			.update(Feedback)
			.set({ supportReadAt: new Date() })
			.where(eq(Feedback.id, requestId))
	}

	return {
		id: row.id,
		kind: row.kind as FeedbackKind,
		status: row.status as SupportRequestStatus,
		subject: row.subject,
		organization: {
			id: row.organizationId,
			name: row.organizationName,
			slug: row.organizationSlug,
		},
		sender: { id: row.senderId, name: row.senderName, email: row.senderEmail },
		context: parseStoredSupportContext(row.context),
		errorId: row.errorId,
		hasScreenshot: Boolean(row.screenshotKey),
		assigneeName: assignee[0]?.name || assignee[0]?.username || null,
		messages: [
			{
				id: `first-${row.id}`,
				side: 'member',
				authorName: row.senderName || row.senderUsername,
				body: row.message,
				createdAt: row.createdAt,
			},
			...replies.map((reply) => ({
				id: reply.id,
				side: reply.side as 'member' | 'support',
				authorName: reply.authorName || reply.authorUsername || 'Support',
				body: reply.body,
				createdAt: reply.createdAt,
			})),
		],
	}
}

export async function getScreenshotKey(requestId: string) {
	const [row] = await db
		.select({ key: Feedback.screenshotKey })
		.from(Feedback)
		.where(eq(Feedback.id, requestId))
		.limit(1)
	return row?.key ?? null
}

export type ReplyOutcome =
	| { status: 'replied'; messageId: string; notified: boolean }
	| { status: 'not_found' | 'not_a_request' }

/**
 * Support replies. The thread and the status change are written first; the
 * sender's notice is best effort, so a reply is never lost because the App was
 * unreachable (the unread badge reads the thread, not the notice).
 */
export async function replyToRequest(input: {
	agentId: string
	requestId: string
	body: string
	request?: Request
}): Promise<ReplyOutcome> {
	const [row] = await db
		.select({
			id: Feedback.id,
			kind: Feedback.kind,
			status: Feedback.status,
			organizationId: Feedback.organizationId,
		})
		.from(Feedback)
		.where(eq(Feedback.id, input.requestId))
		.limit(1)
	if (!row) return { status: 'not_found' }
	if (row.kind === 'feedback') return { status: 'not_a_request' }

	const now = new Date()
	const [message] = await db
		.insert(FeedbackMessage)
		.values({
			feedbackId: row.id,
			side: 'support',
			authorId: input.agentId,
			body: input.body,
			createdAt: now,
		})
		.returning({ id: FeedbackMessage.id })
	await db
		.update(Feedback)
		.set({
			status: statusAfterMessage('support', row.status as SupportRequestStatus),
			lastMessageAt: now,
			lastMessageSide: 'support',
			supportReadAt: now,
		})
		.where(eq(Feedback.id, row.id))

	await auditSupportAction({
		action: AuditAction.SUPPORT_REQUEST_REPLIED,
		agentId: input.agentId,
		organizationId: row.organizationId,
		resourceType: 'Feedback',
		resourceId: row.id,
		// The reply text is not copied into the audit log.
		details: 'Support replied to a request',
		metadata: { side: 'support' },
		request: input.request,
	})

	let notified = false
	const result = await postToApp(
		'/resources/support/notify',
		{ feedbackId: row.id, messageId: message!.id },
		{ timeoutMs: 8_000 },
	)
	if (result.status === 'answered') {
		notified = result.response.ok
		void result.response.body?.cancel().catch(() => undefined)
	}
	return { status: 'replied', messageId: message!.id, notified }
}

export async function setRequestStatus(input: {
	agentId: string
	requestId: string
	status: 'closed' | 'open'
	request?: Request
}): Promise<'ok' | 'not_found'> {
	const [row] = await db
		.select({
			id: Feedback.id,
			kind: Feedback.kind,
			organizationId: Feedback.organizationId,
		})
		.from(Feedback)
		.where(eq(Feedback.id, input.requestId))
		.limit(1)
	if (!row || row.kind === 'feedback') return 'not_found'
	await db
		.update(Feedback)
		.set(
			input.status === 'closed'
				? { status: 'closed', closedAt: new Date(), closedById: input.agentId }
				: { status: 'open', closedAt: null, closedById: null },
		)
		.where(eq(Feedback.id, row.id))
	await auditSupportAction({
		action: AuditAction.SUPPORT_REQUEST_STATUS_CHANGED,
		agentId: input.agentId,
		organizationId: row.organizationId,
		resourceType: 'Feedback',
		resourceId: row.id,
		details: `Support request ${input.status === 'closed' ? 'closed' : 'reopened'}`,
		metadata: { status: input.status, side: 'support' },
		request: input.request,
	})
	return 'ok'
}
