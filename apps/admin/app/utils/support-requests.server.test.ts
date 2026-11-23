import { randomUUID } from 'node:crypto'
import { AuditAction, auditService } from '@repo/audit'
import { isUnreadFor } from '@repo/common/support-requests'
import {
	Feedback,
	FeedbackMessage,
	Organization,
	User,
	db,
	eq,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import * as appService from './app-service.server.ts'
import {
	getRequestThread,
	listRequests,
	replyToRequest,
	setRequestStatus,
} from './support-requests.server.ts'

async function createUser(name: string) {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com`, name })
		.returning()
	return user!
}

async function createRequest(options: { assigneeId?: string } = {}) {
	const member = await createUser('Olivia Owner')
	const id = randomUUID()
	const [organization] = await db
		.insert(Organization)
		.values({ name: `Business ${id.slice(0, 6)}`, slug: `org-${id}` })
		.returning()
	// The member wrote and read it a moment ago.
	const now = new Date(Date.now() - 5_000)
	const [request] = await db
		.insert(Feedback)
		.values({
			userId: member.id,
			organizationId: organization!.id,
			kind: 'support',
			type: 'SUPPORT',
			message: 'How do I pause ordering?',
			subject: 'Pausing',
			context: JSON.stringify({ organizationId: organization!.id, path: '/x' }),
			errorId: 'a1b2c3d4e5f6a7b8',
			assigneeId: options.assigneeId ?? null,
			lastMessageAt: now,
			lastMessageSide: 'member',
			memberReadAt: now,
		})
		.returning()
	return { member, organization: organization!, request: request! }
}

let log: MockInstance<typeof auditService.log>
let post: MockInstance<typeof appService.postToApp>
beforeEach(() => {
	vi.restoreAllMocks()
	log = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
	post = vi.spyOn(appService, 'postToApp').mockResolvedValue({
		status: 'answered',
		response: Response.json({ inApp: 1, email: true }),
	})
})

describe('Admin support requests (#406)', () => {
	it('shows a request with its context and the error reference to look up', async () => {
		const { request, organization } = await createRequest()
		const rows = await listRequests('agent')
		const row = rows.find((item) => item.id === request.id)
		expect(row).toMatchObject({
			kind: 'support',
			status: 'open',
			hasError: true,
			organization: { id: organization.id },
			unread: true,
		})
		const thread = await getRequestThread(request.id)
		expect(thread).toMatchObject({
			errorId: 'a1b2c3d4e5f6a7b8',
			organization: { id: organization.id },
			context: { path: '/x' },
		})
	})

	it("a reply sets the restaurant's unread badge, waits on them, and tells the App with ids only", async () => {
		const agent = await createUser('Sara Support')
		const { request } = await createRequest()

		const result = await replyToRequest({
			agentId: agent.id,
			requestId: request.id,
			body: 'You can pause under Settings',
		})
		expect(result).toMatchObject({ status: 'replied', notified: true })

		const [row] = await db
			.select()
			.from(Feedback)
			.where(eq(Feedback.id, request.id))
		expect(row!.status).toBe('waiting_on_you')
		expect(row!.lastMessageSide).toBe('support')
		expect(isUnreadFor('member', row!)).toBe(true)
		expect(isUnreadFor('support', row!)).toBe(false)

		const replies = await db
			.select()
			.from(FeedbackMessage)
			.where(eq(FeedbackMessage.feedbackId, request.id))
		expect(replies).toHaveLength(1)
		// The App is told which reply, never what it says.
		expect(post).toHaveBeenCalledWith(
			'/resources/support/notify',
			{ feedbackId: request.id, messageId: replies[0]!.id },
			expect.anything(),
		)
		expect(JSON.stringify(post.mock.calls)).not.toContain(
			'pause under Settings',
		)
		// Audited with the agent's name, without the words.
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.SUPPORT_REQUEST_REPLIED,
				userId: agent.id,
				metadata: expect.objectContaining({ agentName: 'Sara Support' }),
			}),
		)
		expect(JSON.stringify(log.mock.calls)).not.toContain('pause under Settings')
	})

	it('keeps the reply when the App cannot be reached', async () => {
		post.mockResolvedValue({ status: 'unreachable' })
		const agent = await createUser('Sara Support')
		const { request } = await createRequest()
		const result = await replyToRequest({
			agentId: agent.id,
			requestId: request.id,
			body: 'Reply',
		})
		expect(result).toMatchObject({ status: 'replied', notified: false })
		const replies = await db
			.select()
			.from(FeedbackMessage)
			.where(eq(FeedbackMessage.feedbackId, request.id))
		expect(replies).toHaveLength(1)
	})

	it('opening a request reads it for support, and closing moves it to closed', async () => {
		const agent = await createUser('Sara Support')
		const { request } = await createRequest()
		await getRequestThread(request.id, { markRead: true })
		const [read] = await db
			.select()
			.from(Feedback)
			.where(eq(Feedback.id, request.id))
		expect(isUnreadFor('support', read!)).toBe(false)

		expect(
			await setRequestStatus({
				agentId: agent.id,
				requestId: request.id,
				status: 'closed',
			}),
		).toBe('ok')
		const [closed] = await db
			.select()
			.from(Feedback)
			.where(eq(Feedback.id, request.id))
		expect(closed).toMatchObject({ status: 'closed', closedById: agent.id })
		expect(log).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.SUPPORT_REQUEST_STATUS_CHANGED,
				metadata: expect.objectContaining({ agentName: 'Sara Support' }),
			}),
		)
	})

	it('filters to the requests routed to me', async () => {
		const agent = await createUser('Sara Support')
		const mine = await createRequest({ assigneeId: agent.id })
		const unassigned = await createRequest()
		const rows = await listRequests(agent.id, { assignee: 'me' })
		expect(rows.map((row) => row.id)).toContain(mine.request.id)
		expect(rows.map((row) => row.id)).not.toContain(unassigned.request.id)
		const none = await listRequests(agent.id, { assignee: 'unassigned' })
		expect(none.map((row) => row.id)).toContain(unassigned.request.id)
	})
})
