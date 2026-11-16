import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { interpolateMergeTagsHtml } from '@repo/tenant-db'
import {
	customerCarts,
	customers,
	destroyTenantDb,
	getTenantDb,
	marketingJourneys,
	orderJourneyEmissions,
	provisionTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	buildCartLinkUrl,
	CART_LINK_TTL_MS,
	issueCartToken,
	verifyCartToken,
} from '../lib/cart-link.ts'
import { setCustomerSubscription } from './marketing-audience.ts'
import {
	canBeReminded,
	clearCartSnapshot,
	readCartForRestore,
	recordCartSnapshot,
	runCartJourneys,
	toSnapshotLines,
	writeCartSettings,
} from './cart-reminders.ts'
import { setOrderJourneySpawner } from './order-journeys.ts'
import { erasePerson } from './person-erasure-service.ts'

const ORG = 'clw9x0a12000008l00cart01'
const HOUR = 3_600_000
const NOW = Date.UTC(2027, 0, 10, 12)

describe('cart left behind (#150)', () => {
	let dir: string
	let db: TenantDatabase
	const spawn = vi.fn(async (..._args: unknown[]) => ({ success: true }))

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-cart-'))
		process.env.TENANT_DB_DIR = dir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		await provisionTenantDb(ORG)
		db = await getTenantDb(ORG)
		spawn.mockClear()
		setOrderJourneySpawner(spawn as never)
	})

	afterEach(async () => {
		setOrderJourneySpawner(null)
		await destroyTenantDb(ORG).catch(() => {})
		fs.rmSync(dir, { recursive: true, force: true })
		delete process.env.TENANT_DB_DIR
	})

	async function listen() {
		await db.insert(marketingJourneys).values({
			name: 'Cart reminder',
			status: 'active',
			triggerType: 'cart_left_behind',
		})
	}

	async function guest(
		id: string,
		options: { verified?: boolean; consent?: boolean } = {},
	) {
		await db.insert(customers).values({
			id,
			name: id,
			email: `${id}@example.com`,
			phone: `+1555${id.length}${id}`,
			phoneVerified: options.verified ?? true,
		})
		if (options.consent ?? true) {
			await setCustomerSubscription(db, {
				customerId: id,
				topic: 'marketing',
				channel: 'sms',
				subscribed: true,
				source: 'signup',
			})
		}
	}

	const cart = (customerId: string, at: number, subtotalMinor = 2500) =>
		recordCartSnapshot(db, {
			customerId,
			locationId: 'loc_1',
			currency: 'USD',
			subtotalMinor,
			lines: toSnapshotLines([
				{
					itemId: 'burger',
					quantity: 2,
					options: [{ groupId: 'g', optionId: 'o' }],
				},
			]),
			now: at,
		})

	const snapshots = () => db.select().from(customerCarts).all()

	it('keeps a snapshot only for a signed-in, consenting guest while a cart journey is active', async () => {
		await guest('a')
		await guest('unverified', { verified: false })
		await guest('noconsent', { consent: false })
		// No cart journey yet: nothing is kept "just in case".
		await cart('a', NOW)
		expect(await snapshots()).toEqual([])
		await listen()
		await cart('a', NOW)
		await cart('unverified', NOW)
		await cart('noconsent', NOW)
		expect((await snapshots()).map((row) => row.customerId)).toEqual(['a'])
		// A guest who withdrew consent: the next quote drops the snapshot.
		await setCustomerSubscription(db, {
			customerId: 'a',
			topic: 'marketing',
			channel: 'sms',
			subscribed: false,
			source: 'profile',
		})
		await cart('a', NOW + 1000)
		expect(await snapshots()).toEqual([])
	})

	it('holds ids and quantities only', async () => {
		await listen()
		await guest('a')
		await cart('a', NOW)
		const [row] = await snapshots()
		const text = JSON.stringify(row)
		expect(text).not.toMatch(/@example|\+1555|instructions/)
		expect(row!.items).toEqual([
			{
				itemId: 'burger',
				quantity: 2,
				options: [{ groupId: 'g', optionId: 'o' }],
			},
		])
	})

	it('every quote overwrites the snapshot and restarts the delay; clearing removes it', async () => {
		await listen()
		await guest('a')
		await cart('a', NOW)
		await cart('a', NOW + 30 * 60_000, 4000)
		const [row] = await snapshots()
		expect(row!.subtotalCents).toBe(4000)
		// 1 hour after the FIRST quote is not yet 1 hour after the last one.
		await runCartJourneys(ORG, { now: NOW + HOUR })
		expect(spawn).not.toHaveBeenCalled()
		await runCartJourneys(ORG, { now: NOW + 30 * 60_000 + HOUR + 1 })
		expect(spawn).toHaveBeenCalledTimes(1)
		await clearCartSnapshot(db, 'a')
		expect(await snapshots()).toEqual([])
	})

	it('fires once per snapshot and at most once per guest per 24 hours', async () => {
		await listen()
		await guest('a')
		await cart('a', NOW)
		await runCartJourneys(ORG, { now: NOW + 2 * HOUR })
		await runCartJourneys(ORG, { now: NOW + 3 * HOUR })
		expect(spawn).toHaveBeenCalledTimes(1)
		// A new cart 5 hours later is within the 24 hours: not started.
		await cart('a', NOW + 5 * HOUR)
		await runCartJourneys(ORG, { now: NOW + 7 * HOUR })
		expect(spawn).toHaveBeenCalledTimes(1)
		// Past 24 hours since the first start, a new left cart starts again.
		await cart('a', NOW + 26 * HOUR)
		await runCartJourneys(ORG, { now: NOW + 28 * HOUR })
		expect(spawn).toHaveBeenCalledTimes(2)
		expect(await db.select().from(orderJourneyEmissions).all()).toHaveLength(2)
	})

	it('respects the delay and the minimum cart value, both editable', async () => {
		await listen()
		await guest('a')
		await guest('b')
		await cart('a', NOW, 50)
		await cart('b', NOW, 5000)
		await runCartJourneys(ORG, { now: NOW + HOUR + 1 })
		expect(spawn.mock.calls.map((c) => c[2])).toEqual(['b'])
		await writeCartSettings(db, { delayMinutes: 120, minCartMinor: 0 })
		spawn.mockClear()
		await runCartJourneys(ORG, { now: NOW + HOUR + 2 })
		expect(spawn).not.toHaveBeenCalled()
		await runCartJourneys(ORG, { now: NOW + 2 * HOUR + 1 })
		expect(spawn.mock.calls.map((c) => c[2])).toEqual(['a'])
	})

	it('drops snapshots older than 7 days, and one whose guest stopped consenting is not started', async () => {
		await listen()
		await guest('old')
		await guest('left')
		await cart('old', NOW)
		await cart('left', NOW + 100)
		await setCustomerSubscription(db, {
			customerId: 'left',
			topic: 'marketing',
			channel: 'sms',
			subscribed: false,
			source: 'profile',
		})
		expect(await canBeReminded(db, 'left')).toBe(false)
		await runCartJourneys(ORG, { now: NOW + 8 * 24 * HOUR })
		expect(spawn).not.toHaveBeenCalled()
		expect(await snapshots()).toEqual([])
	})

	it('restore reads ids and quantities within 7 days only, and a deleted guest leaves nothing', async () => {
		await listen()
		await guest('a')
		await cart('a', NOW)
		expect(await readCartForRestore(db, 'a', NOW + 6 * 24 * HOUR)).toEqual({
			locationId: 'loc_1',
			currency: 'USD',
			lines: [
				{
					itemId: 'burger',
					quantity: 2,
					options: [{ groupId: 'g', optionId: 'o' }],
				},
			],
		})
		expect(await readCartForRestore(db, 'a', NOW + 8 * 24 * HOUR)).toBeNull()
		await erasePerson(db, { customerId: 'a' }, { actorId: 'op' })
		expect(await snapshots()).toEqual([])
	})

	describe('the restore token', () => {
		const org = 'org_x'
		beforeEach(() => {
			process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		})

		it('verifies for its guest and organization, and expires after 7 days', () => {
			const token = issueCartToken({ orgId: org, customerId: 'guest-1', now: NOW })
			expect(verifyCartToken({ orgId: org, presented: token, now: NOW + 1000 })).toEqual({
				customerId: 'guest-1',
			})
			expect(
				verifyCartToken({ orgId: 'other', presented: token, now: NOW + 1000 }),
			).toBeNull()
			expect(
				verifyCartToken({
					orgId: org,
					presented: token,
					now: NOW + CART_LINK_TTL_MS + 1,
				}),
			).toBeNull()
		})

		it('refuses a forged guest, a forged expiry and garbage', () => {
			const token = issueCartToken({ orgId: org, customerId: 'guest-1', now: NOW })
			const [expiry, , signature] = token.split('.')
			for (const forged of [
				`${expiry}.guest-2.${signature}`,
				`${Number(expiry) + 99_999_999}.guest-1.${signature}`,
				`${expiry}.guest-1.${'0'.repeat(64)}`,
				'',
				'garbage',
				`${expiry}.guest-1`,
			]) {
				expect(verifyCartToken({ orgId: org, presented: forged, now: NOW })).toBeNull()
			}
		})

		it('lives in the URL fragment, never the query string', () => {
			const token = issueCartToken({ orgId: org, customerId: 'guest-1', now: NOW })
			const url = new URL(
				buildCartLinkUrl({ siteOrigin: 'https://shop.example.com', token })!,
			)
			expect(url.search).toBe('')
			expect(url.hash).toBe(`#cart=${token}`)
			expect(buildCartLinkUrl({ siteOrigin: 'javascript:alert(1)', token })).toBeNull()
			expect(buildCartLinkUrl({ siteOrigin: null, token })).toBeNull()
		})
	})

	it('{{cartLink}} follows the URL-attribute rules: a safe link passes, a script link is emptied, text is escaped', () => {
		const html = '<a href="{{cartLink}}">Back to your order</a> <p>{{cartLink}}</p>'
		const safe = 'https://shop.example.com/menu#cart=1.a.abc&x=1'
		const out = interpolateMergeTagsHtml(html, { name: 'A' }, { cartLink: safe })
		expect(out).toContain('href="https://shop.example.com/menu#cart=1.a.abc&amp;x=1"')
		const bad = interpolateMergeTagsHtml(
			html,
			{ name: 'A' },
			{ cartLink: 'javascript:alert(1)' },
		)
		expect(bad).toContain('href=""')
		expect(bad).not.toMatch(/href="javascript/i)
	})
})
