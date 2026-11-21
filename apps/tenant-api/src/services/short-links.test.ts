/**
 * #159 short links: own-site targets only, a count per link per day and nothing
 * else, disabled links, concurrent clicks, and the links a broadcast text and an
 * automation text carry.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brand } from '@repo/config/brand'
import { SMS_OPT_OUT_PHRASE } from '@repo/common/sms-compliance'
import { sendSms } from '@repo/sms'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	journeyRuns,
	marketingCampaigns,
	marketingJourneys,
	marketingMessages,
	provisionTenantDb,
	shortLinkClicksDaily,
	shortLinks,
	type TenantDatabase,
} from '@repo/tenant-db'
import { bindAppService } from '../lib/app-service.ts'
import { clearOrgEmailSenderCacheForTest } from '../lib/org-email-sender.ts'
import {
	publicShortLinkRoutes,
	shortLinkOperatorRoutes,
} from '../routes/short-links.ts'
import { broadcastLease, dispatchBroadcast } from './broadcast-dispatch.ts'
import { executeJourneyStep } from './journey-service.ts'
import { insertOrder } from './loyalty-test-fixture.ts'
import {
	clickDay,
	ensureShortLink,
	listShortLinks,
	resolveShortLink,
	ShortLinkError,
} from './short-links.ts'

vi.mock('@repo/email', () => ({
	getOciMarketingMetrics: vi.fn().mockResolvedValue(null),
	isOciEngagementLoggingConfigured: vi.fn().mockReturnValue(false),
}))
vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockResolvedValue({ success: true, mock: true }),
}))
vi.mock('../lib/marketing-notify.ts', () => ({
	postMarketingNotify: vi.fn().mockResolvedValue({ status: 'delivered' }),
}))

const orgId = 'clw9x0a12000008l00shlink1'
const operatorSecret = 'test-operator-secret-123456789'
const SITE = 'https://casa-verde.menuza.site'

// The public lookup names its organization from the site's Origin; that lookup
// has its own tests, so here it simply answers for this organization.
vi.mock('../routes/orders.ts', () => ({
	resolveOrderingOrganization: vi.fn(async () => ({
		organization: { id: 'clw9x0a12000008l00shlink1' },
	})),
}))

async function operatorToken(options: { canUpdate?: boolean } = {}) {
	return new SignJWT({
		orgId,
		role: 'operator',
		...(options.canUpdate === false ? {} : { canUpdate: true }),
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('1h')
		.sign(new TextEncoder().encode(operatorSecret))
}

const operatorApp = new Hono().route(
	'/operator/marketing/short-links',
	shortLinkOperatorRoutes,
)
const publicApp = new Hono().route('/short-links', publicShortLinkRoutes)

async function createViaApi(body: Record<string, unknown>, canUpdate = true) {
	return operatorApp.request('/operator/marketing/short-links', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${await operatorToken({ canUpdate })}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})
}

function appKnowsTheSite(shortLinks: boolean) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string | URL | Request) =>
			String(url).includes('/sms-allowance')
				? Response.json({ ok: true })
				: Response.json({
						id: orgId,
						name: 'Casa Verde',
						timeZone: 'America/New_York',
						siteOrigin: SITE,
						features: { shortLinks },
					}),
		),
	)
}

describe('short links (#159)', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-shlink-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret
		process.env.JWT_SECRET = operatorSecret
		process.env.APP_URL = 'https://app.example.test'
		process.env.INTERNAL_COMMAND_TOKEN = 'test-internal-command-token'
		clearOrgEmailSenderCacheForTest()
		appKnowsTheSite(true)
		vi.mocked(sendSms).mockClear()
		await provisionTenantDb(orgId)
	})

	afterEach(async () => {
		bindAppService(null)
		vi.unstubAllGlobals()
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	describe('creating', () => {
		it('a link to an external domain cannot be created', async () => {
			const db = await getTenantDb(orgId)
			for (const targetPath of [
				'https://evil.example/phish',
				'//evil.example',
				'http://casa-verde.menuza.site/menu',
				'javascript:alert(1)',
				'/\\evil.example',
				'menu',
			]) {
				const res = await createViaApi({ kind: 'link', targetPath })
				expect(res.status, targetPath).toBe(400)
				await expect(
					ensureShortLink(db, { kind: 'link', targetPath }),
				).rejects.toBeInstanceOf(ShortLinkError)
			}
			expect(await db.select().from(shortLinks).all()).toHaveLength(0)
		})

		it('makes a 7-character code for a page of the site, with optional UTM values', async () => {
			const res = await createViaApi({
				kind: 'link',
				label: 'Window sticker',
				targetPath: '/menu',
				utmSource: 'sticker',
				utmCampaign: 'window',
			})
			expect(res.status).toBe(201)
			const { link } = (await res.json()) as {
				link: { code: string; targetPath: string; clicksThisMonth: number }
			}
			expect(link.code).toMatch(/^[2-9a-hj-km-np-z]{7}$/)
			expect(link.targetPath).toBe('/menu')
			expect(link.clicksThisMonth).toBe(0)
		})

		it('needs the write claim and refuses unknown fields', async () => {
			const denied = await createViaApi(
				{ kind: 'link', targetPath: '/' },
				false,
			)
			expect(denied.status).toBe(403)
			const extra = await createViaApi({
				kind: 'link',
				targetPath: '/',
				disabledAt: 1,
			})
			expect(extra.status).toBe(400)
			const noRef = await createViaApi({ kind: 'print', targetPath: '/' })
			expect(noRef.status).toBe(400)
		})

		it('a print link is one per design and path, however often it is asked for', async () => {
			const db = await getTenantDb(orgId)
			const a = await ensureShortLink(db, {
				kind: 'print',
				ref: 'design-1',
				targetPath: '/menu',
			})
			const b = await ensureShortLink(db, {
				kind: 'print',
				ref: 'design-1',
				targetPath: '/menu',
			})
			const c = await ensureShortLink(db, {
				kind: 'print',
				ref: 'design-1',
				targetPath: '/events',
			})
			expect(b.id).toBe(a.id)
			expect(c.id).not.toBe(a.id)
			const same = await Promise.all(
				Array.from({ length: 8 }, () =>
					ensureShortLink(db, {
						kind: 'print',
						ref: 'design-2',
						targetPath: '/',
					}),
				),
			)
			expect(new Set(same.map((link) => link.id)).size).toBe(1)
		})
	})

	describe('resolving and counting', () => {
		async function link(extra: Record<string, unknown> = {}) {
			const db = await getTenantDb(orgId)
			return ensureShortLink(db, {
				kind: 'link',
				targetPath: '/menu?item=abc',
				utmSource: 'sticker',
				utmMedium: 'print',
				utmCampaign: 'window',
				...extra,
			})
		}

		async function click(
			code: string,
			query = '',
			headers: Record<string, string> = {},
		) {
			return publicApp.request(`/short-links/resolve?code=${code}${query}`, {
				headers: { Origin: SITE, ...headers },
			})
		}

		it('answers the path with its UTM values and the link id, and counts one click', async () => {
			const created = await link()
			const res = await click(created.code)
			expect(res.status).toBe(200)
			const body = (await res.json()) as { status: string; location: string }
			expect(body.status).toBe('ok')
			const url = new URL(`${SITE}${body.location}`)
			expect(url.pathname).toBe('/menu')
			expect(Object.fromEntries(url.searchParams)).toEqual({
				item: 'abc',
				utm_source: 'sticker',
				utm_medium: 'print',
				utm_campaign: 'window',
				mzl: created.id,
			})
			const db = await getTenantDb(orgId)
			const days = await db.select().from(shortLinkClicksDaily).all()
			expect(days).toEqual([
				{ linkId: created.id, day: clickDay(Date.now()), clicks: 1 },
			])
		})

		it('scanning a tracked print QR increments its count, shown as scans this month', async () => {
			const db = await getTenantDb(orgId)
			const print = await ensureShortLink(db, {
				kind: 'print',
				ref: 'design-7',
				targetPath: '/menu',
				utmSource: 'print',
				utmMedium: 'qr',
				utmCampaign: 'design-7',
			})
			expect(
				(await listShortLinks(db, { kind: 'print' }))[0]!.clicksThisMonth,
			).toBe(0)
			for (let scan = 0; scan < 3; scan++) await click(print.code)
			const [view] = await listShortLinks(db, { kind: 'print' })
			expect(view).toMatchObject({ ref: 'design-7', clicksThisMonth: 3 })
			// A print QR never appears in the Links screen's own list.
			expect(await listShortLinks(db, { kind: 'link' })).toHaveLength(0)
		})

		it('an order after a click is attributed to the link, net of refunds (#115)', async () => {
			const created = await link()
			const other = await link()
			await click(created.code)
			const attribution = { shortLinkId: created.id, touchedAt: Date.now() }
			await insertOrder(orgId, {
				subtotalCents: 3000,
				totalCents: 3000,
				attribution,
				attributionSource: 'short_link',
			})
			await insertOrder(orgId, {
				subtotalCents: 2000,
				totalCents: 2000,
				refundedCents: 500,
				attribution,
				attributionSource: 'short_link',
			})
			// Not paid, so not counted; and another link's order stays on that link.
			await insertOrder(orgId, {
				status: 'cancelled',
				paymentStatus: 'unpaid',
				attribution,
			})
			await insertOrder(orgId, { attribution: { shortLinkId: other.id } })
			const db = await getTenantDb(orgId)
			const [view] = await listShortLinks(db, { ids: [created.id] })
			expect(view).toMatchObject({ orders: 2, revenueMinor: 4500 })
			const [none] = await listShortLinks(db, { ids: [other.id] })
			expect(none).toMatchObject({ orders: 1 })
		})

		it('counts simultaneous clicks exactly', async () => {
			const created = await link()
			await Promise.all(Array.from({ length: 25 }, () => click(created.code)))
			const db = await getTenantDb(orgId)
			const [view] = await listShortLinks(db, { ids: [created.id] })
			expect(view!.clicksThisMonth).toBe(25)
			expect(view!.clicksTotal).toBe(25)
			expect(view!.daily.at(-1)).toEqual({
				day: clickDay(Date.now()),
				clicks: 25,
			})
			expect(view!.daily).toHaveLength(30)
		})

		it('counts per day and splits this month from the total', async () => {
			const created = await link()
			const db = await getTenantDb(orgId)
			const now = Date.UTC(2026, 5, 15, 12)
			await resolveShortLink(db, created.code, { now })
			await resolveShortLink(db, created.code, { now })
			await resolveShortLink(db, created.code, {
				now: Date.UTC(2026, 4, 28, 12),
			})
			const [view] = await listShortLinks(db, { ids: [created.id], now })
			expect(view!.clicksThisMonth).toBe(2)
			expect(view!.clicksTotal).toBe(3)
			expect(view!.daily.find((day) => day.day === '2026-06-15')?.clicks).toBe(
				2,
			)
			expect(view!.daily.find((day) => day.day === '2026-05-28')?.clicks).toBe(
				1,
			)
		})

		it('a bot or a visitor over the limit resolves without being counted', async () => {
			const created = await link()
			const res = await click(created.code, '&count=0')
			expect(res.status).toBe(200)
			const db = await getTenantDb(orgId)
			expect(await db.select().from(shortLinkClicksDaily).all()).toHaveLength(0)
		})

		it('a disabled link answers disabled (the friendly page) and counts nothing', async () => {
			const created = await link()
			const token = await operatorToken()
			const off = await operatorApp.request(
				`/operator/marketing/short-links/${created.id}`,
				{
					method: 'PATCH',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ disabled: true }),
				},
			)
			expect(off.status).toBe(200)
			const res = await click(created.code)
			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ status: 'disabled' })
			const db = await getTenantDb(orgId)
			expect(await db.select().from(shortLinkClicksDaily).all()).toHaveLength(0)
			// And it works again once enabled.
			await operatorApp.request(
				`/operator/marketing/short-links/${created.id}`,
				{
					method: 'PATCH',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ disabled: false }),
				},
			)
			expect(
				((await (await click(created.code)).json()) as { status: string })
					.status,
			).toBe('ok')
		})

		it('an unknown or malformed code is a uniform 404', async () => {
			expect((await click('zzzzzzz')).status).toBe(404)
			expect((await click('nope')).status).toBe(404)
			expect((await publicApp.request('/short-links/resolve')).status).toBe(404)
		})

		it('a stored target that is not a site path never redirects', async () => {
			const created = await link()
			const db = await getTenantDb(orgId)
			await db
				.update(shortLinks)
				.set({ targetPath: 'https://evil.example/' })
				.where(eq(shortLinks.id, created.id))
			const res = await click(created.code)
			expect(res.status).toBe(404)
		})

		it('stores no address, no user agent and no person: the tables hold only ids, codes and counts', async () => {
			const created = await link()
			await click(created.code, '', {
				'User-Agent': 'Mozilla/5.0 (secret-agent)',
				'X-Forwarded-For': '203.0.113.77',
				'CF-Connecting-IP': '203.0.113.78',
				Cookie: 'session=abc',
			})
			const db = await getTenantDb(orgId)
			const dump = JSON.stringify([
				await db.select().from(shortLinks).all(),
				await db.select().from(shortLinkClicksDaily).all(),
			])
			for (const secret of ['secret-agent', '203.0.113', 'session=abc']) {
				expect(dump).not.toContain(secret)
			}
			expect(
				Object.keys(
					(await db.select().from(shortLinkClicksDaily).all())[0]!,
				).sort(),
			).toEqual(['clicks', 'day', 'linkId'])
		})

		it('a click with a message id marks that text clicked, only for its own campaign', async () => {
			const db = await getTenantDb(orgId)
			const [guest] = await db
				.insert(customers)
				.values({ name: 'Sam', phone: '+15550001111', phoneVerified: true })
				.returning()
			const campaignId = randomUUID()
			const otherId = randomUUID()
			for (const id of [campaignId, otherId]) {
				await db.insert(marketingCampaigns).values({
					id,
					name: 'c',
					channel: 'sms',
					content: 'x',
					status: 'Completed',
				})
			}
			const messageId = randomUUID()
			await db.insert(marketingMessages).values({
				id: messageId,
				campaignId,
				customerId: guest!.id,
				channel: 'sms',
				status: 'Sent',
			})
			const mine = await link({ campaignId })
			const theirs = await link({ campaignId: otherId, targetPath: '/events' })
			await click(theirs.code, `&m=${messageId}`)
			expect(
				(await db
					.select()
					.from(marketingMessages)
					.where(eq(marketingMessages.id, messageId))
					.get())!.clickedAt,
			).toBeNull()
			await click(mine.code, `&m=${messageId}`)
			const after = await db
				.select()
				.from(marketingMessages)
				.where(eq(marketingMessages.id, messageId))
				.get()
			expect(after!.clickedAt).toBeInstanceOf(Date)
			expect(after!.status).toBe('Clicked')
		})
	})

	describe('texts', () => {
		async function smsGuest(db: TenantDatabase) {
			const [guest] = await db
				.insert(customers)
				.values({ name: 'Nora', phone: '+15550123456', phoneVerified: true })
				.returning()
			await db.insert(customerSubscriptions).values({
				customerId: guest!.id,
				topic: 'marketing',
				channel: 'sms',
				source: 'signup',
				subscribedAt: new Date(),
			})
			return guest!
		}

		it('a broadcast text carries a short link that opens the right page with UTM values', async () => {
			const db = await getTenantDb(orgId)
			await smsGuest(db)
			const now = Date.now()
			const id = randomUUID()
			await db.insert(marketingCampaigns).values({
				id,
				name: 'Taco Tuesday',
				channel: 'sms',
				content: `Tacos are half price: ${SITE}/menu?item=tacos`,
				status: 'Processing',
				segmentationRules: JSON.stringify({ audience: 'all' }),
				updatedAt: broadcastLease(now),
			})

			expect(
				await dispatchBroadcast(orgId, id, broadcastLease(now), {
					now: () => now,
				}),
			).toBe('completed')

			const [call] = vi.mocked(sendSms).mock.calls
			const message = call![0].message
			const shortUrl =
				/https:\/\/casa-verde\.menuza\.site\/l\/([a-z0-9]{7})\?m=([0-9a-f-]{36})/.exec(
					message,
				)
			expect(shortUrl).not.toBeNull()
			expect(message).not.toContain('item=tacos')
			expect(message.endsWith(SMS_OPT_OUT_PHRASE)).toBe(true)
			// Following it opens the same page, tagged with UTM values and the ids.
			const res = await publicApp.request(
				`/short-links/resolve?code=${shortUrl![1]}&m=${shortUrl![2]}`,
				{ headers: { Origin: SITE } },
			)
			const body = (await res.json()) as { location: string }
			const url = new URL(`${SITE}${body.location}`)
			expect(url.pathname).toBe('/menu')
			expect(url.searchParams.get('item')).toBe('tacos')
			expect(url.searchParams.get('utm_source')).toBe('menuza')
			expect(url.searchParams.get('utm_medium')).toBe('sms')
			expect(url.searchParams.get('utm_campaign')).toBe('taco-tuesday')
			expect(url.searchParams.get('mzc')).toBe(id)
			expect(url.searchParams.get('mzl')).toMatch(/[0-9a-f-]{36}/)
			// The recipient's own text is marked clicked.
			const sent = await db
				.select()
				.from(marketingMessages)
				.where(eq(marketingMessages.id, shortUrl![2]!))
				.get()
			expect(sent!.clickedAt).toBeInstanceOf(Date)
			// One link per campaign and page, however many recipients.
			expect(await db.select().from(shortLinks).all()).toHaveLength(1)
		})

		it('every recipient shares the campaign link and keeps their own message id', async () => {
			const db = await getTenantDb(orgId)
			const rows = await db
				.insert(customers)
				.values(
					Array.from({ length: 3 }, (_, i) => ({
						name: `S${i}`,
						phone: `+1555000${String(i).padStart(4, '0')}`,
						phoneVerified: true,
					})),
				)
				.returning()
			await db.insert(customerSubscriptions).values(
				rows.map((c) => ({
					customerId: c.id,
					topic: 'marketing' as const,
					channel: 'sms' as const,
					source: 'signup' as const,
					subscribedAt: new Date(),
				})),
			)
			const now = Date.now()
			const id = randomUUID()
			await db.insert(marketingCampaigns).values({
				id,
				name: 'Promo',
				channel: 'sms',
				content: `Visit ${SITE}/`,
				status: 'Processing',
				segmentationRules: JSON.stringify({ audience: 'all' }),
				updatedAt: broadcastLease(now),
			})
			await dispatchBroadcast(orgId, id, broadcastLease(now), {
				now: () => now,
			})
			const texts = vi
				.mocked(sendSms)
				.mock.calls.map(([input]) => input.message)
			const codes = texts.map((text) => /\/l\/([a-z0-9]{7})/.exec(text)![1])
			const messageIds = texts.map(
				(text) => /\?m=([0-9a-f-]{36})/.exec(text)![1],
			)
			expect(new Set(codes).size).toBe(1)
			expect(new Set(messageIds).size).toBe(3)
		})

		it('with short links off the own-site link stays whole and carries the same values', async () => {
			clearOrgEmailSenderCacheForTest()
			appKnowsTheSite(false)
			const db = await getTenantDb(orgId)
			await smsGuest(db)
			const now = Date.now()
			const id = randomUUID()
			await db.insert(marketingCampaigns).values({
				id,
				name: 'Taco Tuesday',
				channel: 'sms',
				content: `Order ${SITE}/menu and see https://maps.example/p`,
				status: 'Processing',
				segmentationRules: JSON.stringify({ audience: 'all' }),
				updatedAt: broadcastLease(now),
			})
			await dispatchBroadcast(orgId, id, broadcastLease(now), {
				now: () => now,
			})
			const message = vi.mocked(sendSms).mock.calls[0]![0].message
			expect(message).toContain(`${SITE}/menu?`)
			expect(message).toContain(`mzc=${id}`)
			expect(message).toContain('utm_medium=sms')
			expect(message).toContain('https://maps.example/p')
			expect(message).not.toContain('/l/')
			expect(await db.select().from(shortLinks).all()).toHaveLength(0)
		})

		it('an automation text shortens its links too, carrying the journey and step ids', async () => {
			const db = await getTenantDb(orgId)
			const guest = await smsGuest(db)
			const [journey] = await db
				.insert(marketingJourneys)
				.values({ name: 'Welcome', status: 'active' })
				.returning()
			const [run] = await db
				.insert(journeyRuns)
				.values({ journeyId: journey!.id, customerId: guest.id })
				.returning()
			const result = await executeJourneyStep(orgId, {
				orgId,
				journeyId: journey!.id,
				runId: run!.id,
				customerId: guest.id,
				nodeId: 'sms-1',
				nodeType: 'action_sms',
				config: { messageText: `Hi {{firstName}}, order ${SITE}/menu` },
			})
			expect(result.status).toBe('delivered')
			const message = vi.mocked(sendSms).mock.calls[0]![0].message
			const match = /\/l\/([a-z0-9]{7})\?m=([0-9a-f-]{36})/.exec(message)!
			const stored = await db.select().from(shortLinks).get()
			expect(stored).toMatchObject({
				code: match[1],
				kind: 'message',
				campaignId: journey!.id,
				stepId: 'sms-1',
				utmCampaign: 'welcome',
			})
			// The text row carries the id that travelled in the link.
			const row = await db
				.select()
				.from(marketingMessages)
				.where(eq(marketingMessages.id, match[2]!))
				.get()
			expect(row?.customerId).toBe(guest.id)
		})
	})
})
