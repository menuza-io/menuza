import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runBirthdayJourneys } from './birthday-journeys.ts'
import { insertOrder } from './loyalty-test-fixture.ts'
import { setOrderJourneySpawner } from './order-journeys.ts'
import { erasePerson } from './person-erasure-service.ts'

const ORG = 'clw9x0a12000008l00bday01'
// 2027-03-03 10:30 in UTC.
const MARCH_3 = Date.UTC(2027, 2, 3, 10, 30)

describe('birthday journeys (#151)', () => {
	let dir: string
	let db: TenantDatabase
	const spawn = vi.fn(async (..._args: unknown[]) => ({ success: true }))

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-birthday-'))
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

	async function listen(config: Record<string, unknown> = { daysBefore: 7 }) {
		const [row] = await db
			.insert(marketingJourneys)
			.values({
				name: 'Birthday',
				status: 'active',
				triggerType: 'birthday_coming_up',
				triggerConfig: config,
			})
			.returning()
		return row!.id
	}

	async function guest(id: string, birthMonthDay: string | null) {
		await db
			.insert(customers)
			.values({ id, name: id, phone: `+1555${id.length}${id}`, birthMonthDay })
	}

	it('starts the journey N days before the birthday once a year, and a later edit does not fire it again', async () => {
		const journey = await listen()
		await guest('a', '03-10')
		await guest('other', '06-01')
		await guest('nobday', null)
		await runBirthdayJourneys(ORG, { now: MARCH_3 })
		await runBirthdayJourneys(ORG, { now: MARCH_3 + 60_000 })
		expect(spawn).toHaveBeenCalledTimes(1)
		expect(spawn.mock.calls[0]!.slice(0, 3)).toEqual([ORG, 'birthday_coming_up', 'a'])
		expect(spawn.mock.calls[0]![5]).toEqual({ journeyId: journey })
		// Only the year travels in the run context: never the birthday.
		expect(JSON.stringify(spawn.mock.calls[0]![4])).toBe('{"birthdayYear":2027}')
		// The guest edits the birthday to another day near this one: not again this year.
		await db.update(customers).set({ birthMonthDay: '03-11' }).where(eq(customers.id, 'a'))
		await runBirthdayJourneys(ORG, { now: MARCH_3 + 24 * 3_600_000 })
		expect(spawn).toHaveBeenCalledTimes(1)
		// Next year it fires again.
		await db.update(customers).set({ birthMonthDay: '03-10' }).where(eq(customers.id, 'a'))
		await runBirthdayJourneys(ORG, { now: Date.UTC(2028, 2, 3, 10, 30) })
		expect(spawn).toHaveBeenCalledTimes(2)
	})

	it('waits for 10:00 local time in the guest\'s own zone', async () => {
		await listen({ daysBefore: 7, timeZone: 'Asia/Riyadh' })
		await guest('a', '03-10')
		// 06:30 UTC is 09:30 in Riyadh: not yet. 07:30 UTC is 10:30 there.
		await runBirthdayJourneys(ORG, { now: Date.UTC(2027, 2, 3, 6, 30) })
		expect(spawn).not.toHaveBeenCalled()
		await runBirthdayJourneys(ORG, { now: Date.UTC(2027, 2, 3, 7, 30) })
		expect(spawn).toHaveBeenCalledTimes(1)
	})

	it('the most recent order\'s location zone wins over the journey setting', async () => {
		await listen({ daysBefore: 7, timeZone: 'Asia/Riyadh' })
		await guest('a', '03-10')
		await insertOrder(ORG, {
			customerId: 'a',
			locationTimezone: 'America/Los_Angeles',
		})
		// 10:30 UTC is 02:30 in Los Angeles: not yet.
		await runBirthdayJourneys(ORG, { now: MARCH_3 })
		expect(spawn).not.toHaveBeenCalled()
		await runBirthdayJourneys(ORG, { now: Date.UTC(2027, 2, 3, 18, 30) })
		expect(spawn).toHaveBeenCalledTimes(1)
	})

	it('celebrates 29 February on 28 February in a non-leap year', async () => {
		await listen()
		await guest('leap', '02-29')
		// 2027 is not a leap year: 28 February, so 21 February is 7 days before.
		await runBirthdayJourneys(ORG, { now: Date.UTC(2027, 1, 21, 11, 0) })
		expect(spawn).toHaveBeenCalledTimes(1)
	})

	it('does nothing with no active birthday journey, and a paused one is not started', async () => {
		await guest('a', '03-10')
		await runBirthdayJourneys(ORG, { now: MARCH_3 })
		const id = await listen()
		await db.update(marketingJourneys).set({ status: 'paused' }).where(eq(marketingJourneys.id, id))
		await runBirthdayJourneys(ORG, { now: MARCH_3 })
		expect(spawn).not.toHaveBeenCalled()
	})

	it('erasing a person removes the birthday with the customer, and the cart and emissions', async () => {
		await listen()
		await guest('a', '03-10')
		await runBirthdayJourneys(ORG, { now: MARCH_3 })
		await db.insert(customerCarts).values({
			customerId: 'a',
			locationId: 'loc_1',
			currency: 'usd',
			subtotalCents: 1000,
			items: [{ itemId: 'x', quantity: 1 }],
		})
		await erasePerson(db, { customerId: 'a' }, { actorId: 'op_1' })
		const left = await db.select().from(customers).where(eq(customers.id, 'a')).all()
		expect(left).toEqual([])
		expect(await db.select().from(customerCarts).all()).toEqual([])
		expect(
			await db
				.select()
				.from(orderJourneyEmissions)
				.where(eq(orderJourneyEmissions.customerId, 'a'))
				.all(),
		).toEqual([])
	})
})
