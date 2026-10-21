import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	customerPaymentMethods,
	customerRefreshTokens,
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	journeyRuns,
	journeyStepExecutions,
	marketingCampaigns,
	marketingJourneys,
	marketingMessages,
	personErasureLog,
	provisionTenantDb,
	restaurantOrders,
	shopOrders,
	voiceCallRequests,
	voiceCalls,
	voiceSmsSends,
	websiteFormSubmissions,
	websiteForms,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { containsAsToken, erasePerson } from './person-erasure-service.ts'

const orgA = 'clw9x0a12000008l00erase1'
const orgB = 'clw9x0a12000008l00erase2'
const PHONE = '+15550001111'
const EMAIL = 'erase.me@example.test'
const NAME = 'Erin Erasable'
const OTHER_PHONE = '+15550002222'

/** Every row of every table, to prove an organization was not touched. */
async function snapshot(db: TenantDatabase) {
	const tables = (await db.all(
		sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`,
	)) as Array<{ name: string }>
	const rows: Record<string, unknown> = {}
	for (const { name } of tables) {
		rows[name] = await db.all(sql.raw(`select * from "${name}"`))
	}
	return JSON.stringify(rows)
}

/** Names of the tables whose rows still contain one of the strings. */
async function tablesContaining(db: TenantDatabase, needles: string[]) {
	const tables = (await db.all(
		sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`,
	)) as Array<{ name: string }>
	const found: string[] = []
	for (const { name } of tables) {
		const rows = JSON.stringify(
			await db.all(sql.raw(`select * from "${name}"`)),
		).toLowerCase()
		if (needles.some((needle) => rows.includes(needle.toLowerCase()))) {
			found.push(name)
		}
	}
	return found
}

/** One person with a row in every table that holds personal data. */
async function seedPerson(
	db: TenantDatabase,
	input: { name: string; phone: string; email: string },
) {
	const [customer] = await db
		.insert(customers)
		.values({
			name: input.name,
			phone: input.phone,
			email: input.email,
			phoneVerified: true,
			stripeCustomerId: `cus_${input.phone.slice(-4)}`,
			refreshTokenHash: `hash_${input.phone.slice(-4)}`,
		})
		.returning()
	const id = customer!.id
	await db.insert(customerRefreshTokens).values({
		customerId: id,
		tokenHash: `rt_${input.phone.slice(-4)}`,
		expiresAt: new Date(Date.now() + 60_000),
	})
	await db.insert(customerSubscriptions).values({
		customerId: id,
		topic: 'marketing',
		channel: 'sms',
		source: 'signup',
		subscribedAt: new Date(),
	})
	await db.insert(customerPaymentMethods).values({
		customerId: id,
		stripePaymentMethodId: `pm_${input.phone.slice(-4)}`,
		brand: 'visa',
		last4: '4242',
		expMonth: 12,
		expYear: 2034,
	})
	const [journey] = await db
		.insert(marketingJourneys)
		.values({ name: 'Welcome journey' })
		.returning()
	const [run] = await db
		.insert(journeyRuns)
		.values({ journeyId: journey!.id, customerId: id })
		.returning()
	await db.insert(journeyStepExecutions).values({
		runId: run!.id,
		journeyId: journey!.id,
		customerId: id,
		nodeId: 'n1',
		nodeType: 'trigger',
		stepType: 'trigger',
	} as never)
	const [campaign] = await db
		.insert(marketingCampaigns)
		.values({ name: 'Campaign', channel: 'sms', content: 'Hi' })
		.returning()
	await db.insert(marketingMessages).values({
		campaignId: campaign!.id,
		customerId: id,
		channel: 'sms',
	})
	await db.insert(shopOrders).values({
		customerId: id,
		productName: 'Pack',
		amountCents: 1000,
		platformFeeCents: 200,
		orgPayoutCents: 800,
		checkoutSessionId: `cs_${input.phone.slice(-4)}`,
	})
	const [call] = await db
		.insert(voiceCalls)
		.values({
			channel: 'phone',
			roomName: `room-${input.phone.slice(-4)}`,
			startedAt: new Date(),
			callerPhone: input.phone,
			customerId: id,
			summary: `${input.name} asked about hours`,
		})
		.returning()
	await db.insert(voiceCallRequests).values({
		callId: call!.id,
		type: 'callback',
		callerName: input.name,
		callerPhone: input.phone,
		details: { note: 'call me' },
	} as never)
	await db.insert(voiceSmsSends).values({
		callId: call!.id,
		kind: 'website_link',
		toPhone: input.phone,
		status: 'sent',
	})
	return id
}

describe('person erasure', () => {
	let tempDir: string
	let a: TenantDatabase
	let b: TenantDatabase

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-erase-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		await provisionTenantDb(orgA)
		await provisionTenantDb(orgB)
		a = await getTenantDb(orgA)
		b = await getTenantDb(orgB)
	})

	afterEach(async () => {
		await destroyTenantDb(orgA).catch(() => {})
		await destroyTenantDb(orgB).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	async function seedForm(db: TenantDatabase, text: string) {
		const [form] = await db
			.insert(websiteForms)
			.values({ name: 'Contact', fields: [] } as never)
			.returning()
		await db
			.insert(websiteFormSubmissions)
			.values({ formId: form!.id, values: { message: text } })
	}

	it('erases the customer and everything keyed by them, and keeps order totals', async () => {
		const id = await seedPerson(a, { name: NAME, phone: PHONE, email: EMAIL })
		await seedForm(a, `please call ${PHONE}`)
		await seedForm(a, `unrelated message`)
		expect(await tablesContaining(a, [PHONE])).toContain('customers')

		const result = await erasePerson(
			a,
			{ customerId: id },
			{ actorId: 'user_1' },
		)
		expect(result).toMatchObject({
			erased: true,
			alreadyErased: false,
			customersErased: 1,
			ordersUnlinked: 1,
			formSubmissionsRedacted: 1,
			voice: expect.objectContaining({ callsDeleted: 1 }),
		})

		expect(await tablesContaining(a, [PHONE, EMAIL, NAME])).toEqual([])
		for (const table of [
			customers,
			customerRefreshTokens,
			customerSubscriptions,
			customerPaymentMethods,
			journeyRuns,
			journeyStepExecutions,
			marketingMessages,
			voiceCalls,
			voiceCallRequests,
			voiceSmsSends,
		]) {
			expect(await a.select().from(table)).toEqual([])
		}
		const orders = await a.select().from(shopOrders)
		expect(orders).toHaveLength(1)
		expect(orders[0]).toMatchObject({ amountCents: 1000, customerId: null })
		const submissions = await a.select().from(websiteFormSubmissions)
		expect(submissions.map((s) => s.values)).toEqual(
			expect.arrayContaining([
				{ redacted: true },
				{ message: 'unrelated message' },
			]),
		)
	})

	it('leaves other customers of the same organization untouched', async () => {
		const id = await seedPerson(a, { name: NAME, phone: PHONE, email: EMAIL })
		const otherId = await seedPerson(a, {
			name: 'Olive Other',
			phone: OTHER_PHONE,
			email: 'olive@example.test',
		})
		await erasePerson(a, { customerId: id }, { actorId: 'user_1' })
		expect(await tablesContaining(a, [OTHER_PHONE, 'olive other'])).toContain(
			'customers',
		)
		const remaining = await a.select().from(customers)
		expect(remaining.map((c) => c.id)).toEqual([otherId])
		expect(await a.select().from(customerSubscriptions)).toHaveLength(1)
		expect(await a.select().from(voiceCalls)).toHaveLength(1)
	})

	it('never touches another organization, even for the same phone and id', async () => {
		const idA = await seedPerson(a, { name: NAME, phone: PHONE, email: EMAIL })
		const idB = await seedPerson(b, { name: NAME, phone: PHONE, email: EMAIL })
		await seedForm(b, `please call ${PHONE}`)
		const before = await snapshot(b)

		// The same person is a customer of both organizations. Erasing from A
		// must not reach B, and an id that only exists in B is a no-op in A.
		await erasePerson(a, { customerId: idA }, { actorId: 'user_1' })
		expect(await snapshot(b)).toBe(before)
		expect(await b.select().from(customers)).toHaveLength(1)

		const foreign = await erasePerson(
			a,
			{ customerId: idB },
			{ actorId: 'user_1' },
		)
		expect(foreign).toMatchObject({ alreadyErased: true, customersErased: 0 })
		expect(await snapshot(b)).toBe(before)

		await erasePerson(b, { customerId: idB }, { actorId: 'user_1' })
		expect(await tablesContaining(b, [PHONE])).toEqual([])
	})

	it('records the erasure without personal data', async () => {
		const id = await seedPerson(a, { name: NAME, phone: PHONE, email: EMAIL })
		await erasePerson(a, { customerId: id }, { actorId: 'user_1', now: 5000 })
		const log = await a.select().from(personErasureLog)
		expect(log).toHaveLength(1)
		expect(log[0]).toMatchObject({
			actorId: 'user_1',
			subjectId: id,
			counts: expect.objectContaining({ customers: 1, voiceCalls: 1 }),
		})
		const serialized = JSON.stringify(log).toLowerCase()
		for (const pii of [PHONE, EMAIL.toLowerCase(), NAME.toLowerCase()]) {
			expect(serialized).not.toContain(pii)
		}
	})

	it('is idempotent: a second run changes nothing and logs nothing', async () => {
		const id = await seedPerson(a, { name: NAME, phone: PHONE, email: EMAIL })
		await erasePerson(a, { customerId: id }, { actorId: 'user_1' })
		const again = await erasePerson(
			a,
			{ customerId: id },
			{ actorId: 'user_1' },
		)
		expect(again).toMatchObject({
			alreadyErased: true,
			customersErased: 0,
			ordersUnlinked: 0,
		})
		expect(await a.select().from(personErasureLog)).toHaveLength(1)
	})

	it('erases from the customer row even when the foreign-key pragma is off', async () => {
		const id = await seedPerson(a, { name: NAME, phone: PHONE, email: EMAIL })
		await a.run(sql`PRAGMA foreign_keys = OFF`)
		try {
			await erasePerson(a, { customerId: id }, { actorId: 'user_1' })
		} finally {
			await a.run(sql`PRAGMA foreign_keys = ON`)
		}
		expect(await tablesContaining(a, [PHONE])).toEqual([])
		expect(
			await a
				.select()
				.from(customerSubscriptions)
				.where(eq(customerSubscriptions.customerId, id)),
		).toEqual([])
	})

	it('redacts a submission only where the address is a whole token', async () => {
		const id = await seedPerson(a, {
			name: NAME,
			phone: '+15550001111',
			email: 'al@x.test',
		})
		await seedForm(a, 'mail me at AL@X.test please')
		await seedForm(a, 'sal@x.test is my colleague')
		await seedForm(a, 'al@x.test.au is another address')
		await seedForm(a, 'phone +155500011119 is longer')
		const [form] = await a.select().from(websiteForms)
		await a.insert(websiteFormSubmissions).values({
			formId: form!.id,
			values: { nested: { list: ['x', 'reach al@x.test'] } },
		})
		const result = await erasePerson(
			a,
			{ customerId: id },
			{ actorId: 'user_1' },
		)
		expect(result.formSubmissionsRedacted).toBe(2)
		const kept = (await a.select().from(websiteFormSubmissions)).filter(
			(row) => !('redacted' in (row.values as object)),
		)
		expect(
			kept.map((row) => (row.values as { message: string }).message).sort(),
		).toEqual([
			'al@x.test.au is another address',
			'phone +155500011119 is longer',
			'sal@x.test is my colleague',
		])
	})

	it('containsAsToken respects address and number boundaries', () => {
		expect(containsAsToken('write to al@x.test.', 'al@x.test')).toBe(true)
		expect(containsAsToken('(al@x.test)', 'al@x.test')).toBe(true)
		expect(containsAsToken('sal@x.test', 'al@x.test')).toBe(false)
		expect(containsAsToken('al@x.test.au', 'al@x.test')).toBe(false)
		expect(containsAsToken('al@x.testing', 'al@x.test')).toBe(false)
		expect(containsAsToken('call +15550001111!', '+15550001111')).toBe(true)
		expect(containsAsToken('+155500011112', '+15550001111')).toBe(false)
		expect(containsAsToken('9+15550001111', '+15550001111')).toBe(false)
	})

	it('leaves a record and stays retryable when the transaction fails after voice data is gone', async () => {
		const id = await seedPerson(a, { name: NAME, phone: PHONE, email: EMAIL })
		await a.run(
			sql`CREATE TRIGGER block_customer_delete BEFORE DELETE ON customers BEGIN SELECT RAISE(ABORT, 'boom'); END`,
		)
		await expect(
			erasePerson(a, { customerId: id }, { actorId: 'user_1' }),
		).rejects.toThrow()

		// Phase 1 already deleted the voice data; the transaction rolled back.
		expect(await a.select().from(voiceCalls)).toEqual([])
		expect(await a.select().from(customers)).toHaveLength(1)
		expect(await a.select().from(customerSubscriptions)).toHaveLength(1)
		const [partial] = await a.select().from(personErasureLog)
		expect(partial).toMatchObject({
			actorId: 'user_1',
			subjectId: id,
			counts: expect.objectContaining({ incomplete: 1, voiceCalls: 1 }),
		})
		const serialized = JSON.stringify(partial).toLowerCase()
		for (const pii of [PHONE, EMAIL.toLowerCase(), NAME.toLowerCase()]) {
			expect(serialized).not.toContain(pii)
		}

		// Retry: the same row is completed and keeps the earlier voice count.
		await a.run(sql`DROP TRIGGER block_customer_delete`)
		const retry = await erasePerson(
			a,
			{ customerId: id },
			{ actorId: 'user_1' },
		)
		expect(retry).toMatchObject({ alreadyErased: false, customersErased: 1 })
		expect(await tablesContaining(a, [PHONE, EMAIL, NAME])).toEqual([])
		const log = await a.select().from(personErasureLog)
		expect(log).toHaveLength(1)
		expect(log[0]!.counts).toMatchObject({ customers: 1, voiceCalls: 1 })
		expect(log[0]!.counts).not.toHaveProperty('incomplete')
	})

	it('scrubs restaurant orders by customer id and by guest phone, keeping totals', async () => {
		const id = await seedPerson(a, { name: NAME, phone: PHONE, email: EMAIL })
		const base = {
			orgId: orgA,
			number: 'R-1',
			locationId: 'loc_1',
			locationName: 'Main',
			currency: 'USD',
			subtotalCents: 900,
			taxCents: 100,
			totalCents: 1000,
			lines: [],
			requestHash: 'h',
			paymentMethod: 'handoff',
			paymentStatus: 'pending',
			fulfillment: 'pickup',
		}
		await a.insert(restaurantOrders).values([
			{
				...base,
				customerId: id,
				idempotencyKey: 'k1',
				receiptTokenHash: 'r1',
				contactName: NAME,
				contactPhone: PHONE,
				contactEmail: EMAIL,
				deliveryAddress: '1 Erase Street',
				deliveryLat: 1.5,
				deliveryLng: 2.5,
			},
			{
				...base,
				number: 'R-2',
				idempotencyKey: 'k2',
				receiptTokenHash: 'r2',
				contactName: NAME,
				contactPhone: PHONE,
			},
			{
				...base,
				number: 'R-3',
				idempotencyKey: 'k3',
				receiptTokenHash: 'r3',
				contactName: 'Someone Else',
				contactPhone: OTHER_PHONE,
			},
		] as never)

		const result = await erasePerson(
			a,
			{ customerId: id },
			{ actorId: 'user_1' },
		)
		expect(result).toMatchObject({ restaurantOrdersScrubbed: 2 })
		expect(
			await tablesContaining(a, [PHONE, EMAIL, NAME, 'Erase Street']),
		).toEqual([])
		const rows = await a.select().from(restaurantOrders)
		expect(rows).toHaveLength(3)
		expect(rows.map((row) => row.totalCents)).toEqual([1000, 1000, 1000])
		expect(rows.find((row) => row.number === 'R-3')).toMatchObject({
			contactName: 'Someone Else',
			contactPhone: OTHER_PHONE,
		})
	})

	describe('guest restaurant orders stored in another format', () => {
		const base = {
			orgId: orgA,
			locationId: 'loc_1',
			locationName: 'Main',
			currency: 'USD',
			subtotalCents: 900,
			taxCents: 100,
			totalCents: 1000,
			lines: [],
			requestHash: 'h',
			paymentMethod: 'handoff',
			paymentStatus: 'pending',
			fulfillment: 'delivery',
			deliveryAddress: '1 Erase Street',
		}
		const order = (
			n: number,
			contact: { contactPhone: string; contactEmail?: string | null },
		) => ({
			...base,
			number: `G-${n}`,
			idempotencyKey: `gk${n}`,
			receiptTokenHash: `gr${n}`,
			contactName: n === 99 ? 'Someone Else' : NAME,
			...contact,
		})
		const scrubbed = async () =>
			(await a.select().from(restaurantOrders))
				.filter((row) => row.contactName === '' && row.deliveryAddress === null)
				.map((row) => row.number)
				.sort()

		it('matches a mixed-case guest email and legacy-format phones', async () => {
			const id = await seedPerson(a, { name: NAME, phone: PHONE, email: EMAIL })
			await a.insert(restaurantOrders).values([
				order(1, {
					contactPhone: '000',
					contactEmail: 'Erase.Me@Example.TEST',
				}),
				order(2, {
					contactPhone: '000',
					contactEmail: ' erase.me@example.test ',
				}),
				order(3, { contactPhone: '(555) 000-1111' }),
				order(4, { contactPhone: '555-000-1111' }),
				order(5, { contactPhone: '1 555 000 1111' }),
				order(6, { contactPhone: '5550001111' }),
				order(7, { contactPhone: '001-555-000-1111' }),
				// Other people: a different number, a longer and a shorter one, and
				// a different mailbox on the same domain.
				order(90, { contactPhone: '(555) 000-2222' }),
				order(91, { contactPhone: '+155500011112' }),
				order(92, { contactPhone: '555000111' }),
				order(93, {
					contactPhone: '000',
					contactEmail: 'rase.me@example.test',
				}),
			] as never)

			const result = await erasePerson(
				a,
				{ customerId: id },
				{ actorId: 'user_1' },
			)
			expect(result).toMatchObject({ restaurantOrdersScrubbed: 7 })
			expect(await scrubbed()).toEqual([
				'G-1',
				'G-2',
				'G-3',
				'G-4',
				'G-5',
				'G-6',
				'G-7',
			])
			expect(
				await tablesContaining(a, ['Erase.Me@Example.TEST', '555-000-1111']),
			).toEqual([])
		})

		it('matches the national forms of a Saudi number when the node serves KSA', async () => {
			const previous = process.env.DATA_REGION
			process.env.DATA_REGION = 'ksa'
			try {
				const ksaPhone = '+966501234567'
				const id = await seedPerson(a, {
					name: NAME,
					phone: ksaPhone,
					email: EMAIL,
				})
				await a
					.insert(restaurantOrders)
					.values([
						order(1, { contactPhone: '0501234567' }),
						order(2, { contactPhone: '50 123 4567' }),
						order(3, { contactPhone: '966 50 123 4567' }),
						order(4, { contactPhone: '00966501234567' }),
						order(99, { contactPhone: '0509999999' }),
					] as never)
				await erasePerson(a, { customerId: id }, { actorId: 'user_1' })
				expect(await scrubbed()).toEqual(['G-1', 'G-2', 'G-3', 'G-4'])
			} finally {
				process.env.DATA_REGION = previous ?? 'us'
			}
		})

		it('handles more guest orders and addresses than a statement can bind', async () => {
			const id = await seedPerson(a, { name: NAME, phone: PHONE, email: EMAIL })
			await a.insert(restaurantOrders).values(
				Array.from({ length: 150 }, (_, i) =>
					order(i + 1, {
						contactPhone: i % 2 ? '(555) 000-1111' : '000',
						contactEmail: i % 2 ? null : 'ERASE.ME@example.test',
					}),
				) as never,
			)
			const result = await erasePerson(
				a,
				{ customerId: id },
				{ actorId: 'user_1' },
			)
			expect(result).toMatchObject({ restaurantOrdersScrubbed: 150 })
		})
	})

	it('rejects an empty target', async () => {
		await expect(
			erasePerson(a, { customerId: '' }, { actorId: 'user_1' }),
		).rejects.toMatchObject({ code: 'invalid_erase_call' })
	})
})
