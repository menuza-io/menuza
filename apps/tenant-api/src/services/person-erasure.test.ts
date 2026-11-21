import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultGiftCardSettings } from '@repo/common/gift-cards'
import {
	customerPaymentMethods,
	customerRefreshTokens,
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	giftCardIdempotencyKeys,
	giftCardLedger,
	giftCardPurchaseAttempts,
	giftCardShowTokens,
	giftCards,
	guestPhotoSubmissions,
	journeyRuns,
	journeyStepExecutions,
	marketingCampaigns,
	marketingJourneys,
	marketingMessages,
	personErasureLog,
	provisionTenantDb,
	qrTabRefunds,
	qrTables,
	qrTabs,
	restaurantOrderRefunds,
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { giftCardFingerprint } from '../lib/gift-card-secret.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { claimGiftCard, createShowToken } from './gift-card-account-service.ts'
import { createGiftCardPurchase } from './gift-card-purchase-service.ts'
import { sellGiftCard } from './gift-card-service.ts'
import { giftCardBalance } from './gift-card-store.ts'
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

	it('erases the rows migration 0018 archived for the customer', async () => {
		const id = await seedPerson(a, { name: NAME, phone: PHONE, email: EMAIL })
		const other = await seedPerson(a, {
			name: 'Other',
			phone: OTHER_PHONE,
			email: 'other@example.test',
		})
		// Rows as 0018 archives them: copies, with no foreign keys.
		for (const customerId of [id, other]) {
			await a.run(sql`
				INSERT INTO __archived_journey_runs_0018 (id, journey_id, customer_id, trigger_event, status, context_data)
				VALUES (${`run-${customerId}`}, 'j', ${customerId}, 'phone_verified', 'completed', ${JSON.stringify({ phone: customerId === id ? PHONE : OTHER_PHONE })})
			`)
			// A step whose customer id was never set is found by its run.
			await a.run(sql`
				INSERT INTO __archived_journey_step_executions_0018 (id, run_id, customer_id, node_id, status)
				VALUES (${`step-${customerId}`}, ${`run-${customerId}`}, NULL, 'email-1', 'completed')
			`)
			await a.run(sql`
				INSERT INTO __archived_marketing_messages_0018 (id, customer_id, channel, status, archive_reason)
				VALUES (${`msg-${customerId}`}, ${customerId}, 'email', 'Sent', 'duplicate_broadcast')
			`)
		}

		await erasePerson(a, { customerId: id }, { actorId: 'user_1' })

		expect(await tablesContaining(a, [PHONE])).toEqual([])
		for (const table of [
			'__archived_journey_runs_0018',
			'__archived_journey_step_executions_0018',
			'__archived_marketing_messages_0018',
		]) {
			expect(
				await a.all(sql.raw(`select id from "${table}"`)),
				table,
			).toHaveLength(1)
		}
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

	it('clears refund notes on scrubbed orders and keeps the amounts', async () => {
		const id = await seedPerson(a, { name: NAME, phone: PHONE, email: EMAIL })
		const base = {
			orgId: orgA,
			locationId: 'loc_1',
			locationName: 'Main',
			currency: 'USD',
			subtotalCents: 1000,
			taxCents: 0,
			totalCents: 1000,
			refundedCents: 300,
			lines: [],
			requestHash: 'h',
			paymentMethod: 'online',
			paymentStatus: 'paid',
			fulfillment: 'pickup',
		}
		await a.insert(restaurantOrders).values([
			{
				...base,
				id: 'ord_mine',
				number: 'R-1',
				customerId: id,
				idempotencyKey: 'k1',
				receiptTokenHash: 'r1',
				contactName: NAME,
				contactPhone: PHONE,
			},
			{
				...base,
				id: 'ord_other',
				number: 'R-3',
				idempotencyKey: 'k3',
				receiptTokenHash: 'r3',
				contactName: 'Someone Else',
				contactPhone: OTHER_PHONE,
			},
		] as never)
		const refund = {
			amountCents: 300,
			currency: 'USD',
			actorId: 'user_1',
			requestHash: 'h',
		}
		await a.insert(restaurantOrderRefunds).values([
			{
				...refund,
				id: 'rf_mine',
				orderId: 'ord_mine',
				note: `${NAME} said the food was cold`,
				idempotencyKey: 'rk1',
			},
			{
				...refund,
				id: 'rf_other',
				orderId: 'ord_other',
				note: 'Late delivery',
				idempotencyKey: 'rk3',
			},
		])

		const result = await erasePerson(
			a,
			{ customerId: id },
			{ actorId: 'user_1' },
		)
		expect(result).toMatchObject({ restaurantOrdersScrubbed: 1 })
		expect(await tablesContaining(a, [PHONE, EMAIL, NAME])).toEqual([])
		const refunds = await a
			.select()
			.from(restaurantOrderRefunds)
			.orderBy(restaurantOrderRefunds.id)
		expect(refunds.map((row) => [row.id, row.note, row.amountCents])).toEqual([
			['rf_mine', null, 300],
			['rf_other', 'Late delivery', 300],
		])
		const orders = await a.select().from(restaurantOrders)
		expect(orders.map((row) => row.refundedCents)).toEqual([300, 300])
	})

	it('clears provider refund notes on a scrubbed tab and keeps the amounts', async () => {
		const id = await seedPerson(a, { name: NAME, phone: PHONE, email: EMAIL })
		await a
			.insert(qrTables)
			.values({ id: 'tbl_1', locationId: 'loc_1', label: 'T1' })
		const tab = {
			tableId: 'tbl_1',
			locationId: 'loc_1',
			tableLabel: 'T1',
			status: 'closed' as const,
			openedDay: '2026-01-10',
			currency: 'USD',
			paymentMethod: 'online' as const,
			paymentStatus: 'paid' as const,
			paymentProcessor: 'connect' as const,
		}
		await a.insert(qrTabs).values([
			{
				...tab,
				id: 'tab-mine',
				tabNumber: 'T-1',
				guestPhone: PHONE,
				paymentSessionId: 'cs_tab_mine',
			},
			{
				...tab,
				id: 'tab-other',
				tabNumber: 'T-2',
				guestPhone: OTHER_PHONE,
				paymentSessionId: 'cs_tab_other',
			},
		])
		const refund = {
			amountCents: 300,
			currency: 'USD',
			actorId: 'user_1',
			origin: 'operator' as const,
			processor: 'connect' as const,
			requestHash: 'h',
		}
		await a.insert(qrTabRefunds).values([
			{
				...refund,
				id: 'tr_mine',
				tabId: 'tab-mine',
				sessionId: 'cs_tab_mine',
				note: `${NAME} asked for it back`,
				idempotencyKey: 'trk1',
			},
			{
				...refund,
				id: 'tr_other',
				tabId: 'tab-other',
				sessionId: 'cs_tab_other',
				note: 'Wrong dish',
				idempotencyKey: 'trk2',
			},
		])

		await erasePerson(a, { customerId: id }, { actorId: 'user_1' })
		expect(await tablesContaining(a, [PHONE, EMAIL, NAME])).toEqual([])
		const refunds = await a.select().from(qrTabRefunds).orderBy(qrTabRefunds.id)
		expect(
			refunds.map((row) => [row.id, row.note, row.amountCents, row.status]),
		).toEqual([
			['tr_mine', null, 300, 'pending'],
			['tr_other', 'Wrong dish', 300, 'pending'],
		])
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

describe('person erasure of gift cards', () => {
	let tempDir: string
	let db: TenantDatabase
	let n = 0
	const rid = () => `req-erase-${Date.now().toString(36)}-${(n += 1)}`
	const settings = defaultGiftCardSettings()
	const actor = { id: 'user_manager', name: 'Pat Manager' }

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-erase-gift-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'erase-gift-hmac-secret-0123456789abcdef'
		syncEnvFromProcess()
		await provisionTenantDb(orgA)
		db = await getTenantDb(orgA)
	})

	afterEach(async () => {
		await destroyTenantDb(orgA).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function purchase(
		overrides: Partial<Parameters<typeof createGiftCardPurchase>[0]> = {},
	) {
		return createGiftCardPurchase({
			orgId: orgA,
			settings,
			currency: 'USD',
			locationId: 'loc_a',
			amountMinor: 5000,
			designKey: 'classic',
			recipient: {
				name: 'Friend Person',
				email: `friend-${rid()}@example.test`,
			},
			sendToSelf: false,
			senderName: 'Buyer Person',
			message: 'Enjoy the meal',
			deliverAt: null,
			purchaser: {
				customerId: null,
				name: 'Buyer Person',
				email: `buyer-${rid()}@example.test`,
			},
			locale: 'en',
			deviceId: `device-${rid()}`,
			...overrides,
		})
	}

	async function till(amountMinor: number) {
		return sellGiftCard({
			orgId: orgA,
			amountMinor,
			currency: 'USD',
			locationId: 'loc_a',
			actor,
			deviceId: 'dev_1',
			clientRequestId: rid(),
			paymentMethod: 'cash',
			settings,
		})
	}

	const cardRow = (id: string) =>
		db.select().from(giftCards).where(eq(giftCards.id, id)).get()

	it('removes the person from every card that names them and keeps the money record', async () => {
		const id = await seedPerson(db, { name: NAME, phone: PHONE, email: EMAIL })
		const other = await seedPerson(db, {
			name: 'Olive Other',
			phone: OTHER_PHONE,
			email: 'olive.other@example.test',
		})

		// 1. A card the person bought online (account and name and email), still undelivered.
		const bought = await purchase({
			purchaser: { customerId: id, name: NAME, email: EMAIL },
			senderName: NAME,
			message: 'Happy birthday',
		})
		// 2. A till card the person saved to their account, with a QR token and a note naming them.
		const sold = await till(3000)
		await claimGiftCard({ orgId: orgA, customerId: id, code: sold.code! })
		await createShowToken({ orgId: orgA, customerId: id, cardId: sold.cardId })
		await db
			.update(giftCardLedger)
			.set({ note: `Refunded ${NAME} by hand` })
			.where(eq(giftCardLedger.cardId, sold.cardId))
		// 3. A card someone else bought for the person's email.
		const received = await purchase({
			recipient: { name: NAME, email: EMAIL.toUpperCase() },
			message: 'For you',
		})
		// 4. A card that is another person's, and must not change.
		const theirs = await till(2000)
		await claimGiftCard({ orgId: orgA, customerId: other, code: theirs.code! })
		const theirsBefore = JSON.stringify(await cardRow(theirs.cardId))
		const balances = {
			sold: await giftCardBalance(db, sold.cardId),
			theirs: await giftCardBalance(db, theirs.cardId),
		}
		expect(
			(await db.select().from(giftCardPurchaseAttempts)).some(
				(row) => row.emailHash === giftCardFingerprint('email', EMAIL),
			),
		).toBe(true)

		const result = await erasePerson(
			db,
			{ customerId: id },
			{ actorId: 'user_1' },
		)
		expect(result).toMatchObject({ erased: true, giftCardsErased: 3 })

		// The dump scan: the person's name and email appear in no table.
		expect(await tablesContaining(db, [EMAIL, NAME])).toEqual([])

		// The purchaser is gone from the card they bought; the recipient is not theirs to erase.
		const afterBought = await cardRow(bought.cardId)
		expect(afterBought).toMatchObject({
			purchaserCustomerId: null,
			purchaserName: null,
			purchaserEmail: null,
			senderName: null,
			erasedAt: expect.any(Number),
		})
		expect(afterBought?.receiptSentAt).not.toBeNull()
		expect(afterBought?.recipientEmail).toMatch(/^friend-/)
		// Undelivered, so the note is kept for the delivery the buyer paid for.
		expect(afterBought?.message).toBe('Happy birthday')

		// The saved card is unlinked, with its balance and its ledger kept.
		expect(await cardRow(sold.cardId)).toMatchObject({
			holderCustomerId: null,
			heldAt: null,
			erasedAt: expect.any(Number),
		})
		expect(await giftCardBalance(db, sold.cardId)).toBe(balances.sold)
		const ledger = await db
			.select()
			.from(giftCardLedger)
			.where(eq(giftCardLedger.cardId, sold.cardId))
		expect(ledger.length).toBeGreaterThan(0)
		expect(ledger.every((row) => row.note === null)).toBe(true)

		// The recipient (matched by email in any case) is gone, and so is the note.
		expect(await cardRow(received.cardId)).toMatchObject({
			recipientName: null,
			recipientEmail: null,
			message: null,
			erasedAt: expect.any(Number),
		})

		// Tokens and the person's limit fingerprints.
		expect(
			await db
				.select()
				.from(giftCardShowTokens)
				.where(eq(giftCardShowTokens.customerId, id)),
		).toEqual([])
		expect(
			(await db.select().from(giftCardPurchaseAttempts)).some(
				(row) => row.emailHash === giftCardFingerprint('email', EMAIL),
			),
		).toBe(false)

		// Another person's card is byte for byte the same.
		expect(JSON.stringify(await cardRow(theirs.cardId))).toBe(theirsBefore)
		expect(await giftCardBalance(db, theirs.cardId)).toBe(balances.theirs)
		expect((await cardRow(theirs.cardId))?.holderCustomerId).toBe(other)

		// The record names no one: counts only.
		const [log] = await db.select().from(personErasureLog)
		expect(log?.counts).toMatchObject({ giftCardsErased: 3 })
		expect(JSON.stringify(log)).not.toContain(EMAIL)
	})

	it('is idempotent and touches nothing when no card names the person', async () => {
		const id = await seedPerson(db, { name: NAME, phone: PHONE, email: EMAIL })
		const sold = await till(1000)
		const before = JSON.stringify(await cardRow(sold.cardId))
		const result = await erasePerson(
			db,
			{ customerId: id },
			{ actorId: 'user_1' },
		)
		expect(result.giftCardsErased).toBeUndefined()
		expect(JSON.stringify(await cardRow(sold.cardId))).toBe(before)
		const again = await erasePerson(
			db,
			{ customerId: id },
			{ actorId: 'user_1' },
		)
		expect(again.giftCardsErased).toBeUndefined()
	})

	it('also removes a delivered card note of an erased purchaser and the stored responses of their cards', async () => {
		const id = await seedPerson(db, { name: NAME, phone: PHONE, email: EMAIL })
		const bought = await purchase({
			purchaser: { customerId: id, name: NAME, email: EMAIL },
			idempotency: {
				scope: `purchase:${orgA}`,
				key: `key-${rid()}`,
				requestHash: 'h',
			},
		})
		// Delivered already: the note goes with the purchaser.
		await db
			.update(giftCards)
			.set({ deliveredAt: Date.now(), sealedCode: null })
			.where(eq(giftCards.id, bought.cardId))
		expect(
			(await db.select().from(giftCardIdempotencyKeys)).length,
		).toBeGreaterThan(0)
		await erasePerson(db, { customerId: id }, { actorId: 'user_1' })
		expect((await cardRow(bought.cardId))?.message).toBeNull()
		expect(
			await db
				.select()
				.from(giftCardIdempotencyKeys)
				.where(eq(giftCardIdempotencyKeys.cardId, bought.cardId)),
		).toEqual([])
	})
})

describe('guest dish photos erasure (#148)', () => {
	let tmpDir: string
	let prevTenantDir: string | undefined
	let db: TenantDatabase
	const s3Env = {
		RECORDING_S3_BUCKET: 'recordings',
		RECORDING_S3_ENDPOINT: 'https://s3.example.test',
		RECORDING_S3_ACCESS_KEY: 'access',
		RECORDING_S3_SECRET: 'secret',
	}

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erasure-photos-'))
		prevTenantDir = process.env.TENANT_DB_DIR
		process.env.TENANT_DB_DIR = tmpDir
		syncEnvFromProcess()
		await provisionTenantDb(orgA)
		db = await getTenantDb(orgA)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		for (const key of Object.keys(s3Env)) delete process.env[key]
		await destroyTenantDb(orgA)
		if (prevTenantDir === undefined) delete process.env.TENANT_DB_DIR
		else process.env.TENANT_DB_DIR = prevTenantDir
		fs.rmSync(tmpDir, { recursive: true, force: true })
	})

	it('deletes pending and rejected rows + R2 objects and unlinks added/approved rows', async () => {
		Object.assign(process.env, s3Env)
		const deletedUrls: string[] = []
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			if ((init as RequestInit | undefined)?.method === 'DELETE') {
				deletedUrls.push(String(url))
				return new Response(null, { status: 204 })
			}
			return new Response(null, { status: 404 })
		})

		const customerA = await seedPerson(db, {
			name: NAME,
			phone: PHONE,
			email: EMAIL,
		})
		const customerB = await seedPerson(db, {
			name: 'Other Guest',
			phone: OTHER_PHONE,
			email: 'other@example.test',
		})
		const now = new Date()
		await db.insert(guestPhotoSubmissions).values([
			{
				id: 'gp_staged',
				orgId: orgA,
				customerId: customerA,
				orderId: 'ord_a1',
				itemId: 'item_1',
				objectKey: `guest-photos/${orgA}/staged.jpg`,
				contentType: 'image/jpeg',
				byteSize: 1200,
				status: 'staged',
				createdAt: now,
			},
			{
				id: 'gp_pending',
				orgId: orgA,
				customerId: customerA,
				orderId: 'ord_a1',
				itemId: 'item_1',
				objectKey: `guest-photos/${orgA}/pending.jpg`,
				contentType: 'image/jpeg',
				byteSize: 1200,
				status: 'pending',
				consentText: 'consent',
				consentedAt: now,
				createdAt: now,
			},
			{
				id: 'gp_rejected',
				orgId: orgA,
				customerId: customerA,
				orderId: 'ord_a1',
				itemId: 'item_1',
				objectKey: `guest-photos/${orgA}/rejected.jpg`,
				contentType: 'image/jpeg',
				byteSize: 1200,
				status: 'rejected',
				consentText: 'consent',
				consentedAt: now,
				decidedAt: now,
				decidedByUserId: 'op_1',
				createdAt: now,
			},
			{
				id: 'gp_added',
				orgId: orgA,
				customerId: customerA,
				orderId: 'ord_a1',
				itemId: 'item_1',
				objectKey: `guest-photos/${orgA}/added.jpg`,
				contentType: 'image/jpeg',
				byteSize: 1200,
				status: 'added',
				consentText: 'consent',
				consentedAt: now,
				decidedAt: now,
				decidedByUserId: 'op_1',
				addedAt: now,
				createdAt: now,
			},
			{
				id: 'gp_other',
				orgId: orgA,
				customerId: customerB,
				orderId: 'ord_b1',
				itemId: 'item_1',
				objectKey: `guest-photos/${orgA}/other.jpg`,
				contentType: 'image/jpeg',
				byteSize: 1200,
				status: 'pending',
				consentText: 'consent',
				consentedAt: now,
				createdAt: now,
			},
		])

		// Also include a guest order matched by phone whose photo is linked only by orderId
		await db.insert(restaurantOrders).values({
			id: 'ord_guest_phone',
			orgId: orgA,
			customerId: null,
			number: 'ORD-G1',
			locale: 'en',
			status: 'completed',
			paymentMethod: 'handoff',
			paymentStatus: 'paid',
			fulfillment: 'pickup',
			locationId: 'loc_1',
			locationName: 'Main',
			contactName: NAME,
			contactPhone: PHONE,
			contactEmail: EMAIL,
			currency: 'USD',
			subtotalCents: 1000,
			taxCents: 0,
			totalCents: 1000,
			lines: '[]',
			idempotencyKey: 'idem-guest-photo-order',
			requestHash: 'hash-guest-photo-order',
			receiptTokenHash: 'receipt-hash-guest-photo',
		})
		await db.insert(guestPhotoSubmissions).values({
			id: 'gp_order_only',
			orgId: orgA,
			customerId: null,
			orderId: 'ord_guest_phone',
			itemId: 'item_1',
			objectKey: `guest-photos/${orgA}/order-only.jpg`,
			contentType: 'image/jpeg',
			byteSize: 1200,
			status: 'pending',
			consentText: 'consent',
			consentedAt: now,
			createdAt: now,
		})

		const result = await erasePerson(
			db,
			{ customerId: customerA },
			{ actorId: 'op_erase' },
		)
		expect(result.guestPhotosDeleted).toBe(4)
		expect(result.guestPhotosUnlinked).toBe(1)

		expect(
			deletedUrls.filter((u) => u.includes('/guest-photos/')).sort(),
		).toEqual([
			`https://s3.example.test/recordings/guest-photos/${orgA}/order-only.jpg`,
			`https://s3.example.test/recordings/guest-photos/${orgA}/pending.jpg`,
			`https://s3.example.test/recordings/guest-photos/${orgA}/rejected.jpg`,
			`https://s3.example.test/recordings/guest-photos/${orgA}/staged.jpg`,
		])

		const remaining = await db.select().from(guestPhotoSubmissions).all()
		expect(remaining.map((r) => r.id).sort()).toEqual(['gp_added', 'gp_other'])
		const addedRow = remaining.find((r) => r.id === 'gp_added')!
		expect(addedRow.customerId).toBeNull()
		expect(addedRow.orderId).toBeNull()
		const otherRow = remaining.find((r) => r.id === 'gp_other')!
		expect(otherRow.customerId).toBe(customerB)
	})
})
