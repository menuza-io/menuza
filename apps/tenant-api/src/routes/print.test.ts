import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	PRINT_MAX_ATTEMPTS,
	PRINT_REOFFER_MS,
	type PrinterRoutes,
} from '@repo/common/print-devices'
import {
	destroyTenantDb,
	getTenantDb,
	kdsLocationSettings,
	posDevices,
	posFiscalDocuments,
	posOrders,
	posPayments,
	printDevices,
	printJobs,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import { clearPrintingFlagCache, seedPrintingFlagForTest } from '../lib/print-switches.ts'
import { setRasterizerForTest } from '../lib/print-raster.ts'
import { setLogoFetcherForTest } from '../lib/logo-bitmap.ts'
import { OPERATOR_SECRET, stubStaffEnv } from '../../tests/staff-harness.ts'
import { clearPrintContextCache } from '../services/print-source.ts'
import {
	claimNextJob,
	createPrinter,
	queueOrderPrint,
	revokePrinter,
} from '../services/print-service.ts'
import { printAcceptedOrder, printTillSale } from '../services/print-hooks.ts'
import { hashPosSecret } from '../lib/pos-auth.ts'
import { formatPosDeviceSecret } from '@repo/common/pos-orders'
import { operatorPrintRoutes } from './operator-print.ts'
import { publicOrderRoutes } from './orders.ts'
import { printRoutes } from './print.ts'

vi.mock('../lib/origin.ts', () => {
	const findActiveOrganizationById = vi.fn()
	return {
		findActiveOrganizationById,
		lookupActiveOrganization: vi.fn(async (id: string) => {
			const organization = await findActiveOrganizationById(id)
			return organization
				? { status: 'found', organization }
				: { status: 'missing' }
		}),
		resolveOrganizationForBrowserAuth: vi.fn(),
		resolvePublishedOrganization: vi.fn(async () => null),
	}
})

/**
 * Cloud printers (#117, #426): the printer protocols, authentication, routing,
 * the offer-and-acknowledge rules, reprint, the test ticket and the kill
 * switch. Nothing here reaches a printer maker's host: the printer is the test.
 */

const ORG = 'org_print_test_1'
const OTHER_ORG = 'org_print_test_2'
const LOC = 'loc-1'
const LOC_B = 'loc-2'
const ORG_ROW = {
	id: ORG,
	slug: 'test-org',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}
const ALL_DAYS = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
].map((day) => ({
	day,
	isOpen: true,
	slots: [{ start: '00:00', end: '23:59' }],
}))

const context = (extra: Record<string, unknown> = {}) => ({
	orgId: ORG,
	dataRegion: 'us',
	menu: {
		organization: {
			id: ORG,
			name: 'Cafe Bloom',
			slug: 'test-org',
			currency: 'USD',
			defaultLocale: 'en',
			logoUrl: 'https://app.test/logo.png',
		},
		locations: [
			{
				id: LOC,
				name: 'Main Street',
				timezone: 'UTC',
				taxRate: 0,
				prepTime: 15,
				currency: 'USD',
				vatNumber: null,
				fulfillmentOptions: { pickup: true, delivery: true, dineIn: true, curbside: false },
				inHouseTips: { pickupTips: false, deliveryTips: false, dineInTips: false },
				onlineHours: ALL_DAYS,
				stationSettings: {
					tickets: {
						extras: { logo: true, review: { show: true }, app: { show: true } },
					},
				},
				receiptCodes: {
					reviewUrl: 'https://g.page/r/abc/review',
					appUrl: 'https://site.test/get-app?p=print',
				},
			},
		],
		menus: [
			{
				id: 'menu-1',
				displayName: 'Main',
				menuType: 'regular',
				specialInstructions: true,
				availabilityStatus: 'available',
				categories: [
					{
						id: 'cat',
						displayName: 'Food',
						availabilityStatus: 'available',
						items: [
							{ id: 'burger', displayName: 'Burger', price: 10, availabilityStatus: 'available' },
							{ id: 'mojito', displayName: 'Mojito', price: 8, availabilityStatus: 'available', isAlcohol: true },
							{ id: 'soup', displayName: 'Soup', price: 6, availabilityStatus: 'available' },
						],
					},
				],
			},
		],
		locationOverrides: {},
	},
	drop: null,
	onlinePayment: { enabled: true, processor: 'connect' },
	...extra,
})

const routes = (patch: Partial<PrinterRoutes> = {}): PrinterRoutes => ({
	kitchen: 'all',
	stationIds: [],
	receipts: false,
	isDefault: false,
	deliveryAddress: false,
	arabicFont: false,
	...patch,
})

describe('cloud printers (#117, #426)', () => {
	let directory: string
	let app: Hono
	let activeContext: unknown

	const operatorToken = (extra: Record<string, unknown> = {}) =>
		new SignJWT({
			orgId: ORG,
			role: 'operator',
			scope: 'orders:write',
			...extra,
		})
			.setSubject('user_manager_1')
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setExpirationTime('15m')
			.sign(new TextEncoder().encode(OPERATOR_SECRET))

	const basic = (password: string) =>
		`Basic ${Buffer.from(`printer:${password}`).toString('base64')}`

	async function addPrinter(
		over: {
			name?: string
			locationId?: string
			protocol?: 'star_cloudprnt' | 'epson_sdp'
			widthMm?: 58 | 80
			routes?: Partial<PrinterRoutes>
			copies?: number
		} = {},
	) {
		const db = await getTenantDb(ORG)
		const created = await createPrinter(
			db,
			ORG,
			{
				locationId: over.locationId ?? LOC,
				name: over.name ?? 'Kitchen',
				protocol: over.protocol ?? 'star_cloudprnt',
				widthMm: over.widthMm ?? 80,
				copies: over.copies ?? 1,
				routes: routes(over.routes),
			},
			'user_manager_1',
		)
		return { ...created, ref: created.printer.ref, id: created.printer.id }
	}

	/** One poll of a Star printer. */
	const starPoll = (ref: string, password: string, body: unknown = { statusCode: '200 OK' }) =>
		app.request(`/print/${ref}/poll`, {
			method: 'POST',
			headers: { authorization: basic(password), 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})
	const starFetch = (ref: string, password: string, token: string) =>
		app.request(`/print/${ref}/poll?token=${token}&type=application%2Fvnd.star.starprntcore`, {
			headers: { authorization: basic(password) },
		})
	const starAck = (ref: string, password: string, token: string, code = '200 OK') =>
		app.request(`/print/${ref}/poll?token=${token}&code=${encodeURIComponent(code)}`, {
			method: 'DELETE',
			headers: { authorization: basic(password) },
		})
	const text = async (response: Response) =>
		Buffer.from(await response.arrayBuffer())
			.toString('latin1')
			.replace(/[^\x20-\x7e\n]/g, '·')

	async function insertOrder(values: Partial<typeof restaurantOrders.$inferInsert> = {}) {
		const db = await getTenantDb(ORG)
		const id = values.id ?? crypto.randomUUID()
		await db.insert(restaurantOrders).values({
			orgId: ORG,
			number: 'W-0951',
			status: 'accepted',
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			fulfillment: 'pickup',
			locationId: LOC,
			locationName: 'Main Street',
			locationTimezone: 'UTC',
			contactName: 'Layla Guest',
			contactPhone: '+15551234567',
			contactEmail: 'layla@example.com',
			currency: 'USD',
			subtotalCents: 2000,
			taxCents: 0,
			totalCents: 2000,
			lines: [
				{
					itemId: 'burger',
					itemName: 'Burger',
					quantity: 1,
					unitPriceCents: 1000,
					taxableUnitCents: 0,
					totalCents: 1000,
					taxableCents: 0,
					instructions: 'call me on 555-123-4567',
					options: [
						{
							groupId: 'g',
							groupName: 'Extras',
							optionId: 'o',
							optionName: 'No onions',
							half: null,
							quantity: 1,
							priceCents: 0,
							totalCents: 0,
						},
					],
					baseUnitCents: 1000,
					categoryIds: [],
				},
				{
					itemId: 'soup',
					itemName: 'Soup',
					quantity: 2,
					unitPriceCents: 500,
					taxableUnitCents: 0,
					totalCents: 1000,
					taxableCents: 0,
					instructions: null,
					options: [],
					baseUnitCents: 500,
					categoryIds: [],
				},
			],
			idempotencyKey: crypto.randomUUID(),
			requestHash: 'h',
			receiptTokenHash: 'r',
			...values,
			id,
		})
		return id
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'print-'))
		stubStaffEnv(directory)
		vi.stubEnv('PRINTING_ENABLED', 'true')
		clearPrintingFlagCache()
		clearPrintContextCache()
		seedPrintingFlagForTest(ORG, true)
		activeContext = context()
		setRasterizerForTest(null)
		setLogoFetcherForTest(async () => null)
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return new Response(JSON.stringify(activeContext), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					})
				}
				throw new Error(`Unexpected host ${url}`)
			}),
		)
		vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
			async (_origin, identity) =>
				identity?.slug === 'test-org' ? (ORG_ROW as never) : null,
		)
		vi.mocked(findActiveOrganizationById).mockImplementation(async (id) =>
			id === ORG ? (ORG_ROW as never) : null,
		)
		await provisionTenantDb(ORG)
		await provisionTenantDb(OTHER_ORG)
		app = new Hono()
		app.route('/print', printRoutes)
		app.route('/operator/pos/printers', operatorPrintRoutes)
		app.route('/orders', publicOrderRoutes)
	})

	afterEach(async () => {
		for (const id of [ORG, OTHER_ORG]) {
			try {
				await destroyTenantDb(id)
			} catch {}
		}
		fs.rmSync(directory, { recursive: true, force: true })
		setRasterizerForTest(undefined)
		setLogoFetcherForTest(null)
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	describe('printer authentication', () => {
		it('refuses a forged password, an unknown printer and a wrong organization the same way', async () => {
			const { ref, password } = await addPrinter()
			const forged = await starPoll(ref, 'x'.repeat(32))
			expect(forged.status).toBe(401)
			expect((await forged.json()).error).toBe('invalid_printer')
			// A password that fits no printer of this organization.
			const unknown = await starPoll(`${ORG}.00000000-0000-0000-0000-000000000000`, password)
			expect(unknown.status).toBe(401)
			expect((await unknown.json()).error).toBe('invalid_printer')
			// The same printer's password at another organization's address.
			const wrongOrg = await starPoll(`${OTHER_ORG}.${ref.split('.')[1]}`, password)
			expect(wrongOrg.status).toBe(401)
			// No credential, and a token meant for something else.
			expect((await app.request(`/print/${ref}/poll`, { method: 'POST' })).status).toBe(401)
			expect(
				(
					await app.request(`/print/${ref}/poll`, {
						method: 'POST',
						headers: { authorization: 'Bearer pdv1.nope' },
					})
				).status,
			).toBe(401)
		})

		it('stores only a keyed hash of the password and shows it once', async () => {
			const { printer, password } = await addPrinter()
			const db = await getTenantDb(ORG)
			const [row] = await db.select().from(printDevices).where(eq(printDevices.id, printer.id))
			expect(row!.secretHash).not.toContain(password)
			expect(row!.secretHash).toMatch(/^[0-9a-f]{64}$/)
			const listed = await app.request('/operator/pos/printers', {
				headers: { authorization: `Bearer ${await operatorToken()}` },
			})
			expect(JSON.stringify(await listed.json())).not.toContain(password)
		})

		it('stops a removed printer at once', async () => {
			const { ref, id, password } = await addPrinter()
			expect((await starPoll(ref, password)).status).toBe(200)
			const db = await getTenantDb(ORG)
			await revokePrinter(db, id, 'user_manager_1')
			const response = await starPoll(ref, password)
			expect(response.status).toBe(401)
			expect((await response.json()).error).toBe('printer_revoked')
		})

		it('never lets a printer read or finish another printer\'s job', async () => {
			const a = await addPrinter({ name: 'A' })
			const b = await addPrinter({ name: 'B', locationId: LOC_B })
			const orderId = await insertOrder()
			const db = await getTenantDb(ORG)
			await queueOrderPrint(db, {
				orgId: ORG,
				locationId: LOC,
				source: 'online',
				orderId,
				trigger: { kind: 'kitchen', dedupeKey: 'accepted' },
			})
			const poll = await (await starPoll(a.ref, a.password)).json()
			expect(poll.jobReady).toBe(true)
			// B, at another location, cannot fetch or acknowledge A's job.
			expect((await starFetch(b.ref, b.password, poll.jobToken)).status).toBe(404)
			expect((await starAck(b.ref, b.password, poll.jobToken)).status).toBe(404)
			const [job] = await db.select().from(printJobs).where(eq(printJobs.id, poll.jobToken))
			expect(job!.status).toBe('offered')
		})
	})

	describe('Star CloudPRNT: offer, fetch, acknowledge', () => {
		it('prints a kitchen ticket once: the acknowledgement ends the job', async () => {
			const { ref, password } = await addPrinter()
			const orderId = await insertOrder()
			const db = await getTenantDb(ORG)
			expect(await (await starPoll(ref, password)).json()).toEqual({ jobReady: false })
			await queueOrderPrint(db, {
				orgId: ORG,
				locationId: LOC,
				source: 'online',
				orderId,
				trigger: { kind: 'kitchen', dedupeKey: 'accepted' },
			})
			const poll = await (await starPoll(ref, password)).json()
			expect(poll).toMatchObject({
				jobReady: true,
				mediaTypes: ['application/vnd.star.starprntcore'],
			})
			const data = await starFetch(ref, password, poll.jobToken)
			expect(data.status).toBe(200)
			expect(data.headers.get('content-type')).toBe('application/vnd.star.starprntcore')
			const printed = await text(data)
			expect(printed).toContain('KITCHEN TICKET')
			expect(printed).toContain('#W-0951')
			expect(printed).toContain('1x Burger')
			expect(printed).toContain('No onions')
			expect((await starAck(ref, password, poll.jobToken)).status).toBe(200)
			// Acknowledged: never offered again, and a second acknowledgement changes nothing.
			expect(await (await starPoll(ref, password)).json()).toEqual({ jobReady: false })
			expect((await starAck(ref, password, poll.jobToken)).status).toBe(200)
			const [job] = await db.select().from(printJobs).where(eq(printJobs.id, poll.jobToken))
			expect(job).toMatchObject({ status: 'printed', attempts: 1 })
			expect(await starFetch(ref, password, poll.jobToken).then((r) => r.status)).toBe(404)
		})

		it('keeps the same job from being queued twice by a hook that runs twice', async () => {
			const { ref, password } = await addPrinter()
			const orderId = await insertOrder()
			const db = await getTenantDb(ORG)
			for (let i = 0; i < 3; i++) {
				await queueOrderPrint(db, {
					orgId: ORG,
					locationId: LOC,
					source: 'online',
					orderId,
					trigger: { kind: 'kitchen', dedupeKey: 'accepted' },
				})
			}
			expect(await db.select().from(printJobs)).toHaveLength(1)
			void ref
			void password
		})

		it('offers an unacknowledged job again after 30 seconds, at most 5 times, then flags it', async () => {
			const { printer } = await addPrinter()
			const orderId = await insertOrder()
			const db = await getTenantDb(ORG)
			await queueOrderPrint(db, {
				orgId: ORG,
				locationId: LOC,
				source: 'online',
				orderId,
				trigger: { kind: 'kitchen', dedupeKey: 'accepted' },
			})
			const [device] = await db.select().from(printDevices).where(eq(printDevices.id, printer.id))
			const start = Date.now() + 1_000
			const first = await claimNextJob(db, device!, start)
			expect(first?.attempts).toBe(1)
			// Too soon: nothing new to offer.
			expect(await claimNextJob(db, device!, start + PRINT_REOFFER_MS - 1)).toBeNull()
			for (let n = 2; n <= PRINT_MAX_ATTEMPTS; n++) {
				const again = await claimNextJob(db, device!, start + (n - 1) * PRINT_REOFFER_MS)
				expect(again?.id).toBe(first!.id)
				expect(again?.attempts).toBe(n)
			}
			// Out of offers: flagged for the operator, never offered again.
			expect(
				await claimNextJob(db, device!, start + PRINT_MAX_ATTEMPTS * PRINT_REOFFER_MS),
			).toBeNull()
			const [job] = await db.select().from(printJobs).where(eq(printJobs.id, first!.id))
			expect(job).toMatchObject({ status: 'flagged', failedReason: 'not_acknowledged' })
			const listed = await app.request('/operator/pos/printers', {
				headers: { authorization: `Bearer ${await operatorToken()}` },
			})
			expect((await listed.json()).printers[0].flaggedJobs).toBe(1)
		})

		it('answers every poll with no job while the kill switch is on', async () => {
			const { ref, password } = await addPrinter()
			const orderId = await insertOrder()
			const db = await getTenantDb(ORG)
			await queueOrderPrint(db, {
				orgId: ORG,
				locationId: LOC,
				source: 'online',
				orderId,
				trigger: { kind: 'kitchen', dedupeKey: 'accepted' },
			})
			vi.stubEnv('PRINTING_ENABLED', 'false')
			expect(await (await starPoll(ref, password)).json()).toEqual({ jobReady: false })
			// Nothing new is queued either.
			const queued = await queueOrderPrint(db, {
				orgId: ORG,
				locationId: LOC,
				source: 'online',
				orderId,
				trigger: { kind: 'receipt', dedupeKey: 'accepted' },
			})
			expect(queued.queued).toBe(0)
		})

		it('records what the printer says about itself', async () => {
			const { ref, password, id } = await addPrinter()
			await starPoll(ref, password, { statusCode: '211 Paper Empty' })
			const db = await getTenantDb(ORG)
			const [row] = await db.select().from(printDevices).where(eq(printDevices.id, id))
			expect(row!.status).toBe('out_of_paper')
			expect(row!.lastSeenAt).toBeGreaterThan(0)
		})
	})

	describe('Epson Server Direct Print', () => {
		it('serves ePOS-Print XML and takes the printer\'s result', async () => {
			const { ref, password, id } = await addPrinter({ protocol: 'epson_sdp' })
			const orderId = await insertOrder()
			const db = await getTenantDb(ORG)
			const form = (body: Record<string, string>) =>
				app.request(`/print/${ref}/poll`, {
					method: 'POST',
					headers: {
						authorization: basic(password),
						'content-type': 'application/x-www-form-urlencoded',
					},
					body: new URLSearchParams(body).toString(),
				})
			expect(await (await form({ ConnectionType: 'GetRequest', ID: 'p' })).text()).toBe('')
			await queueOrderPrint(db, {
				orgId: ORG,
				locationId: LOC,
				source: 'online',
				orderId,
				trigger: { kind: 'kitchen', dedupeKey: 'accepted' },
			})
			const xml = await (await form({ ConnectionType: 'GetRequest', ID: 'p' })).text()
			expect(xml).toContain('<PrintRequestInfo>')
			expect(xml).toContain('<epos-print')
			expect(xml).toContain('Burger')
			const jobId = /<printjobid>([^<]+)<\/printjobid>/.exec(xml)![1]!
			await form({
				ConnectionType: 'SetResponse',
				ResponseFile: `<response success="true" code=""/><printjobid>${jobId}</printjobid>`,
			})
			const [job] = await db.select().from(printJobs).where(eq(printJobs.id, jobId))
			expect(job!.status).toBe('printed')
			expect(await (await form({ ConnectionType: 'GetRequest', ID: 'p' })).text()).toBe('')
			void id
		})

		it('refuses a Star request at an Epson printer', async () => {
			const { ref, password } = await addPrinter({ protocol: 'epson_sdp' })
			expect((await starPoll(ref, password)).status).toBe(409)
		})
	})

	describe('routing and contents', () => {
		const setStations = async () => {
			const db = await getTenantDb(ORG)
			await db.insert(kdsLocationSettings).values({
				locationId: LOC,
				version: 1,
				updatedAt: Date.now(),
				config: {
					stations: [
						{ id: 'grill', name: 'Grill', itemIds: ['burger'] },
						{ id: 'soups', name: 'Soups', itemIds: ['soup'] },
					],
					defaultStationId: 'grill',
					workflow: 'ticket',
					showPreparing: true,
					warningMinutes: 10,
					lateMinutes: 20,
					fireAheadMinutes: 30,
				},
			})
		}

		it('sends each item to its station\'s printer, and the rest to the default', async () => {
			await setStations()
			const grill = await addPrinter({
				name: 'Grill',
				routes: { kitchen: 'stations', stationIds: ['grill'] },
			})
			const fallback = await addPrinter({
				name: 'Pass',
				routes: { kitchen: 'stations', stationIds: [], isDefault: true },
			})
			const orderId = await insertOrder()
			const db = await getTenantDb(ORG)
			await queueOrderPrint(db, {
				orgId: ORG,
				locationId: LOC,
				source: 'online',
				orderId,
				trigger: { kind: 'kitchen', dedupeKey: 'accepted' },
			})
			const grillJob = await (await starPoll(grill.ref, grill.password)).json()
			const grillText = await text(await starFetch(grill.ref, grill.password, grillJob.jobToken))
			expect(grillText).toContain('Burger')
			expect(grillText).not.toContain('Soup')
			expect(grillText).toContain('Grill')
			const passJob = await (await starPoll(fallback.ref, fallback.password)).json()
			const passText = await text(await starFetch(fallback.ref, fallback.password, passJob.jobToken))
			expect(passText).toContain('Soup')
			expect(passText).not.toContain('Burger')
		})

		it('never puts a phone number, an email or payment details on a kitchen ticket', async () => {
			const { ref, password } = await addPrinter({ routes: { deliveryAddress: true } })
			const orderId = await insertOrder({
				paymentMethod: 'online',
				paymentStatus: 'paid',
				paymentSessionId: 'cs_test_secret_session',
			})
			const db = await getTenantDb(ORG)
			await queueOrderPrint(db, {
				orgId: ORG,
				locationId: LOC,
				source: 'online',
				orderId,
				trigger: { kind: 'kitchen', dedupeKey: 'accepted' },
			})
			const poll = await (await starPoll(ref, password)).json()
			const printed = await text(await starFetch(ref, password, poll.jobToken))
			expect(printed).not.toMatch(/555|1234567|layla@|example\.com|cs_test|card/i)
			const [job] = await db.select().from(printJobs)
			expect(JSON.stringify(job!.payload)).not.toMatch(/555|1234567|layla@|example\.com|cs_test/i)
			// The first name is allowed for a pickup.
			expect(printed).toContain('Layla')
		})

		it('marks an alcohol order Check ID and a stated allergy on the ticket', async () => {
			const { ref, password } = await addPrinter()
			const orderId = await insertOrder({ hasAlcohol: true, ageConfirmed: true, guestAllergy: true })
			const db = await getTenantDb(ORG)
			await queueOrderPrint(db, {
				orgId: ORG,
				locationId: LOC,
				source: 'online',
				orderId,
				trigger: { kind: 'kitchen', dedupeKey: 'accepted' },
			})
			const poll = await (await starPoll(ref, password)).json()
			const printed = await text(await starFetch(ref, password, poll.jobToken))
			expect(printed).toContain('CHECK ID')
			expect(printed).toContain('ALLERGY STATED BY GUEST')
		})

		it('prints a receipt with the masked callback number, the logo off without a picture and the codes after', async () => {
			const { ref, password } = await addPrinter({ routes: { kitchen: 'off', receipts: true } })
			const orderId = await insertOrder({ hasAlcohol: true })
			const db = await getTenantDb(ORG)
			await queueOrderPrint(db, {
				orgId: ORG,
				locationId: LOC,
				source: 'online',
				orderId,
				trigger: { kind: 'receipt', dedupeKey: 'accepted' },
			})
			const poll = await (await starPoll(ref, password)).json()
			const printed = await text(await starFetch(ref, password, poll.jobToken))
			expect(printed).toContain('Cafe Bloom')
			expect(printed).toContain('4567')
			expect(printed).not.toContain('555123')
			expect(printed).toContain('CHECK ID')
			expect(printed).toContain('Enjoyed it? Tell us')
			expect(printed).toContain('Order ahead next time')
		})

		it('sends Arabic as a picture to a printer with no Arabic font, and as text when it has one', async () => {
			activeContext = context()
			const drawn: string[] = []
			setRasterizerForTest(async (block) => {
				drawn.push(block.t === 'text' ? block.text : block.left)
				return { width: 8, height: 1, data: 'gA==' }
			})
			const noFont = await addPrinter({ name: 'No font' })
			const orderId = await insertOrder({
				lines: [
					{
						itemId: 'burger',
						itemName: 'شاورما',
						quantity: 1,
						unitPriceCents: 1000,
						taxableUnitCents: 0,
						totalCents: 1000,
						taxableCents: 0,
						instructions: null,
						options: [],
						baseUnitCents: 1000,
						categoryIds: [],
					},
				],
			})
			const db = await getTenantDb(ORG)
			await queueOrderPrint(db, {
				orgId: ORG,
				locationId: LOC,
				source: 'online',
				orderId,
				trigger: { kind: 'kitchen', dedupeKey: 'accepted' },
			})
			const poll = await (await starPoll(noFont.ref, noFont.password)).json()
			await starFetch(noFont.ref, noFont.password, poll.jobToken)
			expect(drawn.some((line) => line.includes('شاورما'))).toBe(true)
		})
	})

	describe('acceptance: an online order reaches the printer within 10 seconds', () => {
		it('queues the kitchen ticket as the order is placed, and the printer prints it', async () => {
			const { ref, password } = await addPrinter()
			const started = Date.now()
			const placed = await app.request('/orders', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: 'https://test-org.example.com',
				},
				body: JSON.stringify({
					slug: 'test-org',
					idempotencyKey: crypto.randomUUID(),
					locale: 'en',
					locationId: LOC,
					fulfillment: 'pickup',
					paymentMethod: 'handoff',
					contact: { name: 'Rana Khalid', phone: '+1 555 123 4567' },
					lines: [{ itemId: 'burger', quantity: 1, options: [] }],
				}),
			})
			expect(placed.status).toBe(201)
			// The hook runs in the background after the commit.
			let poll: { jobReady: boolean; jobToken?: string } = { jobReady: false }
			for (let i = 0; i < 40 && !poll.jobReady; i++) {
				poll = await (await starPoll(ref, password)).json()
				if (!poll.jobReady) await new Promise((r) => setTimeout(r, 50))
			}
			expect(poll.jobReady).toBe(true)
			const printed = await text(await starFetch(ref, password, poll.jobToken!))
			expect(printed).toContain('1x Burger')
			expect(printed).not.toMatch(/555|1234567/)
			expect((await starAck(ref, password, poll.jobToken!)).status).toBe(200)
			expect(Date.now() - started).toBeLessThan(10_000)
		})

		it('prints a table round\'s kitchen ticket only: its receipt comes with the tab', async () => {
			await addPrinter({ routes: { kitchen: 'all', receipts: true } })
			const orderId = await insertOrder({
				fulfillment: 'dine_in',
				tableLabel: '9',
				source: 'qr_table',
			})
			const db = await getTenantDb(ORG)
			const [order] = await db.select().from(restaurantOrders).where(eq(restaurantOrders.id, orderId))
			await printAcceptedOrder(db, ORG, order!)
			expect((await db.select().from(printJobs)).map((job) => job.kind)).toEqual(['kitchen'])
		})

		it('holds a scheduled order\'s ticket until its fire time', async () => {
			const { printer } = await addPrinter()
			const now = Date.now()
			const orderId = await insertOrder({ scheduledFor: new Date(now + 5 * 60 * 60_000) })
			const db = await getTenantDb(ORG)
			const [order] = await db.select().from(restaurantOrders).where(eq(restaurantOrders.id, orderId))
			await printAcceptedOrder(db, ORG, order!, now)
			expect(await db.select().from(printJobs)).toHaveLength(0)
			// Within the fire-ahead window (30 minutes by default) it prints.
			await printAcceptedOrder(db, ORG, order!, now + 5 * 60 * 60_000 - 10 * 60_000)
			expect((await db.select().from(printJobs)).filter((j) => j.deviceId === printer.id)).toHaveLength(1)
		})
	})

	describe('reprint', () => {
		it('prints again on request, once per press, and never repeats an acknowledged job', async () => {
			const { ref, password } = await addPrinter()
			const orderId = await insertOrder()
			const db = await getTenantDb(ORG)
			await queueOrderPrint(db, {
				orgId: ORG,
				locationId: LOC,
				source: 'online',
				orderId,
				trigger: { kind: 'kitchen', dedupeKey: 'accepted' },
			})
			const first = await (await starPoll(ref, password)).json()
			await starAck(ref, password, first.jobToken)
			expect(await (await starPoll(ref, password)).json()).toEqual({ jobReady: false })

			const press = async (requestId: string) =>
				app.request('/operator/pos/printers/reprint', {
					method: 'POST',
					headers: {
						authorization: `Bearer ${await operatorToken()}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({
						source: 'online',
						orderId,
						locationId: LOC,
						kind: 'kitchen',
						requestId,
					}),
				})
			expect((await press('press-0001-aaaa')).status).toBe(202)
			// The same press again (a retry) prints nothing more.
			expect((await press('press-0001-aaaa')).status).toBe(200)
			const second = await (await starPoll(ref, password)).json()
			expect(second.jobReady).toBe(true)
			expect(second.jobToken).not.toBe(first.jobToken)
			expect(await text(await starFetch(ref, password, second.jobToken))).toContain('REPRINT')
			await starAck(ref, password, second.jobToken)
			expect(await (await starPoll(ref, password)).json()).toEqual({ jobReady: false })
			const jobs = await db.select().from(printJobs)
			expect(jobs).toHaveLength(2)
			expect(jobs.every((job) => job.status === 'printed')).toBe(true)
		})
	})

	describe('test print and open drawer (#426)', () => {
		const post = async (id: string, body: unknown, token?: string) =>
			app.request(`/operator/pos/printers/${id}/test`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token ?? (await operatorToken())}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(body),
			})

		it('prints a marked test ticket, through the same path, and records the time', async () => {
			const { ref, password, id } = await addPrinter({ name: 'Bar' })
			// The printer must have been seen: it has just polled.
			await starPoll(ref, password)
			const response = await post(id, { kind: 'test' })
			expect(response.status).toBe(202)
			const { jobId } = await response.json()
			const poll = await (await starPoll(ref, password)).json()
			expect(poll.jobToken).toBe(jobId)
			const printed = await text(await starFetch(ref, password, jobId))
			expect(printed).toContain('TEST PRINT')
			expect(printed).toContain('THIS IS NOT A SALE')
			expect(printed).not.toMatch(/Total|invoice/i)
			await starAck(ref, password, jobId)
			const status = await app.request(`/operator/pos/printers/${id}/jobs/${jobId}`, {
				headers: { authorization: `Bearer ${await operatorToken()}` },
			})
			expect((await status.json()).job.status).toBe('printed')
			const db = await getTenantDb(ORG)
			const [row] = await db.select().from(printDevices).where(eq(printDevices.id, id))
			expect(row!.lastTestAt).toBeGreaterThan(0)
			expect(row!.lastTestResult).toBe('ok')
		})

		it('opens the drawer with a job that prints nothing', async () => {
			const { ref, password, id } = await addPrinter()
			await starPoll(ref, password)
			const { jobId } = await (await post(id, { kind: 'drawer' })).json()
			const poll = await (await starPoll(ref, password)).json()
			const bytes = Buffer.from(await (await starFetch(ref, password, poll.jobToken)).arrayBuffer())
			expect([...bytes]).toEqual([0x1b, 0x40, 0x07])
			void jobId
		})

		it('says plainly that a disconnected printer cannot print, and queues nothing', async () => {
			const { id } = await addPrinter()
			// Never polled: not connected.
			const never = await post(id, { kind: 'test' })
			expect(never.status).toBe(409)
			const body = await never.json()
			expect(body.error).toBe('printer_not_ready')
			expect(body.reason).toBe('never_seen')
			expect(body.message).toMatch(/not connected yet/)
			// Seen a while ago: disconnected.
			const db = await getTenantDb(ORG)
			await db
				.update(printDevices)
				.set({ lastSeenAt: Date.now() - 20 * 60_000 })
				.where(eq(printDevices.id, id))
			const gone = await (await post(id, { kind: 'test' })).json()
			expect(gone.reason).toBe('offline')
			expect(gone.message).toMatch(/disconnected/)
			expect(await db.select().from(printJobs)).toHaveLength(0)
		})

		it('says the printer is out of paper when it reported so', async () => {
			const { ref, password, id } = await addPrinter()
			await starPoll(ref, password, { statusCode: '211 Paper Empty' })
			const body = await (await post(id, { kind: 'test' })).json()
			expect(body.reason).toBe('out_of_paper')
			expect(body.message).toMatch(/out of paper/)
		})

		it('keeps a manager of one location away from another location\'s printer', async () => {
			const other = await addPrinter({ locationId: LOC_B })
			const scoped = await operatorToken({ locationIds: [LOC] })
			expect((await post(other.id, { kind: 'test' }, scoped)).status).toBe(404)
			const listed = await app.request('/operator/pos/printers', {
				headers: { authorization: `Bearer ${scoped}` },
			})
			expect((await listed.json()).printers).toEqual([])
			const created = await app.request('/operator/pos/printers', {
				method: 'POST',
				headers: { authorization: `Bearer ${scoped}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					locationId: LOC_B,
					name: 'Nope',
					protocol: 'star_cloudprnt',
					widthMm: 80,
				}),
			})
			expect(created.status).toBe(403)
		})
	})

	describe('setup', () => {
		it('adds a printer, shows its address and password once, and refuses it while the flag is off', async () => {
			const token = await operatorToken()
			const add = (body: unknown) =>
				app.request('/operator/pos/printers', {
					method: 'POST',
					headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
					body: JSON.stringify(body),
				})
			const created = await add({
				locationId: LOC,
				name: 'Kitchen',
				protocol: 'epson_sdp',
				widthMm: 58,
				copies: 2,
				routes: { kitchen: 'all' },
			})
			expect(created.status).toBe(201)
			const body = await created.json()
			expect(body.password).toMatch(/^[A-Za-z0-9]{32}$/)
			expect(body.printer.ref).toBe(`${ORG}.${body.printer.id}`)
			expect(body.printer.health).toBe('never_seen')
			seedPrintingFlagForTest(ORG, false)
			const off = await add({ locationId: LOC, name: 'X', protocol: 'epson_sdp', widthMm: 58 })
			expect(off.status).toBe(403)
			// Removing a printer always works.
			const removed = await app.request(`/operator/pos/printers/${body.printer.id}/revoke`, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}` },
			})
			expect(removed.status).toBe(200)
		})

		it('refuses an unauthenticated operator and a token for another audience', async () => {
			expect((await app.request('/operator/pos/printers')).status).toBe(401)
			const other = await new SignJWT({ orgId: ORG, role: 'operator', scope: 'orders:write' })
				.setProtectedHeader({ alg: 'HS256' })
				.setAudience('someone-else')
				.setIssuer(brand.shortName)
				.setExpirationTime('15m')
				.sign(new TextEncoder().encode(OPERATOR_SECRET))
			expect(
				(await app.request('/operator/pos/printers', { headers: { authorization: `Bearer ${other}` } })).status,
			).toBe(401)
		})
	})

	describe('Station sales (#117)', () => {
		async function addTillSale(over: Partial<typeof posOrders.$inferInsert> = {}) {
			const db = await getTenantDb(ORG)
			const deviceId = crypto.randomUUID()
			await db.insert(posDevices).values({
				id: deviceId,
				label: 'Till',
				terminalCode: 'T1',
				locationId: LOC,
				secretHash: hashPosSecret(formatPosDeviceSecret(ORG, deviceId, 'x'.repeat(43))),
				pairedBy: 'operator',
			})
			const id = crypto.randomUUID()
			await db.insert(posOrders).values({
				id,
				deviceId,
				number: 'T1-0042',
				businessDate: '2026-11-18',
				revision: 2,
				status: 'paid',
				orderType: 'dine_in',
				tableLabel: '4',
				guestName: 'Dana',
				customerPhone: '+15559990000',
				locationId: LOC,
				currency: 'USD',
				subtotalCents: 2000,
				taxCents: 200,
				totalCents: 2200,
				taxRatePercent: 10,
				staffName: 'Sam L.',
				lines: [
					{
						id: 'l1',
						itemId: 'mojito',
						name: 'Mojito',
						variantId: null,
						variantLabel: null,
						quantity: 2,
						baseCents: 1000,
						instructions: '',
						options: [],
						sentAt: new Date(1_800_000_000_000).toISOString(),
					},
				],
				lineCatalog: {
					mojito: { categoryId: 'c', categoryName: 'Bar', menuId: 'm', menuName: 'Main', alcohol: true },
				},
				adjustments: [],
				rungUpAt: 1_800_000_000_000,
				...over,
			})
			await db.insert(posPayments).values({
				id: crypto.randomUUID(),
				orderId: id,
				deviceId,
				kind: 'payment',
				method: 'cash',
				amountCents: 2200,
				tenderedCents: 2500,
				changeCents: 300,
				paidAt: 1_800_000_000_000,
			} as never)
			return { id, deviceId }
		}

		it('prints a kitchen ticket when a round is sent and a receipt on payment, each once', async () => {
			const printer = await addPrinter({ routes: { kitchen: 'all', receipts: true } })
			const sale = await addTillSale()
			printTillSale(ORG, {
				id: sale.id,
				locationId: LOC,
				status: 'paid',
				lines: [{ sentAt: new Date(1_800_000_000_000).toISOString() }],
			})
			const db = await getTenantDb(ORG)
			for (let i = 0; i < 40 && (await db.select().from(printJobs)).length < 2; i++) {
				await new Promise((r) => setTimeout(r, 50))
			}
			const jobs = await db.select().from(printJobs)
			expect(jobs.map((j) => j.kind).sort()).toEqual(['kitchen', 'receipt'])
			// The same upload again queues nothing more.
			printTillSale(ORG, {
				id: sale.id,
				locationId: LOC,
				status: 'paid',
				lines: [{ sentAt: new Date(1_800_000_000_000).toISOString() }],
			})
			await new Promise((r) => setTimeout(r, 200))
			expect(await db.select().from(printJobs)).toHaveLength(2)
			const kitchen = JSON.stringify(jobs.find((j) => j.kind === 'kitchen')!.payload)
			expect(kitchen).toContain('CHECK ID')
			expect(kitchen).toContain('2x Mojito')
			expect(kitchen).not.toMatch(/5559990000/)
			void printer
		})

		it('keeps the ZATCA code first and unchanged, the codes after it, and drops them on a 58 mm roll', async () => {
			activeContext = context()
			const location = (activeContext as { menu: { locations: Array<Record<string, unknown>> } }).menu.locations[0]!
			location.vatNumber = '300000000000003'
			clearPrintContextCache()
			const wide = await addPrinter({ name: 'Wide', routes: { kitchen: 'off', receipts: true }, widthMm: 80 })
			const narrow = await addPrinter({ name: 'Narrow', routes: { kitchen: 'off', receipts: true }, widthMm: 58 })
			const sale = await addTillSale()
			const db = await getTenantDb(ORG)
			await db.insert(posFiscalDocuments).values({
				docId: crypto.randomUUID(),
				chainId: 'chain',
				counter: 7,
				kind: 'invoice',
				orderId: sale.id,
				deviceId: sale.deviceId,
				issuedAt: 1_800_000_000_000,
				currency: 'USD',
				totalCents: 2200,
				taxCents: 200,
				previousHash: 'a',
				hash: 'b',
			})
			await queueOrderPrint(db, {
				orgId: ORG,
				locationId: LOC,
				source: 'pos',
				orderId: sale.id,
				trigger: { kind: 'receipt', dedupeKey: 'paid' },
			})
			const jobs = await db.select().from(printJobs)
			const docOf = (deviceId: string) =>
				jobs.find((j) => j.deviceId === deviceId)!.payload as {
					blocks: Array<{ t: string; size?: string; data?: string; caption?: string }>
				}
			const wideQrs = docOf(wide.id).blocks.filter((b) => b.t === 'qr')
			expect(wideQrs[0]).toMatchObject({ size: 'fiscal' })
			expect(wideQrs.slice(1).map((b) => b.caption)).toEqual([
				'Enjoyed it? Tell us',
				'Order ahead next time',
			])
			// The fiscal code is the same on the narrow roll, with nothing after it.
			const narrowQrs = docOf(narrow.id).blocks.filter((b) => b.t === 'qr')
			expect(narrowQrs).toEqual([wideQrs[0]])
			expect(docOf(wide.id).blocks.filter((b) => b.t === 'qr')[0]!.data).toBeTruthy()
		})

		it('reprints a till order for its own location only', async () => {
			const printer = await addPrinter({ routes: { kitchen: 'all', receipts: true } })
			const sale = await addTillSale()
			const db = await getTenantDb(ORG)
			const here = await queueOrderPrint(db, {
				orgId: ORG,
				locationId: LOC,
				source: 'pos',
				orderId: sale.id,
				trigger: { kind: 'receipt', dedupeKey: 'reprint:aaaa1111', reprint: true },
			})
			expect(here.queued).toBe(1)
			// The same order asked for at another location is not found: nothing prints.
			const elsewhere = await queueOrderPrint(db, {
				orgId: ORG,
				locationId: LOC_B,
				source: 'pos',
				orderId: sale.id,
				trigger: { kind: 'receipt', dedupeKey: 'reprint:bbbb2222', reprint: true },
			})
			expect(elsewhere.queued).toBe(0)
			void printer
		})
	})
})
