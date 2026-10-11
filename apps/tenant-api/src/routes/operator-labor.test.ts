import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brand } from '@repo/config/brand.ts'
import { addDays, localDateOf, zonedWallTimeToUtc } from '@repo/staffing'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
	staffEvents,
	timeEntries,
} from '@repo/tenant-db'
import { operatorStaffingRoutes } from './operator-staffing.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(async (id: string) => ({
		id,
		slug: id,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	})),
}))
vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({ status: 'success' }),
}))

const orgA = 'clw9x0a12000008l0labor001'
const operatorSecret = 'test-operator-token-labor-12345'
const TZ = 'America/New_York'
const LOCATIONS = [
	{ id: 'loc_main', tz: TZ, currency: 'USD' },
	{ id: 'loc_second', tz: 'America/Chicago', currency: 'USD' },
	{ id: 'loc_unpriced', tz: TZ },
]

async function mint(claims: Record<string, unknown> = {}) {
	return new SignJWT({
		orgId: orgA,
		role: 'operator',
		scope: 'staffing',
		areas: { staff: 'write', schedule: 'write', timeclock: 'write' },
		locationIds: null,
		locations: LOCATIONS,
		canViewPay: true,
		...claims,
	})
		.setSubject('user_owner')
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(operatorSecret))
}

describe('labor', () => {
	let tempDir: string
	let app: Hono
	const day = addDays(localDateOf(new Date(), TZ), -3)

	async function call(
		method: string,
		pathname: string,
		token: string,
		body?: unknown,
	) {
		const response = await app.request(`/operator/staffing${pathname}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		return {
			status: response.status,
			body: (await response.json()) as Record<string, any>,
		}
	}

	async function setup() {
		const token = await mint()
		const cook = await call('POST', '/positions', token, { name: 'Cook' })
		const cookId = cook.body.position.id as string
		const staff = async (firstName: string) =>
			(
				await call('POST', '/staff', token, {
					firstName,
					assignments: [
						{ locationId: 'loc_main', positionId: cookId },
						{ locationId: 'loc_unpriced', positionId: cookId },
					],
				})
			).body.staff.id as string
		return {
			token,
			cookId,
			anaId: await staff('Ana'),
			benId: await staff('Ben'),
		}
	}

	const setRate = (
		token: string,
		staffId: string,
		positionId: string,
		rateCents: number | null,
		locationId = 'loc_main',
	) =>
		call('PUT', `/staff/${staffId}/rates`, token, {
			rates: [{ locationId, positionId, rateCents }],
		})

	const card = (
		token: string,
		staffId: string,
		clockIn: string,
		clockOut: string,
		unpaidBreakMinutes = 0,
	) =>
		call('POST', '/time-entries', token, {
			locationId: 'loc_main',
			staffId,
			positionId: null,
			localDate: day,
			clockIn,
			clockOut,
			unpaidBreakMinutes,
		})

	async function order(
		overrides: Partial<typeof restaurantOrders.$inferInsert>,
	) {
		const db = await getTenantDb(orgA)
		await db.insert(restaurantOrders).values({
			orgId: orgA,
			number: randomUUID().slice(0, 8),
			status: 'completed',
			paymentMethod: 'online',
			paymentStatus: 'paid',
			fulfillment: 'pickup',
			locationId: 'loc_main',
			locationName: 'Main',
			contactName: 'Customer',
			contactPhone: '+15555550100',
			currency: 'usd',
			subtotalCents: 0,
			taxCents: 0,
			totalCents: 0,
			lines: [],
			idempotencyKey: randomUUID(),
			requestHash: 'hash',
			receiptTokenHash: randomUUID(),
			createdAt: zonedWallTimeToUtc(day, '12:00', TZ),
			...overrides,
		})
	}

	async function summary(token: string, from = day, to = day) {
		return call(
			'GET',
			`/labor-summary?locationId=loc_main&from=${from}&to=${to}`,
			token,
		)
	}

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-labor-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.NODE_ENV = 'test'
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-for-labor'
		process.env.STAFFING_EMAIL_ENABLED = 'false'
		await provisionTenantDb(orgA)
		app = new Hono()
		app.route('/operator/staffing', operatorStaffingRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgA)
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('sets rates only with pay access and hides them from everyone else', async () => {
		const { token, cookId, anaId } = await setup()
		const noPay = await mint({ canViewPay: false })

		expect((await setRate(noPay, anaId, cookId, 1800)).body).toEqual({
			error: 'pay_required',
		})
		const saved = await setRate(token, anaId, cookId, 1800)
		expect(saved.status).toBe(200)
		expect(saved.body.staff.assignments).toContainEqual(
			expect.objectContaining({
				locationId: 'loc_main',
				rateCents: 1800,
				currency: 'USD',
			}),
		)

		const hidden = await call('GET', '/staff', noPay)
		const ana = hidden.body.staff.find((item: any) => item.id === anaId)
		expect(ana.assignments[0]).not.toHaveProperty('rateCents')
		expect(ana.assignments[0]).not.toHaveProperty('currency')

		// A roster edit by someone without pay keeps the rate.
		const edited = await call('PATCH', `/staff/${anaId}`, noPay, {
			firstName: 'Ana',
			lastName: 'Ruiz',
			assignments: [
				{ locationId: 'loc_main', positionId: cookId, isPrimary: true },
			],
		})
		expect(edited.status).toBe(200)
		const visible = await call('GET', '/staff', token)
		expect(
			visible.body.staff.find((item: any) => item.id === anaId).assignments,
		).toEqual([
			expect.objectContaining({ locationId: 'loc_main', rateCents: 1800 }),
		])

		expect(
			(await setRate(token, anaId, cookId, 1800, 'loc_second')).body.error,
		).toBe('unknown_assignment')
		expect((await setRate(token, anaId, 'missing', 1800)).body.error).toBe(
			'unknown_assignment',
		)
		expect((await setRate(token, anaId, cookId, -5)).body.error).toBe(
			'invalid_input',
		)

		// Amounts never reach the event log roster readers can see.
		const db = await getTenantDb(orgA)
		const events = await db
			.select()
			.from(staffEvents)
			.where(eq(staffEvents.kind, 'staff.rates_updated'))
		expect(events).toHaveLength(1)
		expect(JSON.stringify(events[0]!.detail)).not.toContain('1800')
	})

	it('refuses a rate where the location currency is unknown', async () => {
		const { token, cookId, anaId } = await setup()
		const result = await setRate(token, anaId, cookId, 1800, 'loc_unpriced')
		expect(result).toMatchObject({
			status: 400,
			body: { error: 'unknown_currency' },
		})
		// Clearing a rate needs no currency.
		expect(
			(await setRate(token, anaId, cookId, null, 'loc_unpriced')).status,
		).toBe(200)
	})

	it('matches a hand calculation of hours, cost, and online sales', async () => {
		const { token, cookId, anaId, benId } = await setup()
		await setRate(token, anaId, cookId, 1800)

		// Ana: 09:00-17:00 less 30 min = 7.5 h at 18.00 = 135.00.
		expect((await card(token, anaId, '09:00', '17:00', 30)).status).toBe(200)
		// Ben: 4 h with no rate yet.
		expect((await card(token, benId, '10:00', '14:00')).status).toBe(200)
		// A raise after the card was made does not rewrite it.
		await setRate(token, anaId, cookId, 2400)
		// Ana is scheduled 4 h, costed at today's 24.00 = 96.00.
		await call('POST', '/shifts', token, {
			shift: {
				locationId: 'loc_main',
				staffId: anaId,
				positionId: cookId,
				localDate: day,
				startTime: '09:00',
				endTime: '13:00',
			},
		})

		await order({ subtotalCents: 10_000, totalCents: 11_000 })
		await order({
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			status: 'accepted',
			subtotalCents: 5_000,
		})
		await order({ status: 'cancelled', subtotalCents: 9_999 })
		await order({ paymentStatus: 'pending', subtotalCents: 7_777 })
		await order({ locationId: 'loc_second', subtotalCents: 8_888 })
		await order({
			subtotalCents: 6_666,
			createdAt: zonedWallTimeToUtc(addDays(day, 1), '00:30', TZ),
		})

		const first = await summary(token)
		expect(first.status).toBe(200)
		expect(first.body.summary).toMatchObject({
			currency: 'USD',
			mixedCurrency: false,
			unratedWorkedMinutes: 240,
			unratedScheduledMinutes: 0,
			openEntries: 0,
			totals: {
				workedMinutes: 690,
				scheduledMinutes: 240,
				laborCents: 13_500,
				scheduledLaborCents: 9_600,
				salesCents: 15_000,
				orderCount: 2,
				laborPercent: 90,
				scheduledLaborPercent: 64,
			},
		})

		// Ben's later rate covers his earlier card until it is approved.
		await setRate(token, benId, cookId, 1500)
		const second = await summary(token)
		expect(second.body.summary.unratedWorkedMinutes).toBe(0)
		expect(second.body.summary.totals.laborCents).toBe(13_500 + 6_000)

		// Approval locks the rate onto the card.
		const sheet = await call(
			'GET',
			`/timesheets?locationId=loc_main&from=${day}&to=${day}`,
			token,
		)
		const ids = sheet.body.timesheet.entries.map((item: any) => item.id)
		await call('POST', '/time-entries/approve', token, {
			locationId: 'loc_main',
			entryIds: ids,
		})
		const db = await getTenantDb(orgA)
		const [benCard] = await db
			.select()
			.from(timeEntries)
			.where(eq(timeEntries.staffId, benId))
		expect(benCard).toMatchObject({ rateCents: 1500, currency: 'USD' })
		await setRate(token, benId, cookId, 9000)
		expect((await summary(token)).body.summary.totals.laborCents).toBe(19_500)
	})

	it('refuses to add amounts across currencies', async () => {
		const { token, cookId, anaId } = await setup()
		await setRate(token, anaId, cookId, 1800)
		await card(token, anaId, '09:00', '17:00')
		await order({ subtotalCents: 10_000 })
		await order({ currency: 'sar', subtotalCents: 20_000 })
		const result = await summary(token)
		expect(result.body.summary).toMatchObject({
			currency: null,
			mixedCurrency: true,
			totals: {
				workedMinutes: 480,
				laborCents: null,
				salesCents: null,
				orderCount: 2,
				laborPercent: null,
			},
		})
	})

	it('requires pay access and a known location', async () => {
		const noPay = await mint({ canViewPay: false })
		expect((await summary(noPay)).body.error).toBe('pay_required')
		const token = await mint()
		expect(
			(
				await call(
					'GET',
					`/labor-summary?locationId=elsewhere&from=${day}&to=${day}`,
					token,
				)
			).body.error,
		).toBe('unknown_location')
		expect((await summary(token, day, addDays(day, 40))).status).toBe(400)
	})
})
