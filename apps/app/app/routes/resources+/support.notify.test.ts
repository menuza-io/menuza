import { Feedback, FeedbackMessage, Notification, db, eq } from '@repo/database'
import type * as EmailModule from '@repo/email'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

const sendEmailMock = vi.hoisted(() => vi.fn())

vi.mock('@repo/email', async (importOriginal) => ({
	...(await importOriginal<typeof EmailModule>()),
	sendEmail: sendEmailMock,
}))

import { SUPPORT_REPLY_NOTIFICATION_TYPE } from '#app/utils/support-alerts.ts'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { action } from './support.notify.ts'

function call(body: unknown, authorized = true) {
	return action({
		request: new Request('http://localhost:3001/resources/support/notify', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(authorized
					? { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }
					: {}),
			},
			body: JSON.stringify(body),
		}),
		params: {},
		context: new RouterContextProvider(),
		unstable_pattern: '/resources/support/notify',
	} as never)
}

async function requestWithReply(replyText: string) {
	const { user, organization } = await setupTestOrgWithUser('admin')
	const [request] = await db
		.insert(Feedback)
		.values({
			userId: user.id,
			organizationId: organization.id,
			kind: 'support',
			type: 'SUPPORT',
			message: 'My question',
			lastMessageAt: new Date(),
			lastMessageSide: 'member',
		})
		.returning()
	const [reply] = await db
		.insert(FeedbackMessage)
		.values({ feedbackId: request!.id, side: 'support', body: replyText })
		.returning()
	return { user, organization, request: request!, reply: reply! }
}

beforeEach(() => {
	sendEmailMock.mockReset()
	sendEmailMock.mockResolvedValue({
		status: 'success',
		data: { id: 'email_1' },
	})
})

describe('support reply notice (#406)', () => {
	it('is for Admin only: no token, no notice', async () => {
		const { request, reply } = await requestWithReply('Secret reply words')
		const response = (await call(
			{ feedbackId: request.id, messageId: reply.id },
			false,
		).catch((thrown: unknown) => thrown)) as Response
		expect(response.status).toBe(401)
		expect(sendEmailMock).not.toHaveBeenCalled()
	})

	it('tells the sender once, in the app and by email, without the reply text', async () => {
		const { user, organization, request, reply } =
			await requestWithReply('Secret reply words')
		const first = (await call({
			feedbackId: request.id,
			messageId: reply.id,
		})) as Response
		expect(await first.json()).toEqual({ inApp: 1, email: true })

		const [notification] = await db
			.select()
			.from(Notification)
			.where(eq(Notification.userId, user.id))
		expect(notification).toMatchObject({
			type: SUPPORT_REPLY_NOTIFICATION_TYPE,
			organizationId: organization.id,
			entityId: reply.id,
			isRead: false,
		})
		expect(JSON.parse(notification!.payload)).toEqual({
			orgSlug: organization.slug,
			requestId: request.id,
		})
		expect(notification!.payload).not.toContain('Secret reply words')
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
		expect(JSON.stringify(sendEmailMock.mock.calls)).not.toContain(
			'Secret reply words',
		)

		// A retried delivery tells nobody twice.
		const second = (await call({
			feedbackId: request.id,
			messageId: reply.id,
		})) as Response
		expect(await second.json()).toEqual({ inApp: 0, email: false })
		expect(sendEmailMock).toHaveBeenCalledTimes(1)
	})

	it('refuses a field outside the ids', async () => {
		const { request, reply } = await requestWithReply('x')
		const response = (await call({
			feedbackId: request.id,
			messageId: reply.id,
			text: 'the reply',
		})) as Response
		expect(response.status).toBe(400)
	})
})
