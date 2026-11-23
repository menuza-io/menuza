import { randomUUID } from 'node:crypto'
import { AuditAction, auditService } from '@repo/audit'
import {
	applyResendDeliveryEvent,
	getSessionExpirationDate,
	pruneSignInDeliveries,
	recordSignInCodeDelivery,
} from '@repo/auth'
import { Session, SignInCodeDelivery, User, db, eq } from '@repo/database'
import { getTableColumns } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import * as appService from './app-service.server.ts'
import {
	checkPhone,
	endAllSessions,
	lookupSignInHelp,
	parseLookupQuery,
	resendSignInCode,
} from './sign-in-help.server.ts'

async function createUser(name = 'Olivia Owner') {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({ username: id, email: `${id}@example.com`, name })
		.returning()
	return user!
}

let log: MockInstance<typeof auditService.log>
let post: MockInstance<typeof appService.postToApp>
beforeEach(() => {
	vi.restoreAllMocks()
	log = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
	post = vi.spyOn(appService, 'postToApp').mockResolvedValue({
		status: 'answered',
		response: Response.json({}),
	})
})

function resendEvent(type: string, emailId: string, extra: object = {}) {
	return {
		type,
		created_at: new Date().toISOString(),
		data: { email_id: emailId, ...extra },
	}
}

describe('Sign-in help (#246)', () => {
	it('shows a code as sent, then delivered once the provider reports it', async () => {
		const agent = await createUser('Sara Support')
		const operator = await createUser()
		await recordSignInCodeDelivery({
			userId: operator.id,
			purpose: 'reset_password',
			channel: 'email',
			destination: operator.email,
			provider: 'resend',
			providerMessageId: 'em_delivered_1',
		})

		let result = await lookupSignInHelp({
			agentId: agent.id,
			query: operator.email,
		})
		expect(result.status).toBe('ok')
		if (result.status !== 'ok') return
		expect(result.lastSent).toMatchObject({ status: 'sent', channel: 'email' })
		// The page shows a masked address, never the code.
		expect(result.lastSent?.destinationHint).toMatch(/^.\*\*\*@example\.com$/)

		expect(
			await applyResendDeliveryEvent(
				resendEvent('email.delivered', 'em_delivered_1'),
			),
		).toBe(true)
		result = await lookupSignInHelp({
			agentId: agent.id,
			query: operator.email,
		})
		if (result.status !== 'ok') return
		expect(result.lastSent?.status).toBe('delivered')

		// A late "sent" event does not undo "delivered".
		await applyResendDeliveryEvent(resendEvent('email.sent', 'em_delivered_1'))
		result = await lookupSignInHelp({
			agentId: agent.id,
			query: operator.email,
		})
		if (result.status !== 'ok') return
		expect(result.lastSent?.status).toBe('delivered')
	})

	it('shows a bounce with its reason, and ignores events that are not ours', async () => {
		const agent = await createUser('Sara Support')
		const operator = await createUser()
		await recordSignInCodeDelivery({
			userId: operator.id,
			purpose: 'signup',
			channel: 'email',
			destination: operator.email,
			provider: 'resend',
			providerMessageId: 'em_bounce_1',
		})
		await applyResendDeliveryEvent(
			resendEvent('email.bounced', 'em_bounce_1', {
				bounce: { type: 'Permanent', subType: 'General' },
			}),
		)
		expect(
			await applyResendDeliveryEvent(
				resendEvent('email.delivered', 'em_unknown'),
			),
		).toBe(false)
		expect(
			await applyResendDeliveryEvent(
				resendEvent('email.opened', 'em_bounce_1'),
			),
		).toBe(false)
		const result = await lookupSignInHelp({
			agentId: agent.id,
			query: operator.email,
		})
		if (result.status !== 'ok') throw new Error('x')
		expect(result.lastSent).toMatchObject({
			status: 'bounced',
			failureReason: 'permanent general',
		})
	})

	it('identifies a landline and an invalid number', async () => {
		const agent = await createUser('Sara Support')
		for (const [phone, lineType, valid, problem] of [
			['+14155550000', 'landline', true, 'landline'],
			['+14155559999', 'unknown', false, 'invalid'],
		] as const) {
			await recordSignInCodeDelivery({
				purpose: 'alert_recipient',
				channel: 'sms',
				destination: phone,
				provider: 'twilio',
				providerMessageId: `SM${phone.slice(-6)}abcdef`,
				status: 'failed',
				failureReason: '30006',
			})
			post.mockResolvedValue({
				status: 'answered',
				response: Response.json({
					status: 'ok',
					check: { valid, lineType, carrier: 'Acme Telecom' },
				}),
			})
			const outcome = await checkPhone({ agentId: agent.id, phone })
			expect(outcome).toMatchObject({ status: 'ok', problem })
			// The lookup is remembered, so the next look at that number shows it.
			const result = await lookupSignInHelp({ agentId: agent.id, query: phone })
			if (result.status !== 'ok') throw new Error('x')
			expect(result.deliveries[0]).toMatchObject({
				problem,
				failureReason: 'Landline or unreachable carrier (30006)',
			})
		}
		// A phone typed with punctuation is the same number.
		expect(parseLookupQuery('(415) 555-0000')).toEqual({
			kind: 'phone',
			phone: '+14155550000',
		})
	})

	it('says "could not check" when the provider cannot be asked', async () => {
		post.mockResolvedValue({ status: 'unreachable' })
		const agent = await createUser('Sara Support')
		expect(
			await checkPhone({ agentId: agent.id, phone: '+14155550000' }),
		).toEqual({
			status: 'unavailable',
		})
	})

	it('has no column for a code, and never stores one', async () => {
		const names = Object.keys(getTableColumns(SignInCodeDelivery))
		expect(
			names.filter((name) => /code|otp|secret|token|password/i.test(name)),
		).toEqual([])
		// `recordSignInCodeDelivery` takes a destination and a provider id, so even a
		// caller that wanted to could not hand it a code.
		const operator = await createUser()
		await recordSignInCodeDelivery({
			userId: operator.id,
			purpose: 'signup',
			channel: 'email',
			destination: operator.email,
			provider: 'resend',
			providerMessageId: 'em_nocode_1',
		})
		const rows = await db
			.select()
			.from(SignInCodeDelivery)
			.where(eq(SignInCodeDelivery.userId, operator.id))
		expect(JSON.stringify(rows)).not.toContain(operator.email)
	})

	it('keeps history 7 days and prunes after', async () => {
		const agent = await createUser('Sara Support')
		const operator = await createUser()
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
		await recordSignInCodeDelivery({
			userId: operator.id,
			purpose: 'signup',
			channel: 'email',
			destination: operator.email,
			provider: 'resend',
			providerMessageId: 'em_old_1',
			now: eightDaysAgo,
		})
		const result = await lookupSignInHelp({
			agentId: agent.id,
			query: operator.email,
		})
		if (result.status !== 'ok') throw new Error('x')
		expect(result.deliveries).toHaveLength(0)
		expect(await pruneSignInDeliveries()).toBeGreaterThanOrEqual(1)
	})

	it("logs every lookup and action with the support member's name", async () => {
		const agent = await createUser('Sara Support')
		const operator = await createUser()
		await db.insert(Session).values({
			userId: operator.id,
			expirationDate: getSessionExpirationDate(),
		})
		post.mockResolvedValue({
			status: 'answered',
			response: Response.json({ status: 'sent' }),
		})

		await lookupSignInHelp({ agentId: agent.id, query: operator.email })
		await resendSignInCode({
			agentId: agent.id,
			userId: operator.id,
			channel: 'sms',
		})
		const ended = await endAllSessions({
			agentId: agent.id,
			userId: operator.id,
		})
		expect(ended.ended).toBe(1)
		expect(
			await db.select().from(Session).where(eq(Session.userId, operator.id)),
		).toHaveLength(0)

		const actions = log.mock.calls.map(
			([entry]) => (entry as { action: string }).action,
		)
		expect(actions).toEqual([
			AuditAction.SIGN_IN_HELP_LOOKUP,
			AuditAction.SIGN_IN_HELP_RESEND,
			AuditAction.SIGN_IN_HELP_SESSIONS_ENDED,
		])
		for (const [entry] of log.mock.calls) {
			expect(entry).toMatchObject({
				userId: agent.id,
				metadata: expect.objectContaining({ agentName: 'Sara Support' }),
			})
		}
		// The audit trail holds no address and no number.
		expect(JSON.stringify(log.mock.calls)).not.toContain(operator.email)
	})
})
