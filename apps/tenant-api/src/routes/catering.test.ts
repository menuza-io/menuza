import crypto from 'node:crypto'
import { getTenantDb, restaurantOrders } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	cateringContext,
	LOC,
	NOW,
	ORG_A,
	ORIGIN,
	orderBody,
	payOrder,
	quoteRequestBody,
	settingsFor,
	startHarness,
	storedOrder,
	type Harness,
	linkFragment,
} from '../../tests/catering-fixture.ts'
import { orgById, orgForBrowser } from '../../tests/catering-orgs.ts'
import { runCateringTickForOrg } from '../services/catering-tick.ts'

vi.mock('../lib/origin.ts', async (importOriginal) => {
	const orgs = await import('../../tests/catering-orgs.ts')
	const findActiveOrganizationById = vi.fn(async (id: string) =>
		orgs.orgById(id),
	)
	return {
		...(await importOriginal<typeof import('../lib/origin.ts')>()),
		findActiveOrganizationById,
		lookupActiveOrganization: vi.fn(async (id: string) => {
			const organization = await findActiveOrganizationById(id)
			return organization
				? { status: 'found', organization }
				: { status: 'missing' }
		}),
		resolveOrganizationForBrowserAuth: vi.fn(
			async (
				origin: string | undefined,
				identity: { slug?: string; host?: string } | undefined,
			) => orgs.orgForBrowser(origin, identity),
		),
		resolvePublishedOrganization: vi.fn(async () => null),
	}
})

/**
 * Catering at the region (#124, #255, #361): placing an order with notice and
 * window checks, requesting and paying a quote, cutoffs, the deposit and the
 * balance with reminders, voiding and refunds. Everything runs on a real tenant
 * database with the App, the payment provider and the email transport faked.
 */

let h: Harness
const orgId = ORG_A.id
const DEPOSIT_30 = {
	deposit: {
		percent: 30,
		balanceDueDaysBeforeEvent: 3,
		reminderDaysBeforeDue: 2,
	},
}

beforeEach(async () => {
	void orgById
	void orgForBrowser
	h = await startHarness([ORG_A])
})
afterEach(async () => {
	await h.cleanup()
})

async function placeOrder(overrides: Record<string, unknown> = {}) {
	const response = await h.postOrder(orderBody(overrides))
	return { response, body: await response.json() }
}

function useSettings(patch: Parameters<typeof settingsFor>[0], quotes = true) {
	h.setContext(
		orgId,
		cateringContext(orgId, { settings: { [LOC]: patch ?? {} }, quotes }),
	)
}

async function orderOfQuote(quoteId: string) {
	const db = await getTenantDb(orgId)
	const rows = await db
		.select()
		.from(restaurantOrders)
		.where(eq(restaurantOrders.cateringQuoteId, quoteId))
	return rows[0]!
}

describe('placing a catering order (#124)', () => {
	it('refuses an order inside the notice period and takes one outside it (124-1)', async () => {
		useSettings({ noticeHours: 72 })
		const inside = await placeOrder({
			scheduledFor: '2026-06-03T16:00:00.000Z',
		})
		expect(inside.response.status).toBe(422)
		expect(inside.body.error).toBe('catering_too_soon')
		const outside = await placeOrder({
			scheduledFor: '2026-06-04T16:00:00.000Z',
		})
		expect(outside.response.status).toBe(201)
		const order = await storedOrder(orgId, outside.body.order.id)
		expect(order.isCatering).toBe(true)
		expect(order.guestCount).toBe(30)
		expect(order.cateringNotes).toBe('Office lunch, no nuts')
		expect(order.cateringEventAt?.toISOString()).toBe('2026-06-04T16:00:00.000Z')
		expect(order.paymentStatus).toBe('pending')
	})

	it('checks hours, how far ahead, amounts and guests', async () => {
		useSettings({
			noticeHours: 0,
			maxDaysAhead: 10,
			minMinor: 30_000,
			maxMinor: 50_000,
			maxGuests: 50,
		})
		const code = async (overrides: Record<string, unknown>) =>
			(await placeOrder(overrides)).body.error
		// 03:00 New York is outside the 08:00 to 20:00 online hours.
		expect(await code({ scheduledFor: '2026-06-04T07:00:00.000Z' })).toBe(
			'catering_closed',
		)
		expect(await code({ scheduledFor: '2026-07-04T16:00:00.000Z' })).toBe(
			'catering_too_far',
		)
		expect(await code({})).toBe('catering_minimum')
		expect(
			await code({
				lines: [{ itemId: 'item-tray', quantity: 6, options: [] }],
			}),
		).toBe('catering_maximum')
		expect(
			await code({
				guestCount: 60,
				lines: [{ itemId: 'item-tray', quantity: 4, options: [] }],
			}),
		).toBe('catering_guests')
	})

	it('is not blocked by a pause or busy mode on a future day', async () => {
		h.setContext(
			orgId,
			cateringContext(orgId, {
				settings: { [LOC]: {} },
				location: {
					orderingPause: { pausedAt: NOW.toISOString(), until: null },
					busyMode: { extraPrepMinutes: 90, until: null },
				},
			}),
		)
		expect((await placeOrder()).response.status).toBe(201)
	})

	it('refuses catering when the organization flag is off or the location has it off', async () => {
		h.setContext(orgId, cateringContext(orgId, { flagOff: true }))
		expect((await placeOrder()).body.error).toBe('catering_disabled')
		useSettings({ enabled: false })
		expect((await placeOrder()).body.error).toBe('catering_disabled')
	})

	it('answers 503 when the kill switch is off', async () => {
		vi.stubEnv('CATERING_PUBLIC_ENABLED', 'false')
		const placed = await placeOrder()
		expect(placed.response.status).toBe(503)
		expect(placed.body.error).toBe('catering_unavailable')
	})
})

describe('deposit and balance (#361)', () => {
	it('confirms after a 30 percent deposit and shows the balance due (361-1)', async () => {
		useSettings(DEPOSIT_30)
		const placed = await placeOrder({
			scheduledFor: '2026-06-20T16:00:00.000Z',
		})
		const order = await storedOrder(orgId, placed.body.order.id)
		// 2 trays at 100.00 plus 10% tax.
		expect(order.totalCents).toBe(22_000)
		expect(order.depositPercent).toBe(30)
		expect(order.depositCents).toBe(6_600)
		expect(order.balanceState).toBe('due')
		// Three days before the event: the end of June 17 in New York.
		expect(order.balanceDueAt?.toISOString()).toBe('2026-06-18T04:00:00.000Z')

		// The provider is asked for the deposit, not the total.
		const quote = await h.system('/quote', {
			orgId,
			orderId: order.id,
			paymentToken: placed.body.paymentToken,
		})
		expect((await quote.json()).totalCents).toBe(6_600)
		// A payment of the whole total does not match the deposit.
		const sessionId = 'cs_full_total'
		await h.system('/payment-session', {
			orgId,
			orderId: order.id,
			sessionId,
			processor: 'connect',
		})
		const wrong = await h.system('/payment-status', {
			orgId,
			orderId: order.id,
			sessionId,
			processor: 'connect',
			status: 'paid',
			amountCents: 22_000,
			currency: 'USD',
		})
		expect(wrong.status).toBe(422)
		expect((await storedOrder(orgId, order.id)).paymentStatus).toBe('pending')

		const paid = await payOrder(h, orgId, order.id, sessionId)
		expect(paid.paid.status).toBe(200)
		const confirmed = await storedOrder(orgId, order.id)
		expect(confirmed.paymentStatus).toBe('paid')
		expect(confirmed.paidCents).toBe(6_600)
		await vi.waitFor(() => expect(h.emails.length).toBeGreaterThan(0))
		const email = h.emails.find((e) => e.subject.includes('confirmed'))!
		expect(email.to).toBe('rana@example.com')
		expect(email.text).toContain('Balance')
		// The operator sees the balance owed.
		const view = await (await h.op('GET', `/orders/${order.id}`)).json()
		expect(view.balance).toMatchObject({
			status: 'due',
			owedCents: 15_400,
			balanceCents: 15_400,
		})
		expect(view.paidCents).toBe(6_600)
	})

	it('takes the whole total up front when no deposit is set', async () => {
		useSettings({})
		const placed = await placeOrder()
		const order = await storedOrder(orgId, placed.body.order.id)
		expect(order.depositCents).toBe(order.totalCents)
		expect(order.balanceState).toBeNull()
		await payOrder(h, orgId, order.id)
		expect((await storedOrder(orgId, order.id)).paidCents).toBe(order.totalCents)
	})

	it('pays the balance from the link and shows a fully paid order', async () => {
		useSettings(DEPOSIT_30)
		const placed = await placeOrder({
			scheduledFor: '2026-06-20T16:00:00.000Z',
		})
		const id: string = placed.body.order.id
		await payOrder(h, orgId, id)
		await vi.waitFor(() =>
			expect(h.emails.some((e) => e.subject.includes('confirmed'))).toBe(true),
		)
		// The confirmation carries the balance link: its token rides in the fragment.
		const confirmation = h.emails.find((e) => e.subject.includes('confirmed'))!
		const token = linkFragment(confirmation.html)
		const href = /href="([^"]+)"/.exec(confirmation.html)![1]!
		expect(new URL(href).pathname).toBe('/catering/balance')
		expect(new URL(href).search).toBe('')

		const view = await h.guest('GET', `/balance/${id}?slug=acme`, {
			headers: { 'X-Balance-Token': token },
		})
		expect(view.status).toBe(200)
		expect(await view.json()).toMatchObject({
			status: 'due',
			payable: true,
			owedCents: 15_400,
			paidCents: 6_600,
		})
		const start = await h.guest('POST', `/balance/${id}/pay`, {
			body: { slug: 'acme' },
			headers: { 'X-Balance-Token': token },
		})
		expect(start.status).toBe(200)
		const started = await start.json()
		expect(started).toMatchObject({ orderRef: `bal:${id}`, totalCents: 15_400 })
		const quote = await h.system('/quote', {
			orgId,
			orderId: started.orderRef,
			paymentToken: started.paymentToken,
		})
		expect(await quote.json()).toMatchObject({
			orderId: `bal:${id}`,
			totalCents: 15_400,
		})
		const balance = await payBalance(id, started.orderRef, 15_400)
		expect(balance.status).toBe(200)
		const done = await storedOrder(orgId, id)
		expect(done.balanceState).toBe('paid')
		expect(done.balancePaidCents).toBe(15_400)
		expect(done.paidCents).toBe(22_000)
		// A replayed event changes nothing.
		await payBalance(id, started.orderRef, 15_400, 'cs_balance_1')
		expect((await storedOrder(orgId, id)).paidCents).toBe(22_000)
		const detail = await (await h.op('GET', `/orders/${id}`)).json()
		expect(detail.fullyPaid).toBe(true)
		expect(detail.balance.status).toBe('paid')
		// The balance link no longer takes a payment.
		const again = await h.guest('POST', `/balance/${id}/pay`, {
			body: { slug: 'acme' },
			headers: { 'X-Balance-Token': token },
		})
		expect(again.status).toBe(409)
		expect((await again.json()).error).toBe('balance_already_paid')
	})

	async function payBalance(
		id: string,
		ref: string,
		amountCents: number,
		sessionId = 'cs_balance_1',
	) {
		await h.system('/payment-session', {
			orgId,
			orderId: ref,
			sessionId,
			processor: 'connect',
		})
		return h.system('/payment-status', {
			orgId,
			orderId: ref,
			sessionId,
			processor: 'connect',
			status: 'paid',
			amountCents,
			currency: 'USD',
			paymentId: 'pi_balance_1',
		})
	}

	it('sends a reminder before the due date and again when overdue, once each (361-2)', async () => {
		useSettings(DEPOSIT_30)
		const placed = await placeOrder({
			scheduledFor: '2026-06-20T16:00:00.000Z',
		})
		const id: string = placed.body.order.id
		await payOrder(h, orgId, id)
		await vi.waitFor(() =>
			expect(h.emails.some((e) => e.subject.includes('confirmed'))).toBe(true),
		)
		const count = (needle: string) =>
			h.emails.filter((e) => e.subject.toLowerCase().includes(needle)).length

		// Reminder day is June 15, midnight New York: quiet, so it waits for 08:00.
		vi.setSystemTime(new Date('2026-06-15T05:00:00Z'))
		let tick = await runCateringTickForOrg(orgId)
		expect(tick.reminders).toBe(0)
		expect(tick.nextDueAt).toBe(Date.parse('2026-06-15T12:00:00Z'))

		vi.setSystemTime(new Date('2026-06-15T13:00:00Z'))
		tick = await runCateringTickForOrg(orgId)
		expect(tick.reminders).toBe(1)
		expect(count('due soon')).toBe(1)
		// Once sent, not again.
		tick = await runCateringTickForOrg(orgId)
		expect(tick.reminders).toBe(0)
		expect(count('due soon')).toBe(1)

		// Overdue from the end of June 17.
		vi.setSystemTime(new Date('2026-06-18T13:00:00Z'))
		tick = await runCateringTickForOrg(orgId)
		expect(tick.overdue).toBe(1)
		expect(count('overdue')).toBe(1)
		expect(
			h.notices.filter((n) => n.kind === 'balance_overdue'),
		).toHaveLength(1)
		tick = await runCateringTickForOrg(orgId)
		expect(tick.overdue).toBe(0)
		expect(count('overdue')).toBe(1)
	})

	it('alerts the team the day before an event, with ids only', async () => {
		useSettings({})
		const placed = await placeOrder({
			scheduledFor: '2026-06-20T16:00:00.000Z',
		})
		await payOrder(h, orgId, placed.body.order.id)
		vi.setSystemTime(new Date('2026-06-19T12:00:00Z'))
		expect((await runCateringTickForOrg(orgId)).eventAlerts).toBe(0)
		vi.setSystemTime(new Date('2026-06-19T14:00:00Z'))
		expect((await runCateringTickForOrg(orgId)).eventAlerts).toBe(1)
		expect((await runCateringTickForOrg(orgId)).eventAlerts).toBe(0)
		const alerts = h.notices.filter((n) => n.kind === 'event_tomorrow')
		expect(alerts).toHaveLength(1)
		expect(Object.keys(alerts[0]!).sort()).toEqual([
			'count',
			'kind',
			'locationId',
			'orgId',
			'refId',
		])
	})

	it('voids an unpaid balance, kills its link, and reopens it with a new one', async () => {
		useSettings(DEPOSIT_30)
		const placed = await placeOrder({
			scheduledFor: '2026-06-20T16:00:00.000Z',
		})
		const id: string = placed.body.order.id
		// A balance cannot be touched before the deposit clears.
		const early = await h.op('POST', `/orders/${id}/balance`, { action: 'void' })
		expect(early.status).toBe(409)
		await payOrder(h, orgId, id)
		await vi.waitFor(() =>
			expect(h.emails.some((e) => e.subject.includes('confirmed'))).toBe(true),
		)
		const token = linkFragment(
			h.emails.find((e) => e.subject.includes('confirmed'))!.html,
		)
		const voided = await h.op('POST', `/orders/${id}/balance`, { action: 'void' })
		expect(voided.status).toBe(200)
		expect((await voided.json()).balance.status).toBe('void')
		const old = await h.guest('GET', `/balance/${id}?slug=acme`, {
			headers: { 'X-Balance-Token': token },
		})
		expect(old.status).toBe(403)
		expect((await old.json()).error).toBe('invalid_balance_token')
		// No reminders for a voided balance.
		vi.setSystemTime(new Date('2026-06-19T13:00:00Z'))
		expect((await runCateringTickForOrg(orgId)).reminders).toBe(0)
		// A second void has nothing to void.
		expect(
			(await h.op('POST', `/orders/${id}/balance`, { action: 'void' })).status,
		).toBe(409)
		// Reopen: a new link goes to the guest.
		const sentBefore = h.emails.length
		const reopened = await h.op('POST', `/orders/${id}/balance`, {
			action: 'reopen',
		})
		expect(reopened.status).toBe(200)
		expect((await reopened.json()).balance.status).toBe('overdue')
		await vi.waitFor(() => expect(h.emails.length).toBeGreaterThan(sentBefore))
		const fresh = linkFragment(h.emails.at(-1)!.html)
		expect(fresh).not.toBe(token)
		expect(
			(
				await h.guest('GET', `/balance/${id}?slug=acme`, {
					headers: { 'X-Balance-Token': fresh },
				})
			).status,
		).toBe(200)
	})

	it('moves the due date and gives the new date its own reminders', async () => {
		useSettings(DEPOSIT_30)
		const placed = await placeOrder({
			scheduledFor: '2026-06-20T16:00:00.000Z',
		})
		const id: string = placed.body.order.id
		await payOrder(h, orgId, id)
		const moved = await h.op('POST', `/orders/${id}/balance`, {
			action: 'set_due',
			dueDate: '2026-06-19',
		})
		expect(moved.status).toBe(200)
		expect((await moved.json()).balance.dueAt).toBe(
			Date.parse('2026-06-20T04:00:00Z'),
		)
		// After the event is too late.
		expect(
			(
				await h.op('POST', `/orders/${id}/balance`, {
					action: 'set_due',
					dueDate: '2026-06-25',
				})
			).status,
		).toBe(422)
	})

	it('locks a fully paid order until a charge reopens the balance', async () => {
		useSettings({})
		const placed = await placeOrder({
			scheduledFor: '2026-06-20T16:00:00.000Z',
		})
		const id: string = placed.body.order.id
		await payOrder(h, orgId, id)
		const locked = await h.op('PATCH', `/orders/${id}`, { guestCount: 45 })
		expect(locked.status).toBe(409)
		expect((await locked.json()).error).toBe('order_locked')
		const charge = await h.op('POST', `/orders/${id}/charges`, {
			label: 'Extra tray',
			amountCents: 5_000,
		})
		expect(charge.status).toBe(201)
		const reopened = await charge.json()
		expect(reopened.balance).toMatchObject({ status: 'due', owedCents: 5_000 })
		expect(reopened.totalCents).toBe(27_000)
		expect(
			(await h.op('PATCH', `/orders/${id}`, { guestCount: 45 })).status,
		).toBe(200)
	})

	it('never refunds more than was paid, payment by payment (361-3)', async () => {
		useSettings(DEPOSIT_30)
		const placed = await placeOrder({
			scheduledFor: '2026-06-20T16:00:00.000Z',
		})
		const id: string = placed.body.order.id
		await payOrder(h, orgId, id)
		const refund = (amountCents: number, key: string) =>
			h.system('/refund-intent', {
				orgId,
				orderId: id,
				amountCents,
				note: 'Partial refund',
				idempotencyKey: key,
				actor: { origin: 'operator', actorId: 'usr_1' },
			})
		// Only the deposit (66.00) was paid: one cent more is refused.
		const over = await refund(6_601, 'refund-key-over')
		expect(over.status).toBe(422)
		expect((await over.json()).refundableCents).toBe(6_600)
		const ok = await refund(2_000, 'refund-key-ok')
		expect(ok.status).toBe(201)
		expect((await ok.json()).amountCents).toBe(2_000)
		// The money still owed is not refundable money.
		const order = await storedOrder(orgId, id)
		expect(order.paidCents).toBe(6_600)
		expect(order.totalCents).toBe(22_000)
	})

	it('refunds the balance payment on its own session and keeps each payment within its amount', async () => {
		useSettings(DEPOSIT_30)
		const placed = await placeOrder({
			scheduledFor: '2026-06-20T16:00:00.000Z',
		})
		const id: string = placed.body.order.id
		await payOrder(h, orgId, id, 'cs_deposit')
		const start = await (
			await h.guest('POST', `/balance/${id}/pay`, {
				body: { slug: 'acme' },
				headers: {
					'X-Balance-Token': linkFragment(
						(await waitConfirmation()).html,
					),
				},
			})
		).json()
		await payBalance(id, start.orderRef, 15_400, 'cs_balance_x')
		const refund = (amountCents: number, key: string) =>
			h.system('/refund-intent', {
				orgId,
				orderId: id,
				amountCents,
				note: 'Partial refund',
				idempotencyKey: key,
				actor: { origin: 'operator', actorId: 'usr_1' },
			})
		// 220.00 was paid in two payments; 220.01 is more than was paid.
		expect((await refund(22_001, 'refund-key-over-total')).status).toBe(422)
		// A refund that fits the balance payment goes back on it.
		const first = await refund(15_400, 'refund-key-balance')
		expect(first.status).toBe(201)
		const row = await first.json()
		expect(row.sessionId).toBe('cs_balance_x')
		expect(row.paymentId).toBe('pi_balance_1')
		// One refund at a time: the next waits until the provider settled this one.
		expect((await refund(1_000, 'refund-key-waits')).status).toBe(409)
		const settled = await h.system('/refund-status', {
			orgId,
			orderId: id,
			refundId: row.refundId ?? row.id,
			processor: 'connect',
			status: 'succeeded',
			amountCents: 15_400,
			currency: 'USD',
		})
		expect(settled.status).toBe(200)
		// The balance payment is used up: only the deposit (66.00) is left to give back,
		// and a refund comes back on the deposit's own session.
		const bigger = await refund(6_601, 'refund-key-deposit-over')
		expect(bigger.status).toBe(422)
		expect((await bigger.json()).refundableCents).toBe(6_600)
		const deposit = await refund(6_600, 'refund-key-deposit')
		expect(deposit.status).toBe(201)
		const depositRow = await deposit.json()
		expect(depositRow.sessionId).toBe('cs_deposit')
		expect(depositRow.paymentId).toBe('pi_cs_deposit')
	})

	async function waitConfirmation() {
		await vi.waitFor(() =>
			expect(h.emails.some((e) => e.subject.includes('confirmed'))).toBe(true),
		)
		return h.emails.find((e) => e.subject.includes('confirmed'))!
	}
})

describe('quotes (#124)', () => {
	async function requestQuote(overrides: Record<string, unknown> = {}) {
		const response = await h.guest('POST', '/quote-requests', {
			body: quoteRequestBody(overrides),
		})
		return { response, body: await response.json() }
	}

	async function sendQuote(quoteId: string, patch: Record<string, unknown> = {}) {
		const edit = await h.op('PATCH', `/quotes/${quoteId}`, {
			lines: [
				{ itemId: 'item-tray', quantity: 3, unitPriceCents: 9_000 },
				{ itemName: 'Chafing dishes', quantity: 1, unitPriceCents: 3_000 },
			],
			charges: [
				{ kind: 'setup', label: 'Setup', amountCents: 2_000, taxable: false },
			],
			quoteNote: 'Includes setup and chafing dishes.',
			...patch,
		})
		expect(edit.status).toBe(200)
		const before = h.emails.length
		const sent = await h.op('POST', `/quotes/${quoteId}/send`)
		expect(sent.status).toBe(200)
		await vi.waitFor(() => expect(h.emails.length).toBeGreaterThan(before))
		return { sent: await sent.json(), email: h.emails.at(-1)! }
	}

	it('takes a request, tells the team with ids only, and lists it for the restaurant (124-4)', async () => {
		useSettings({ quoteMode: 'optional', alertUserIds: ['usr_alert'] })
		const { response, body } = await requestQuote()
		expect(response.status).toBe(201)
		expect(Object.keys(body)).toEqual(['requestId', 'replayed'])
		await vi.waitFor(() => expect(h.notices).toHaveLength(1))
		const notice = h.notices[0]!
		expect(notice).toEqual({
			orgId,
			kind: 'quote_request',
			locationId: LOC,
			refId: body.requestId,
			count: 1,
		})
		// Nothing the guest typed reaches the App.
		const raw = JSON.stringify(h.notices)
		for (const secret of [
			'Rana',
			'Khalid',
			'555',
			'rana@example.com',
			'vegetarian',
			'Board lunch',
		]) {
			expect(raw).not.toContain(secret)
		}
		// The restaurant sees the request with the contact.
		const list = await (await h.op('GET', '')).json()
		expect(list.quotes).toHaveLength(1)
		expect(list.quotes[0]).toMatchObject({
			status: 'draft',
			source: 'guest',
			contact: { name: 'Rana Khalid' },
			guestCount: 40,
		})
		// A retry with the same key returns the same request and tells nobody again.
		const key = crypto.randomUUID()
		const first = await requestQuote({ idempotencyKey: key })
		const again = await requestQuote({ idempotencyKey: key })
		expect(again.body).toEqual({ requestId: first.body.requestId, replayed: true })
		await vi.waitFor(() => expect(h.notices).toHaveLength(2))
		await new Promise((r) => setTimeout(r, 20))
		expect(h.notices).toHaveLength(2)
	})

	it('refuses a request when quotes are off or the date is too soon', async () => {
		useSettings({}, false)
		expect((await requestQuote()).body.error).toBe('catering_quotes_off')
		useSettings({ quoteMode: 'optional', noticeHours: 200 })
		expect((await requestQuote()).body.error).toBe('catering_too_soon')
		useSettings({ quoteMode: 'optional' })
		expect(
			(await requestQuote({ lines: [{ itemId: 'nope', quantity: 1 }] })).response
				.status,
		).toBe(400)
	})

	it('sends a quote, the guest pays it from the email link and it shows as a paid catering order (124-2)', async () => {
		useSettings({ quoteMode: 'optional', ...DEPOSIT_30 })
		const { body } = await requestQuote()
		const quoteId: string = body.requestId
		const { sent, email } = await sendQuote(quoteId)
		expect(sent.quote.status).toBe('sent')
		expect(sent.emailed).toBe(true)
		expect(email.to).toBe('rana@example.com')
		const href = /href="([^"]+)"/.exec(email.html)![1]!
		expect(new URL(href).pathname).toBe('/catering/quote')
		const token = linkFragment(email.html)

		// The guest sees the lines and totals at the link.
		const view = await h.guest('GET', `/quotes/${quoteId}?slug=acme`, {
			headers: { 'X-Quote-Token': token },
		})
		expect(view.status).toBe(200)
		const quote = await view.json()
		// 3 trays at 90.00, a 30.00 line, a 20.00 setup; 10% tax on trays and the line.
		expect(quote).toMatchObject({
			status: 'sent',
			payable: true,
			subtotalCents: 32_000,
			taxCents: 3_000,
			totalCents: 35_000,
			deposit: { percent: 30, depositCents: 10_500, balanceCents: 24_500 },
		})
		expect(JSON.stringify(quote)).not.toContain('rana@example.com')

		// Accepting starts the payment on the `quote:<id>` ref.
		const accept = await h.guest('POST', `/quotes/${quoteId}/pay`, {
			body: { slug: 'acme' },
			headers: { 'X-Quote-Token': token },
		})
		expect(accept.status).toBe(200)
		const started = await accept.json()
		expect(started.orderRef).toBe(`quote:${quoteId}`)
		expect(started.totalCents).toBe(10_500)
		const bridge = await h.system('/quote', {
			orgId,
			orderId: started.orderRef,
			paymentToken: started.paymentToken,
		})
		expect(bridge.status).toBe(200)
		expect(await bridge.json()).toMatchObject({
			orderId: `quote:${quoteId}`,
			totalCents: 10_500,
		})
		// A second click reuses the same pending order.
		const second = await h.guest('POST', `/quotes/${quoteId}/pay`, {
			body: { slug: 'acme' },
			headers: { 'X-Quote-Token': token },
		})
		expect(second.status).toBe(200)

		const paid = await payOrder(
			h,
			orgId,
			(await orderOfQuote(quoteId)).id,
			'cs_quote',
			started.orderRef,
		)
		expect(paid.paid.status).toBe(200)
		expect((await paid.paid.json()).orderId).toBe(`quote:${quoteId}`)
		const afterQuote = await (
			await h.op('GET', `/quotes/${quoteId}`)
		).json()
		expect(afterQuote.status).toBe('paid')
		expect(afterQuote.paidOrderId).toBeTruthy()
		// It is a paid catering order, with the quote's lines and the deposit.
		const order = await storedOrder(orgId, afterQuote.paidOrderId)
		expect(order).toMatchObject({
			isCatering: true,
			paymentStatus: 'paid',
			status: 'accepted',
			totalCents: 35_000,
			depositCents: 10_500,
			paidCents: 10_500,
			cateringQuoteId: quoteId,
			guestCount: 40,
		})
		const list = await (await h.op('GET', '')).json()
		expect(list.orders[0]).toMatchObject({
			id: order.id,
			paymentStatus: 'paid',
			quoteId,
			balance: { status: 'due', owedCents: 24_500 },
		})
		// A paid quote cannot be paid again.
		const again = await h.guest('POST', `/quotes/${quoteId}/pay`, {
			body: { slug: 'acme' },
			headers: { 'X-Quote-Token': token },
		})
		expect(again.status).toBe(409)
	})

	it('burns the old link when a sent quote is edited (124-3)', async () => {
		useSettings({ quoteMode: 'optional' })
		const { body } = await requestQuote()
		const quoteId: string = body.requestId
		const { email } = await sendQuote(quoteId)
		const oldToken = linkFragment(email.html)
		const read = (token: string) =>
			h.guest('GET', `/quotes/${quoteId}?slug=acme`, {
				headers: { 'X-Quote-Token': token },
			})
		expect((await read(oldToken)).status).toBe(200)

		// The restaurant changes the price: a new version, and the old link is dead.
		const edit = await h.op('PATCH', `/quotes/${quoteId}`, {
			lines: [{ itemId: 'item-tray', quantity: 3, unitPriceCents: 8_000 }],
		})
		expect(edit.status).toBe(200)
		const edited = await edit.json()
		expect(edited.version).toBe(2)
		expect(edited.status).toBe('draft')
		const dead = await read(oldToken)
		expect(dead.status).toBe(403)
		expect((await dead.json()).error).toBe('invalid_quote_token')
		const pay = await h.guest('POST', `/quotes/${quoteId}/pay`, {
			body: { slug: 'acme' },
			headers: { 'X-Quote-Token': oldToken },
		})
		expect(pay.status).toBe(403)
		// Sending it again gives a new link that works.
		const sent = await h.op('POST', `/quotes/${quoteId}/send`)
		expect(sent.status).toBe(200)
		await vi.waitFor(() => expect(h.emails.length).toBeGreaterThan(1))
		const fresh = linkFragment(h.emails.at(-1)!.html)
		expect(fresh).not.toBe(oldToken)
		expect((await read(fresh)).status).toBe(200)
		expect((await read(oldToken)).status).toBe(403)
	})

	it('only pays a sent, unexpired quote (quote_expired, quote_not_payable)', async () => {
		useSettings({ quoteMode: 'optional' })
		const { body } = await requestQuote()
		const quoteId: string = body.requestId
		const { email } = await sendQuote(quoteId, { validDays: 1 })
		const token = linkFragment(email.html)
		const pay = () =>
			h.guest('POST', `/quotes/${quoteId}/pay`, {
				body: { slug: 'acme' },
				headers: { 'X-Quote-Token': token },
			})
		vi.setSystemTime(new Date(NOW.getTime() + 2 * 86_400_000))
		const expired = await pay()
		expect(expired.status).toBe(410)
		expect((await expired.json()).error).toBe('quote_expired')

		// A cancelled quote is gone for good.
		useSettings({ quoteMode: 'optional' })
		vi.setSystemTime(NOW)
		const second = await requestQuote()
		const id2: string = second.body.requestId
		const { email: email2 } = await sendQuote(id2)
		expect((await h.op('POST', `/quotes/${id2}/cancel`)).status).toBe(200)
		const gone = await h.guest('GET', `/quotes/${id2}?slug=acme`, {
			headers: { 'X-Quote-Token': linkFragment(email2.html) },
		})
		expect(gone.status).toBe(403)
		// A draft cannot be sent without a guest address or lines.
		const third = await requestQuote()
		const blank = await h.op('POST', '/quotes', {
			locationId: LOC,
			contact: { name: 'Phone guest' },
			lines: [{ itemName: 'Platter', quantity: 1, unitPriceCents: 5_000 }],
		})
		expect(blank.status).toBe(201)
		const noEmail = await h.op('POST', `/quotes/${(await blank.json()).id}/send`)
		expect(noEmail.status).toBe(422)
		void third
	})

	it('writes a quote from scratch for a phone enquiry', async () => {
		useSettings({ quoteMode: 'optional' })
		const created = await h.op('POST', '/quotes', {
			locationId: LOC,
			fulfillment: 'pickup',
			eventAt: '2026-06-12T16:00:00.000Z',
			guestCount: 25,
			contact: {
				name: 'Phone Guest',
				phone: '+15551234567',
				email: 'phone@example.com',
			},
			lines: [
				{ itemId: 'item-salad', quantity: 2 },
				{ itemName: 'Delivery platter', quantity: 1, unitPriceCents: 4_500 },
			],
			charges: [
				{ kind: 'delivery', label: 'Delivery', amountCents: 1_500 },
			],
			depositPercent: 50,
		})
		expect(created.status).toBe(201)
		const quote = await created.json()
		// 2 salad trays at 60.00 (menu price), 45.00 and a 15.00 delivery charge;
		// 10% tax on the lines only.
		expect(quote).toMatchObject({
			source: 'operator',
			status: 'draft',
			subtotalCents: 18_000,
			taxCents: 1_650,
			totalCents: 19_650,
			depositPercent: 50,
		})
		const sent = await h.op('POST', `/quotes/${quote.id}/send`)
		expect(sent.status).toBe(200)
		await vi.waitFor(() => expect(h.emails).toHaveLength(1))
		const token = linkFragment(h.emails[0]!.html)
		const view = await (
			await h.guest('GET', `/quotes/${quote.id}?slug=acme`, {
				headers: { 'X-Quote-Token': token },
			})
		).json()
		expect(view.deposit).toMatchObject({ percent: 50, depositCents: 9_825 })
	})
})

describe('cutoffs (#255)', () => {
	const CUTOFF = {
		id: 'thu-fri',
		from: '2026-06-04',
		to: '2026-06-05',
		orderByDate: '2026-06-02',
		orderByTime: '17:00',
		note: { en: 'Holiday baking' },
	}

	it('shows the order-by moment before it and refuses a direct request after it (255-1, 255-2)', async () => {
		useSettings({ noticeHours: 0, quoteMode: 'optional', cutoffs: [CUTOFF] })
		// 17:00 on June 2 in New York is 21:00Z. Now is June 1 noon: before it.
		const options = async () =>
			(
				await h.guest('GET', `/options?slug=acme&locationId=${LOC}`)
			).json()
		let body = await options()
		expect(body.cutoffs).toEqual([
			expect.objectContaining({
				id: 'thu-fri',
				orderByAtMs: Date.parse('2026-06-02T21:00:00Z'),
				closed: false,
				note: 'Holiday baking',
			}),
		])
		expect(JSON.stringify(body)).not.toContain('alertUserIds')
		expect((await placeOrder()).response.status).toBe(201)

		vi.setSystemTime(new Date('2026-06-02T21:00:00Z'))
		body = await options()
		expect(body.cutoffs[0].closed).toBe(true)
		const late = await placeOrder()
		expect(late.response.status).toBe(422)
		expect(late.body.error).toBe('catering_cutoff_passed')
		// A date outside the range is still open.
		expect(
			(await placeOrder({ scheduledFor: '2026-06-06T16:00:00.000Z' })).response
				.status,
		).toBe(201)
		// A quote request for the closed dates is refused too.
		const request = await h.guest('POST', '/quote-requests', {
			body: quoteRequestBody({ eventAt: '2026-06-05T16:00:00.000Z' }),
		})
		expect((await request.json()).error).toBe('catering_cutoff_passed')
	})

	it('evaluates in the location zone across a daylight-saving change (255-3)', async () => {
		// New York springs forward on 2026-03-08. The cutoff is 17:00 on March 6
		// (EST, 22:00Z); the event is on March 8 at 20:00Z (16:00 EDT).
		useSettings({
			noticeHours: 0,
			cutoffs: [
				{
					id: 'dst',
					from: '2026-03-08',
					to: '2026-03-09',
					orderByDate: '2026-03-06',
					orderByTime: '17:00',
				},
			],
		})
		vi.setSystemTime(new Date('2026-03-06T21:59:00Z'))
		expect(
			(await placeOrder({ scheduledFor: '2026-03-08T16:00:00.000Z' })).response
				.status,
		).toBe(201)
		vi.setSystemTime(new Date('2026-03-06T22:00:00Z'))
		expect(
			(await placeOrder({ scheduledFor: '2026-03-08T16:00:00.000Z' })).body.error,
		).toBe('catering_cutoff_passed')
	})

	it('leaves an order placed before the cutoff, and a quote already sent, untouched by later edits (255-4)', async () => {
		useSettings({ noticeHours: 0, quoteMode: 'optional' })
		const placed = await placeOrder()
		const id: string = placed.body.order.id
		const quote = await h.guest('POST', '/quote-requests', {
			body: quoteRequestBody(),
		})
		const quoteId: string = (await quote.json()).requestId
		await h.op('PATCH', `/quotes/${quoteId}`, {
			lines: [{ itemId: 'item-tray', quantity: 3, unitPriceCents: 9_000 }],
		})
		await h.op('POST', `/quotes/${quoteId}/send`)
		await vi.waitFor(() => expect(h.emails).toHaveLength(1))
		const token = linkFragment(h.emails[0]!.html)

		// The restaurant adds a cutoff that has already passed for those dates.
		useSettings({
			noticeHours: 0,
			quoteMode: 'optional',
			cutoffs: [
				{
					id: 'late',
					from: '2026-06-04',
					to: '2026-06-05',
					orderByDate: '2026-05-30',
					orderByTime: '09:00',
				},
			],
		})
		// New orders for those dates are refused...
		expect((await placeOrder()).body.error).toBe('catering_cutoff_passed')
		// ...but the order placed earlier still takes its payment...
		const paid = await payOrder(h, orgId, id)
		expect(paid.paid.status).toBe(200)
		expect((await storedOrder(orgId, id)).paymentStatus).toBe('paid')
		// ...and the quote already sent is still payable.
		const accept = await h.guest('POST', `/quotes/${quoteId}/pay`, {
			body: { slug: 'acme' },
			headers: { 'X-Quote-Token': token },
		})
		expect(accept.status).toBe(200)
	})
})

describe('the guest page options and answers (#325)', () => {
	it('serves the settings the page shows, with the typed answers', async () => {
		useSettings({
			noticeHours: 48,
			questions: {
				standard: { cutlery: { en: 'Yes, plates and cutlery are included.' } },
				custom: [],
			},
		})
		const options = await (
			await h.guest('GET', `/options?slug=acme&locationId=${LOC}`)
		).json()
		expect(options.settings.noticeHours).toBe(48)
		expect(options.settings.questions.standard.cutlery.en).toContain('cutlery')
		expect(options.timeZone).toBe('America/New_York')
		// Off for a location without settings: the same 404 as an unknown one.
		h.setContext(orgId, cateringContext(orgId, { settings: {} }))
		expect(
			(await h.guest('GET', `/options?slug=acme&locationId=${LOC}`)).status,
		).toBe(404)
	})
})

void ORIGIN
