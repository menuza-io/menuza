import { billingPeriod } from '@repo/common/marketing-allowance'
import { db, eq, MarketingSmsSend, Organization } from '@repo/database'
import { reserveSmsSend } from '@repo/marketing/server/sms-allowance'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { describe, expect, it } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { action } from './marketing.sms-allowance.ts'

async function org() {
	const user = await createTestUser()
	const organization = await createTestOrganization(user.id)
	await db
		.update(Organization)
		.set({ planName: 'starter' })
		.where(eq(Organization.id, organization.id))
	return organization.id
}

function call(
	body: unknown,
	options: { authorized?: boolean; method?: string } = {},
) {
	const method = options.method ?? 'POST'
	return action({
		request: new Request(
			'http://localhost:3001/resources/marketing/sms-allowance',
			{
				method,
				headers: {
					'content-type': 'application/json',
					...(options.authorized === false
						? {}
						: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }),
				},
				body: method === 'GET' ? undefined : JSON.stringify(body),
			},
		),
		params: {},
		context: new RouterContextProvider(),
		unstable_pattern: '',
	} as never) as Promise<Response>
}

let counter = 0
const id = () => `campaign_route_${Date.now()}_${counter++}`

describe('POST /resources/marketing/sms-allowance (#247)', () => {
	it('needs the internal command token', async () => {
		const organizationId = await org()
		const res = await call(
			{ orgId: organizationId, campaignId: id(), action: 'start' },
			{ authorized: false },
		)
		expect(res.status).toBe(401)
		expect((await call({}, { method: 'GET' })).status).toBe(405)
	})

	it('refuses a body with an extra field or a missing one', async () => {
		const organizationId = await org()
		for (const body of [
			{
				orgId: organizationId,
				campaignId: id(),
				action: 'start',
				phone: '+1555',
			},
			{ orgId: organizationId, action: 'start' },
			{ orgId: organizationId, campaignId: id(), action: 'steal' },
		]) {
			expect((await call(body)).status).toBe(400)
		}
	})

	it('starting a text broadcast spends one send; the same broadcast again spends none', async () => {
		const organizationId = await org()
		const campaignId = id()
		for (let i = 0; i < 2; i++) {
			const res = await call({
				orgId: organizationId,
				campaignId,
				action: 'start',
			})
			expect(await res.json()).toEqual({ ok: true })
		}
		const [row] = await db
			.select()
			.from(MarketingSmsSend)
			.where(eq(MarketingSmsSend.campaignId, campaignId))
		expect(row?.state).toBe('started')
	})

	it('with none left the answer is "none until the reset", with only the instant', async () => {
		const organizationId = await org()
		const now = Date.now()
		for (let i = 0; i < 4; i++) {
			await reserveSmsSend({
				organizationId,
				campaignId: id(),
				startsAtMs: now,
			})
		}
		const res = await call({
			orgId: organizationId,
			campaignId: id(),
			action: 'start',
		})
		expect(await res.json()).toEqual({
			ok: false,
			reason: 'exhausted',
			resetsAt: billingPeriod(now).resetsAt,
		})
	})

	it('release gives the send back once, and an unknown organization is a 404', async () => {
		const organizationId = await org()
		const campaignId = id()
		await reserveSmsSend({ organizationId, campaignId, startsAtMs: Date.now() })
		expect(
			await (
				await call({ orgId: organizationId, campaignId, action: 'release' })
			).json(),
		).toEqual({ ok: true })
		const [row] = await db
			.select()
			.from(MarketingSmsSend)
			.where(eq(MarketingSmsSend.campaignId, campaignId))
		expect(row?.state).toBe('released')
		const missing = await call({
			orgId: 'nope',
			campaignId: id(),
			action: 'start',
		})
		expect(missing.status).toBe(404)
	})
})
