import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brand } from '@repo/config/brand'
import { sendSms } from '@repo/sms'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	discountIssuedCodes,
	getTenantDb,
	marketingCampaigns,
	marketingMessages,
	marketingTestSends,
	provisionTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import {
	cancelCampaign,
	RETARGET_MIN_AGE_MS,
	updateCampaign,
} from '../services/campaign-actions.ts'
import {
	audienceRule,
	claimBroadcast,
	runBroadcastTick,
} from '../services/broadcast-dispatch.ts'
import { emailConsentHash } from '../services/marketing-audience.ts'
import { operatorRoutes } from './operator.ts'

vi.mock('@repo/email', () => ({
	getOciMarketingMetrics: vi.fn().mockResolvedValue(null),
	isOciEngagementLoggingConfigured: vi.fn().mockReturnValue(false),
}))
vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockResolvedValue({ success: true }),
}))
vi.mock('../lib/marketing-notify.ts', () => ({
	postMarketingNotify: vi.fn().mockResolvedValue({ status: 'delivered' }),
}))
vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({ status: 'success' }),
}))

const orgId = 'clw9x0a12000008l00actns01'
const operatorSecret = 'test-operator-secret-123456789'
const HOUR = 3_600_000

function mint(claims: Record<string, unknown> = {}) {
	return new SignJWT({
		orgId,
		role: 'operator',
		area: 'marketing',
		sub: 'user-1',
		canUpdate: true,
		canDelete: true,
		...claims,
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('1h')
		.sign(new TextEncoder().encode(operatorSecret))
}

describe('broadcast actions: edit, cancel, delete, duplicate, re-send, test-send', () => {
	let tempDir: string
	let app: Hono
	let db: TenantDatabase

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-actions-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.JWT_SECRET = operatorSecret
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret
		await provisionTenantDb(orgId)
		db = await getTenantDb(orgId)
		app = new Hono()
		app.route('/operator', operatorRoutes)
		vi.mocked(sendTenantEmail).mockReset()
		vi.mocked(sendTenantEmail).mockResolvedValue({ status: 'success' } as never)
		vi.mocked(sendSms).mockClear()
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	async function call(
		method: string,
		route: string,
		body?: unknown,
		token?: string,
	) {
		return app.request(`/operator/marketing${route}`, {
			method,
			headers: {
				Authorization: `Bearer ${token ?? (await mint())}`,
				'Content-Type': 'application/json',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	}

	async function campaign(
		values: Partial<typeof marketingCampaigns.$inferInsert> = {},
	) {
		const id = randomUUID()
		await db.insert(marketingCampaigns).values({
			id,
			name: 'Promo',
			channel: 'email',
			subject: 'Hi',
			content: 'Hello {{name}}',
			status: 'Draft',
			segmentationRules: JSON.stringify({ audience: 'all' }),
			...values,
		})
		return id
	}

	const row = (id: string) =>
		db
			.select()
			.from(marketingCampaigns)
			.where(eq(marketingCampaigns.id, id))
			.get()

	async function subscribed(n: number) {
		const rows = await db
			.insert(customers)
			.values(
				Array.from({ length: n }, (_, i) => ({
					name: `C${i}`,
					email: `c${i}@example.com`,
				})),
			)
			.returning()
		await db.insert(customerSubscriptions).values(
			rows.map((c) => ({
				customerId: c.id,
				topic: 'marketing' as const,
				channel: 'email' as const,
				source: 'signup' as const,
				subscribedAt: new Date(),
				confirmedEmailHash: emailConsentHash(c.email!),
			})),
		)
		return rows
	}

	describe('status transition matrix', () => {
		const statuses = [
			'Draft',
			'Scheduled',
			'Processing',
			'Completed',
			'Failed',
			'Cancelled',
			'SkippedLate',
		] as const
		const expected: Record<
			(typeof statuses)[number],
			{ edit: number; cancel: number; del: number }
		> = {
			Draft: { edit: 200, cancel: 200, del: 200 },
			Scheduled: { edit: 200, cancel: 200, del: 409 },
			Processing: { edit: 409, cancel: 409, del: 409 },
			Completed: { edit: 409, cancel: 409, del: 409 },
			Failed: { edit: 409, cancel: 409, del: 409 },
			Cancelled: { edit: 409, cancel: 409, del: 200 },
			SkippedLate: { edit: 409, cancel: 409, del: 409 },
		}

		it.each(statuses)('%s', async (status) => {
			const scheduledAt = new Date(Date.now() + HOUR)
			const make = () =>
				campaign({
					status,
					scheduledAt: status === 'Scheduled' ? scheduledAt : null,
				})
			const edit = await call('PATCH', `/campaigns/${await make()}`, {
				name: 'New name',
			})
			expect(edit.status, `edit ${status}`).toBe(expected[status].edit)
			const cancel = await call('POST', `/campaigns/${await make()}/cancel`)
			expect(cancel.status, `cancel ${status}`).toBe(expected[status].cancel)
			const del = await call('DELETE', `/campaigns/${await make()}`)
			expect(del.status, `delete ${status}`).toBe(expected[status].del)
		})

		it('names the reason: a Processing campaign is campaign_already_sending', async () => {
			const id = await campaign({ status: 'Processing' })
			for (const [method, route, body] of [
				['PATCH', `/campaigns/${id}`, { name: 'x' }],
				['POST', `/campaigns/${id}/cancel`, undefined],
				['DELETE', `/campaigns/${id}`, undefined],
			] as const) {
				const res = await call(method, route, body)
				expect(res.status).toBe(409)
				expect(await res.json()).toEqual({ error: 'campaign_already_sending' })
			}
			expect((await row(id))?.name).toBe('Promo')
		})

		it('answers 404 for a campaign that does not exist', async () => {
			expect((await call('POST', '/campaigns/nope/cancel')).status).toBe(404)
			expect((await call('DELETE', '/campaigns/nope')).status).toBe(404)
			expect(
				(await call('PATCH', '/campaigns/nope', { name: 'x' })).status,
			).toBe(404)
			expect((await call('POST', '/campaigns/nope/duplicate')).status).toBe(404)
			expect((await call('POST', '/campaigns/nope/retarget', {})).status).toBe(
				404,
			)
		})
	})

	describe('compare-and-set against the tick', () => {
		it('an edit that loses the race to the tick claim changes nothing', async () => {
			const now = Date.now()
			const id = await campaign({
				status: 'Scheduled',
				scheduledAt: new Date(now - 1000),
			})
			// The tick claims the campaign between the edit's read and its write.
			const result = await updateCampaign(db, id, { name: 'Edited' }, now, {
				afterRead: async () => {
					expect(await claimBroadcast(db, id, now)).not.toBeNull()
				},
			})

			expect(result).toEqual({ ok: false, error: 'campaign_already_sending' })
			const after = await row(id)
			expect(after?.status).toBe('Processing')
			expect(after?.name).toBe('Promo')
		})

		it('a cancel that wins keeps the tick from ever sending it', async () => {
			const now = Date.now()
			await subscribed(1)
			const id = await campaign({
				status: 'Scheduled',
				scheduledAt: new Date(now - 1000),
			})
			expect((await cancelCampaign(db, id, now)).ok).toBe(true)

			expect(await claimBroadcast(db, id, now)).toBeNull()
			const result = await runBroadcastTick(orgId, db, now)
			expect(result.claimed).toBe(0)
			expect(vi.mocked(sendTenantEmail)).not.toHaveBeenCalled()
			expect((await row(id))?.status).toBe('Cancelled')
		})

		it('a cancel that arrives after the claim is refused', async () => {
			const now = Date.now()
			const id = await campaign({
				status: 'Scheduled',
				scheduledAt: new Date(now - 1000),
			})
			expect(await claimBroadcast(db, id, now)).not.toBeNull()
			expect(await cancelCampaign(db, id, now)).toEqual({
				ok: false,
				error: 'campaign_already_sending',
			})
			expect((await row(id))?.status).toBe('Processing')
		})
	})

	describe('edit', () => {
		it('changes the audience without dropping other stored rules', async () => {
			for (const stored of [
				{ audience: 'all', tag: 'vip' },
				JSON.stringify({ audience: 'all', tag: 'vip' }),
			]) {
				const id = await campaign({
					status: 'Draft',
					segmentationRules: stored as never,
				})
				expect(
					(await call('PATCH', `/campaigns/${id}`, { audience: 'verified' }))
						.status,
				).toBe(200)
				expect((await row(id))?.segmentationRules).toEqual({
					audience: 'verified',
					tag: 'vip',
				})
			}
		})

		it('edits a Draft and re-checks the coupon pairing', async () => {
			const id = await campaign({ status: 'Draft' })
			const res = await call('PATCH', `/campaigns/${id}`, {
				name: 'Fixed typo',
				subject: 'Lunch',
				content: 'Come eat',
				audience: 'verified',
			})
			expect(res.status).toBe(200)
			const after = await row(id)
			expect(after).toMatchObject({
				name: 'Fixed typo',
				subject: 'Lunch',
				content: 'Come eat',
				status: 'Draft',
			})
			expect(audienceRule(after?.segmentationRules)).toBe('verified')

			// A coupon tag with no coupon, and a coupon with no tag, are refused.
			const tagOnly = await call('PATCH', `/campaigns/${id}`, {
				content: 'Code {{couponCode}}',
			})
			expect(tagOnly.status).toBe(400)
			const offerOnly = await call('PATCH', `/campaigns/${id}`, {
				discountOffer: { mode: 'shared', discountId: 'd1', code: 'SAVE10' },
			})
			expect(offerOnly.status).toBe(400)
			expect((await row(id))?.content).toBe('Come eat')
		})

		it('schedules, un-schedules, and refuses a time in the past', async () => {
			const id = await campaign({ status: 'Draft' })
			const when = new Date(Date.now() + 2 * HOUR).toISOString()
			expect(
				(await call('PATCH', `/campaigns/${id}`, { scheduledAt: when })).status,
			).toBe(200)
			expect(await row(id)).toMatchObject({ status: 'Scheduled' })

			const past = await call('PATCH', `/campaigns/${id}`, {
				scheduledAt: new Date(Date.now() - 1000).toISOString(),
			})
			expect(past.status).toBe(400)
			expect(await past.json()).toEqual({ error: 'scheduled_in_past' })
			expect((await row(id))?.status).toBe('Scheduled')

			expect(
				(await call('PATCH', `/campaigns/${id}`, { scheduledAt: null })).status,
			).toBe(200)
			expect(await row(id)).toMatchObject({
				status: 'Draft',
				scheduledAt: null,
			})
		})

		it('stores the late window the operator chose, within 1 to 72 hours', async () => {
			const id = await campaign({ status: 'Draft' })
			expect(
				(await call('PATCH', `/campaigns/${id}`, { lateAfterMinutes: 120 }))
					.status,
			).toBe(200)
			expect((await row(id))?.lateAfterMinutes).toBe(120)
			for (const bad of [30, 5000, 1.5]) {
				expect(
					(await call('PATCH', `/campaigns/${id}`, { lateAfterMinutes: bad }))
						.status,
				).toBe(400)
			}
		})

		it('sends now from a Draft, once', async () => {
			await subscribed(2)
			const id = await campaign({ status: 'Draft' })
			expect(
				(await call('PATCH', `/campaigns/${id}`, { sendNow: true })).status,
			).toBe(200)
			await vi.waitFor(async () =>
				expect((await row(id))?.status).toBe('Completed'),
			)
			expect(vi.mocked(sendTenantEmail)).toHaveBeenCalledTimes(2)
			// It cannot be started a second time.
			expect(
				(await call('PATCH', `/campaigns/${id}`, { sendNow: true })).status,
			).toBe(409)
		})

		it('refuses fields it does not know, a channel change, and a plain member', async () => {
			const id = await campaign({ status: 'Draft' })
			expect(
				(await call('PATCH', `/campaigns/${id}`, { status: 'Completed' }))
					.status,
			).toBe(400)
			expect(
				(await call('PATCH', `/campaigns/${id}`, { channel: 'sms' })).status,
			).toBe(400)
			const readOnly = await mint({ canUpdate: false, canDelete: false })
			expect(
				(await call('PATCH', `/campaigns/${id}`, { name: 'x' }, readOnly))
					.status,
			).toBe(403)
			expect((await row(id))?.status).toBe('Draft')
		})

		it('keeps SMS to verified customers', async () => {
			const id = await campaign({
				status: 'Draft',
				channel: 'sms',
				subject: null,
			})
			expect(
				(await call('PATCH', `/campaigns/${id}`, { audience: 'unverified' }))
					.status,
			).toBe(400)
		})
	})

	describe('reading the message back', () => {
		it('returns the saved audience and settings, and no recipient', async () => {
			const id = await campaign({ status: 'Draft', lateAfterMinutes: 90 })
			await call('PATCH', `/campaigns/${id}`, { audience: 'verified' })
			const people = await subscribed(1)
			await db.insert(marketingMessages).values({
				campaignId: id,
				customerId: people[0]!.id,
				channel: 'email',
				status: 'Sent',
			})

			const res = await call('GET', `/campaigns/${id}/message`)
			expect(res.status).toBe(200)
			const { campaign: message } = (await res.json()) as {
				campaign: Record<string, unknown>
			}
			expect(message).toMatchObject({
				id,
				status: 'Draft',
				audience: 'verified',
				lateAfterMinutes: 90,
				retargetedByCampaignId: null,
			})
			expect(JSON.stringify(message)).not.toContain('example.com')
			expect(message).not.toHaveProperty('recipients')

			// The detail page reads the same audience.
			const detail = await call('GET', `/campaigns/${id}`)
			expect(
				((await detail.json()) as { campaign: { audience: string } }).campaign
					.audience,
			).toBe('verified')
		})
	})

	describe('another organization', () => {
		it('cannot cancel, edit, delete, duplicate or re-send this one\u2019s broadcast', async () => {
			const id = await campaign({ status: 'Draft' })
			const otherOrg = 'clw9x0a12000008l00actns02'
			await provisionTenantDb(otherOrg)
			try {
				const token = await mint({ orgId: otherOrg })
				for (const [method, route, body] of [
					['POST', `/campaigns/${id}/cancel`, undefined],
					['PATCH', `/campaigns/${id}`, { name: 'Hijacked' }],
					['DELETE', `/campaigns/${id}`, undefined],
					['POST', `/campaigns/${id}/duplicate`, undefined],
					['POST', `/campaigns/${id}/retarget`, {}],
				] as const) {
					const res = await call(method, route, body, token)
					expect(res.status, `${method} ${route}`).toBe(404)
				}
				expect(await row(id)).toMatchObject({ name: 'Promo', status: 'Draft' })
			} finally {
				await destroyTenantDb(otherOrg).catch(() => {})
			}
		})
	})

	// The App's PII guard lets a PATCH or DELETE of a broadcast through because
	// these answers never carry the recipient list. This is what pins that.
	describe('writes never answer with recipients', () => {
		it('returns only small status objects', async () => {
			const people = await subscribed(1)
			const id = await campaign({ status: 'Draft' })
			await db.insert(marketingMessages).values({
				campaignId: id,
				customerId: people[0]!.id,
				channel: 'email',
				status: 'Sent',
			})
			const keys = async (res: Response) =>
				Object.keys((await res.json()) as object).sort()

			expect(
				await keys(await call('PATCH', `/campaigns/${id}`, { name: 'x' })),
			).toEqual(['campaignId', 'status', 'success'])
			expect(
				await keys(await call('POST', `/campaigns/${id}/duplicate`)),
			).toEqual(['campaignId', 'success'])
			expect(await keys(await call('POST', `/campaigns/${id}/cancel`))).toEqual(
				['status', 'success'],
			)
			const draft = await campaign({ status: 'Draft' })
			expect(await keys(await call('DELETE', `/campaigns/${draft}`))).toEqual([
				'success',
			])
		})
	})

	describe('where a discount is promised (server-side door)', () => {
		const offer = JSON.stringify({
			mode: 'shared',
			discountId: 'disc_a',
			code: 'SAVE10',
		})

		it('lists the broadcasts that offer it, by the server-side token only', async () => {
			const id = await campaign({
				status: 'Scheduled',
				scheduledAt: new Date(Date.now() + HOUR),
				discountOffer: offer,
				content: 'Code {{couponCode}}',
			})
			await campaign({ status: 'Draft', discountOffer: offer })
			const server = await new SignJWT({
				orgId,
				role: 'operator',
				sub: 'user-1',
			})
				.setProtectedHeader({ alg: 'HS256' })
				.setAudience('tenant-api-operator')
				.setIssuer(brand.shortName)
				.setExpirationTime('1h')
				.sign(new TextEncoder().encode(operatorSecret))
			const res = await call(
				'GET',
				'/discount-used-in?discountId=disc_a',
				undefined,
				server,
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as { broadcasts: Array<{ id: string }> }
			expect(body.broadcasts.map((b) => b.id)).toEqual([id])

			// A token bound to an area (the browser's) is refused.
			expect(
				(await call('GET', '/discount-used-in?discountId=disc_a')).status,
			).toBe(401)
			expect(
				(
					await call(
						'GET',
						'/discount-used-in?discountId=a%20b',
						undefined,
						server,
					)
				).status,
			).toBe(400)
		})
	})

	describe('delete', () => {
		it('needs the delete claim', async () => {
			const id = await campaign({ status: 'Draft' })
			const noDelete = await mint({ canDelete: false })
			expect(
				(await call('DELETE', `/campaigns/${id}`, undefined, noDelete)).status,
			).toBe(403)
			expect(await row(id)).toBeTruthy()
			expect((await call('DELETE', `/campaigns/${id}`)).status).toBe(200)
			expect(await row(id)).toBeUndefined()
		})
	})

	describe('duplicate', () => {
		it.each([
			'Draft',
			'Scheduled',
			'Completed',
			'Failed',
			'Cancelled',
			'SkippedLate',
		] as const)(
			'copies a %s campaign into an unscheduled, unlinked Draft',
			async (status) => {
				const offer = JSON.stringify({
					mode: 'shared',
					discountId: 'd1',
					code: 'SAVE10',
				})
				const id = await campaign({
					status,
					name: 'Lunch special',
					subject: 'Today',
					content: 'Code {{couponCode}}',
					contentBlocks: '[]',
					contentHtml: '<p>Code {{couponCode}}</p>',
					discountOffer: offer,
					scheduledAt: new Date(Date.now() - HOUR),
					lateAfterMinutes: 90,
				})
				const res = await call('POST', `/campaigns/${id}/duplicate`)
				expect(res.status).toBe(200)
				const { campaignId } = (await res.json()) as { campaignId: string }
				const copy = await row(campaignId)
				expect(copy).toMatchObject({
					name: 'Lunch special (copy)',
					status: 'Draft',
					subject: 'Today',
					content: 'Code {{couponCode}}',
					contentHtml: '<p>Code {{couponCode}}</p>',
					discountOffer: offer,
					scheduledAt: null,
					lateAfterMinutes: 90,
					retargetOfCampaignId: null,
				})
				expect(campaignId).not.toBe(id)
			},
		)
	})

	describe('re-send to non-openers', () => {
		const old = () => new Date(Date.now() - RETARGET_MIN_AGE_MS - HOUR)

		it('creates one linked Draft, with a new subject if given, and only once', async () => {
			const id = await campaign({ status: 'Completed', updatedAt: old() })
			const res = await call('POST', `/campaigns/${id}/retarget`, {
				subject: 'Did you miss this?',
			})
			expect(res.status).toBe(200)
			const { campaignId } = (await res.json()) as { campaignId: string }
			expect(await row(campaignId)).toMatchObject({
				status: 'Draft',
				subject: 'Did you miss this?',
				retargetOfCampaignId: id,
				name: 'Promo (re-send)',
			})

			const again = await call('POST', `/campaigns/${id}/retarget`, {})
			expect(again.status).toBe(409)
			expect(await again.json()).toEqual({ error: 'already_retargeted' })
		})

		it('two clicks at once make exactly one', async () => {
			const id = await campaign({ status: 'Completed', updatedAt: old() })
			const [a, b] = await Promise.all([
				call('POST', `/campaigns/${id}/retarget`, {}),
				call('POST', `/campaigns/${id}/retarget`, {}),
			])
			expect([a.status, b.status].sort()).toEqual([200, 409])
			const links = await db
				.select({ id: marketingCampaigns.id })
				.from(marketingCampaigns)
				.where(eq(marketingCampaigns.retargetOfCampaignId, id))
			expect(links).toHaveLength(1)
		})

		it('waits 48 hours, and only follows a Completed email broadcast', async () => {
			const fresh = await campaign({
				status: 'Completed',
				updatedAt: new Date(),
			})
			const tooEarly = await call('POST', `/campaigns/${fresh}/retarget`, {})
			expect(tooEarly.status).toBe(409)
			expect(await tooEarly.json()).toEqual({ error: 'retarget_too_early' })

			const sms = await campaign({
				status: 'Completed',
				channel: 'sms',
				updatedAt: old(),
			})
			const smsRes = await call('POST', `/campaigns/${sms}/retarget`, {})
			expect(smsRes.status).toBe(400)
			expect(await smsRes.json()).toEqual({ error: 'retarget_not_supported' })

			for (const status of [
				'Draft',
				'Scheduled',
				'Processing',
				'Failed',
				'Cancelled',
			] as const) {
				const other = await campaign({ status, updatedAt: old() })
				const res = await call('POST', `/campaigns/${other}/retarget`, {})
				expect(res.status, status).toBe(status === 'Processing' ? 409 : 409)
				expect(((await res.json()) as { error: string }).error, status).toBe(
					'campaign_not_completed',
				)
			}
		})

		it('counts only customers who got it, did not open or click, and are still subscribed', async () => {
			const people = await subscribed(4)
			const original = await campaign({ status: 'Completed', updatedAt: old() })
			await db.insert(marketingMessages).values([
				{
					campaignId: original,
					customerId: people[0]!.id,
					channel: 'email',
					status: 'Sent',
				},
				{
					campaignId: original,
					customerId: people[1]!.id,
					channel: 'email',
					status: 'Opened',
					openedAt: new Date(),
				},
				{
					campaignId: original,
					customerId: people[2]!.id,
					channel: 'email',
					status: 'Sent',
				},
				{
					campaignId: original,
					customerId: people[3]!.id,
					channel: 'email',
					status: 'Failed',
				},
			])
			await db
				.update(customerSubscriptions)
				.set({ unsubscribedAt: new Date() })
				.where(eq(customerSubscriptions.customerId, people[2]!.id))

			const res = await call(
				'GET',
				`/audience-count?channel=email&audience=all&retargetOf=${original}`,
			)
			expect(await res.json()).toEqual({ count: 1 })
			const all = await call('GET', '/audience-count?channel=email')
			expect(await all.json()).toEqual({ count: 3 })
		})
	})

	describe('test send', () => {
		const emailBody = {
			channel: 'email',
			subject: 'Lunch for {{firstName}}',
			content: 'Hi {{firstName}}, code {{couponCode}}',
			contentHtml: '<p>Hi {{firstName}}, code {{couponCode}}</p>',
		}
		// What the App signs into a server-only token: the recipient is a claim,
		// never part of the request.
		const asOwner = (claims: Record<string, unknown> = {}) =>
			mint({ testEmail: 'owner@restaurant.test', ...claims })

		it('emails the operator with sample values and a [Test] subject, and records nothing about it', async () => {
			const res = await call('POST', '/test-send', emailBody, await asOwner())
			expect(res.status).toBe(200)

			expect(vi.mocked(sendTenantEmail)).toHaveBeenCalledTimes(1)
			const sent = vi.mocked(sendTenantEmail).mock.calls[0]![0]
			expect(sent.to).toBe('owner@restaurant.test')
			expect(sent.subject).toBe('[Test] Lunch for Alex')
			expect(sent.html).toContain('code SAMPLE-CODE')
			expect(sent.html).not.toContain('{{')
			// No signed unsubscribe link and no campaign headers on a test.
			expect(sent.extraHeaders).toBeUndefined()
			expect(sent.context).toBeUndefined()

			// It never becomes a message, a metric, a cap unit or a minted code.
			expect(await db.select().from(marketingMessages)).toEqual([])
			expect(await db.select().from(discountIssuedCodes)).toEqual([])
			const metrics = await call('GET', '/metrics')
			expect(
				((await metrics.json()) as { emailsSent?: number }).emailsSent ?? 0,
			).toBe(0)
		})

		it('does not keep the operator’s address in the region', async () => {
			await call('POST', '/test-send', emailBody, await asOwner())
			const dump = JSON.stringify({
				sends: await db.select().from(marketingTestSends),
				campaigns: await db.select().from(marketingCampaigns),
				messages: await db.select().from(marketingMessages),
				customers: await db.select().from(customers),
			})
			expect(dump).not.toContain('owner@restaurant.test')
			const [stored] = await db.select().from(marketingTestSends)
			expect(Object.keys(stored!).sort()).toEqual([
				'channel',
				'id',
				'operatorId',
				'sentAt',
			])
			expect(stored?.operatorId).toBe('user-1')
		})

		it('texts the operator’s verified phone with a [Test] prefix', async () => {
			const res = await call(
				'POST',
				'/test-send',
				{ channel: 'sms', content: 'Hi {{firstName}}' },
				await mint({ testPhone: '+15551234567' }),
			)
			expect(res.status).toBe(200)
			expect(sendSms).toHaveBeenCalledWith({
				to: '+15551234567',
				message: '[Test] Hi Alex',
			})
			expect(vi.mocked(sendTenantEmail)).not.toHaveBeenCalled()
		})

		it('allows 10 an hour per operator and refuses the 11th with test_send_limit', async () => {
			for (let i = 0; i < 10; i++) {
				expect(
					(await call('POST', '/test-send', emailBody, await asOwner())).status,
					`send ${i + 1}`,
				).toBe(200)
			}
			const refused = await call(
				'POST',
				'/test-send',
				emailBody,
				await asOwner(),
			)
			expect(refused.status).toBe(429)
			expect(await refused.json()).toEqual({ error: 'test_send_limit' })
			expect(vi.mocked(sendTenantEmail)).toHaveBeenCalledTimes(10)

			// Another operator has their own allowance.
			const other = await asOwner({ sub: 'user-2' })
			expect((await call('POST', '/test-send', emailBody, other)).status).toBe(
				200,
			)
		})

		it('counts a rolling hour: an old test no longer counts', async () => {
			await db.insert(marketingTestSends).values(
				Array.from({ length: 10 }, () => ({
					operatorId: 'user-1',
					channel: 'email' as const,
					sentAt: new Date(Date.now() - 61 * 60_000),
				})),
			)
			expect(
				(await call('POST', '/test-send', emailBody, await asOwner())).status,
			).toBe(200)
		})

		it('ten at once cannot all pass the limit', async () => {
			const owner = await asOwner()
			const results = await Promise.all(
				Array.from({ length: 14 }, () =>
					call('POST', '/test-send', emailBody, owner),
				),
			)
			expect(results.filter((r) => r.status === 200)).toHaveLength(10)
			expect(results.filter((r) => r.status === 429)).toHaveLength(4)
		})

		it('never takes a recipient from the request: a body address is refused and the token decides', async () => {
			const owner = await asOwner()
			// A browser cannot name a recipient, even alongside a valid token.
			expect(
				(
					await call(
						'POST',
						'/test-send',
						{ ...emailBody, to: { email: 'victim@elsewhere.test' } },
						owner,
					)
				).status,
			).toBe(400)
			expect(vi.mocked(sendTenantEmail)).not.toHaveBeenCalled()

			// A token without the signed recipient (every browser token) cannot test.
			const browserToken = await mint()
			expect(
				(await call('POST', '/test-send', emailBody, browserToken)).status,
			).toBe(403)
			// A forged, malformed or wrong-channel claim is no recipient either.
			for (const claims of [
				{ testEmail: 'not-an-address' },
				{ testEmail: 42 },
				{ testPhone: '+15551234567' },
			]) {
				expect(
					(await call('POST', '/test-send', emailBody, await mint(claims)))
						.status,
				).toBe(403)
			}
			expect(
				(
					await call(
						'POST',
						'/test-send',
						{ channel: 'sms', content: 'hi' },
						await mint({ testPhone: '5551234567' }),
					)
				).status,
			).toBe(403)
			expect(vi.mocked(sendTenantEmail)).not.toHaveBeenCalled()
			expect(sendSms).not.toHaveBeenCalled()
			expect(await db.select().from(marketingTestSends)).toEqual([])
		})

		it('refuses an unknown field, an invalid body, no sub and a read-only token', async () => {
			const owner = await asOwner()
			expect(
				(
					await call(
						'POST',
						'/test-send',
						{ ...emailBody, campaignId: 'c1' },
						owner,
					)
				).status,
			).toBe(400)
			expect(
				(await call('POST', '/test-send', { channel: 'email' }, owner)).status,
			).toBe(400)
			const noSub = await new SignJWT({
				orgId,
				role: 'operator',
				area: 'marketing',
				canUpdate: true,
				testEmail: 'owner@restaurant.test',
			})
				.setProtectedHeader({ alg: 'HS256' })
				.setAudience('tenant-api-operator')
				.setIssuer(brand.shortName)
				.setExpirationTime('1h')
				.sign(new TextEncoder().encode(operatorSecret))
			expect((await call('POST', '/test-send', emailBody, noSub)).status).toBe(
				401,
			)
			const readOnly = await asOwner({ canUpdate: false })
			expect(
				(await call('POST', '/test-send', emailBody, readOnly)).status,
			).toBe(403)
			expect(vi.mocked(sendTenantEmail)).not.toHaveBeenCalled()
		})

		it('caps the organization too, so several operators cannot multiply the limit', async () => {
			let sent = 0
			for (let operator = 1; operator <= 4; operator++) {
				const token = await asOwner({ sub: `user-${operator}` })
				for (let i = 0; i < 10; i++) {
					if (
						(await call('POST', '/test-send', emailBody, token)).status === 200
					)
						sent++
				}
			}
			expect(sent).toBe(30)
			const refused = await call(
				'POST',
				'/test-send',
				emailBody,
				await asOwner({ sub: 'user-9' }),
			)
			expect(refused.status).toBe(429)
			expect(await refused.json()).toEqual({ error: 'test_send_limit' })
		})

		it('reports a failed send as test_send_failed', async () => {
			vi.mocked(sendTenantEmail).mockResolvedValueOnce({
				status: 'error',
				error: { message: 'boom' },
			} as never)
			const res = await call('POST', '/test-send', emailBody, await asOwner())
			expect(res.status).toBe(502)
			expect(await res.json()).toEqual({ error: 'test_send_failed' })
		})
	})

	describe('create', () => {
		it('saves a Draft that is never sent, and refuses a time in the past', async () => {
			const draft = await call('POST', '/campaigns', {
				name: 'Later',
				channel: 'email',
				subject: 'Hi',
				content: 'Hello',
				saveAsDraft: true,
				lateAfterMinutes: 120,
			})
			expect(draft.status).toBe(200)
			const { campaignId, status } = (await draft.json()) as {
				campaignId: string
				status: string
			}
			expect(status).toBe('Draft')
			expect(await row(campaignId)).toMatchObject({
				status: 'Draft',
				lateAfterMinutes: 120,
			})
			expect(vi.mocked(sendTenantEmail)).not.toHaveBeenCalled()

			const past = await call('POST', '/campaigns', {
				name: 'Then',
				channel: 'email',
				content: 'Hello',
				scheduledAt: new Date(Date.now() - 60_000).toISOString(),
			})
			expect(past.status).toBe(400)
			expect(await past.json()).toEqual({ error: 'scheduled_in_past' })
		})
	})
})
