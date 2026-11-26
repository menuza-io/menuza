import { getTenantDb, restaurantOrders } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	cateringContext,
	LOC,
	LOC_2,
	ORG_A,
	ORG_B,
	OTHER_ORIGIN,
	orderBody,
	payOrder,
	quoteRequestBody,
	startHarness,
	linkFragment,
	type Harness,
} from '../../tests/catering-fixture.ts'
import { deriveBalanceToken, deriveQuoteToken } from '../lib/catering-tokens.ts'

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
 * Security sweep for catering (#124, #361): forged, reused and old-version
 * quote and balance links, cross-organization access, an excluded location,
 * missing and forged operator tokens, the kill switch, and the rule that a
 * guest's words never reach a response meant for someone else.
 */

let h: Harness

beforeEach(async () => {
	h = await startHarness([ORG_A, ORG_B])
	h.setContext(
		ORG_A.id,
		cateringContext(ORG_A.id, {
			settings: {
				[LOC]: {
					quoteMode: 'optional',
					deposit: {
						percent: 30,
						balanceDueDaysBeforeEvent: 3,
						reminderDaysBeforeDue: 2,
					},
				},
				[LOC_2]: { quoteMode: 'optional' },
			},
		}),
	)
	h.setContext(
		ORG_B.id,
		cateringContext(ORG_B.id, { settings: { [LOC]: { quoteMode: 'optional' } } }),
	)
})
afterEach(async () => {
	await h.cleanup()
})

async function sendQuote(location = LOC) {
	const request = await h.guest('POST', '/quote-requests', {
		body: quoteRequestBody({ locationId: location }),
	})
	const requestId: string = (await request.json()).requestId
	await h.op('PATCH', `/quotes/${requestId}`, {
		lines: [{ itemId: 'item-tray', quantity: 3, unitPriceCents: 9_000 }],
	})
	const before = h.emails.length
	const sent = await h.op('POST', `/quotes/${requestId}/send`)
	expect(sent.status).toBe(200)
	await vi.waitFor(() => expect(h.emails.length).toBeGreaterThan(before))
	return { id: requestId, token: linkFragment(h.emails.at(-1)!.html) }
}

const readQuote = (id: string, token: string, init: { origin?: string } = {}) =>
	h.guest('GET', `/quotes/${id}?slug=acme`, {
		headers: { 'X-Quote-Token': token },
		origin: init.origin,
	})

describe('quote links are versioned capabilities', () => {
	it('answers one identical refusal for a forged, wrong-quote, malformed or missing token', async () => {
		const first = await sendQuote()
		const second = await sendQuote()
		const forgedMac = `${first.id}.1.${'0'.repeat(64)}`
		const otherQuote = second.token // valid for another quote
		const attempts = [
			forgedMac,
			otherQuote,
			'not-a-token',
			`${first.id}.1.${'a'.repeat(63)}`,
			'',
		]
		const bodies = new Set<string>()
		for (const token of attempts) {
			const response = await readQuote(first.id, token)
			expect(response.status).toBe(403)
			bodies.add(JSON.stringify(await response.json()))
		}
		// Nothing tells a guesser whether the quote exists or what is wrong.
		expect(bodies.size).toBe(1)
		const unknown = await readQuote('0b2f4c5e-1a3d-4e6f-8a9b-1c2d3e4f5a6b', first.token)
		expect(unknown.status).toBe(403)
		expect(bodies.has(JSON.stringify(await unknown.json()))).toBe(true)
		// A token in the query string or another header is never read.
		const viaQuery = await h.guest(
			'GET',
			`/quotes/${first.id}?slug=acme&token=${first.token}`,
		)
		expect(viaQuery.status).toBe(400)
		const viaBearer = await h.guest('GET', `/quotes/${first.id}?slug=acme`, {
			headers: { authorization: `Bearer ${first.token}` },
		})
		expect(viaBearer.status).toBe(403)
		// The real token still works.
		expect((await readQuote(first.id, first.token)).status).toBe(200)
	})

	it('burns a token when the version moves, whatever the MAC says', async () => {
		const sent = await sendQuote()
		const version1 = deriveQuoteToken(ORG_A.id, sent.id, 1)
		expect(version1).toBe(sent.token)
		await h.op('PATCH', `/quotes/${sent.id}`, { quoteNote: 'New price' })
		// The old version's token has a correct MAC and is still refused.
		expect((await readQuote(sent.id, version1)).status).toBe(403)
		// The next version's token is refused until the quote is sent again.
		const version2 = deriveQuoteToken(ORG_A.id, sent.id, 2)
		const draft = await readQuote(sent.id, version2)
		expect(draft.status).toBe(409)
		expect((await draft.json()).error).toBe('quote_not_payable')
		// Cancelling burns the link too.
		await h.op('POST', `/quotes/${sent.id}/send`)
		expect((await readQuote(sent.id, version2)).status).toBe(200)
		await h.op('POST', `/quotes/${sent.id}/cancel`)
		expect((await readQuote(sent.id, version2)).status).toBe(403)
	})

	it('never lets a token of one organization open a quote of another', async () => {
		const sent = await sendQuote()
		// The same quote id and token, asked of organization B's own site.
		const response = await h.guest('GET', `/quotes/${sent.id}?slug=other`, {
			headers: { 'X-Quote-Token': sent.token },
			origin: OTHER_ORIGIN,
		})
		expect(response.status).toBe(403)
		// A token minted for B does not open A's quote either.
		const forged = deriveQuoteToken(ORG_B.id, sent.id, 1)
		expect((await readQuote(sent.id, forged)).status).toBe(403)
		// And an origin that is not a published site is the uniform 404.
		const stranger = await h.guest('GET', `/quotes/${sent.id}?slug=acme`, {
			headers: { 'X-Quote-Token': sent.token },
			origin: 'https://evil.example.com',
		})
		expect(stranger.status).toBe(404)
	})

	it('does not accept a quote token as a balance token or the reverse', async () => {
		const sent = await sendQuote()
		const placed = await (await h.postOrder(orderBody())).json()
		const orderId: string = placed.order.id
		await payOrder(h, ORG_A.id, orderId)
		// Same id shape, different purpose: refused.
		const balanceFromQuote = await h.guest('GET', `/balance/${orderId}?slug=acme`, {
			headers: { 'X-Balance-Token': deriveQuoteToken(ORG_A.id, orderId, 1) },
		})
		expect(balanceFromQuote.status).toBe(403)
		const quoteFromBalance = await readQuote(
			sent.id,
			deriveBalanceToken(ORG_A.id, sent.id, 1),
		)
		expect(quoteFromBalance.status).toBe(403)
	})

	it('refuses a second payment on a paid quote and a pay with a forged token', async () => {
		const sent = await sendQuote()
		const forged = await h.guest('POST', `/quotes/${sent.id}/pay`, {
			body: { slug: 'acme' },
			headers: { 'X-Quote-Token': `${sent.id}.1.${'f'.repeat(64)}` },
		})
		expect(forged.status).toBe(403)
		const accept = await (
			await h.guest('POST', `/quotes/${sent.id}/pay`, {
				body: { slug: 'acme' },
				headers: { 'X-Quote-Token': sent.token },
			})
		).json()
		const db = await getTenantDb(ORG_A.id)
		const [order] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.cateringQuoteId, sent.id))
		// The payment bridge refuses a payment token that is not the ref's.
		const wrongToken = await h.system('/quote', {
			orgId: ORG_A.id,
			orderId: accept.orderRef,
			paymentToken: '0'.repeat(64),
		})
		expect(wrongToken.status).toBe(403)
		await payOrder(h, ORG_A.id, order!.id, 'cs_sec_quote', accept.orderRef)
		const again = await h.guest('POST', `/quotes/${sent.id}/pay`, {
			body: { slug: 'acme' },
			headers: { 'X-Quote-Token': sent.token },
		})
		expect(again.status).toBe(409)
		// A payment bound to one session cannot be settled by another.
		const stray = await h.system('/payment-status', {
			orgId: ORG_A.id,
			orderId: accept.orderRef,
			sessionId: 'cs_someone_else',
			processor: 'connect',
			status: 'paid',
			amountCents: order!.depositCents ?? 0,
			currency: 'USD',
		})
		expect(stray.status).toBe(403)
	})
})

describe('balance links', () => {
	async function paidOrder() {
		const placed = await (
			await h.postOrder(orderBody({ scheduledFor: '2026-06-20T16:00:00.000Z' }))
		).json()
		const id: string = placed.order.id
		await payOrder(h, ORG_A.id, id)
		return { id, token: deriveBalanceToken(ORG_A.id, id, 1) }
	}

	it('refuses a forged, old-version or cross-organization balance token the same way', async () => {
		const { id, token } = await paidOrder()
		const read = (value: string, origin?: string, slug = 'acme') =>
			h.guest('GET', `/balance/${id}?slug=${slug}`, {
				headers: { 'X-Balance-Token': value },
				origin,
			})
		expect((await read(token)).status).toBe(200)
		const bodies = new Set<string>()
		for (const bad of [
			`${id}.1.${'1'.repeat(64)}`,
			deriveBalanceToken(ORG_B.id, id, 1),
			'garbage',
		]) {
			const response = await read(bad)
			expect(response.status).toBe(403)
			bodies.add(JSON.stringify(await response.json()))
		}
		expect(bodies.size).toBe(1)
		// Voiding the balance moves the version: the old (valid-MAC) token is burned.
		await h.op('POST', `/orders/${id}/balance`, { action: 'void' })
		const burned = await read(token)
		expect(burned.status).toBe(403)
		expect(bodies.has(JSON.stringify(await burned.json()))).toBe(true)
		expect(
			(
				await h.guest('POST', `/balance/${id}/pay`, {
					body: { slug: 'acme' },
					headers: { 'X-Balance-Token': token },
				})
			).status,
		).toBe(403)
		// Organization B's site sees nothing of A's order.
		expect(
			(await read(deriveBalanceToken(ORG_A.id, id, 2), OTHER_ORIGIN, 'other'))
				.status,
		).toBe(403)
	})

	it('does not take a balance payment before the deposit, or one for the wrong amount', async () => {
		const placed = await (
			await h.postOrder(orderBody({ scheduledFor: '2026-06-20T16:00:00.000Z' }))
		).json()
		const id: string = placed.order.id
		const early = await h.guest('POST', `/balance/${id}/pay`, {
			body: { slug: 'acme' },
			headers: { 'X-Balance-Token': deriveBalanceToken(ORG_A.id, id, 1) },
		})
		expect(early.status).toBe(409)
		await payOrder(h, ORG_A.id, id)
		const started = await (
			await h.guest('POST', `/balance/${id}/pay`, {
				body: { slug: 'acme' },
				headers: { 'X-Balance-Token': deriveBalanceToken(ORG_A.id, id, 1) },
			})
		).json()
		await h.system('/payment-session', {
			orgId: ORG_A.id,
			orderId: started.orderRef,
			sessionId: 'cs_bal_wrong',
			processor: 'connect',
		})
		const wrong = await h.system('/payment-status', {
			orgId: ORG_A.id,
			orderId: started.orderRef,
			sessionId: 'cs_bal_wrong',
			processor: 'connect',
			status: 'paid',
			amountCents: 100,
			currency: 'USD',
		})
		expect(wrong.status).toBe(422)
		const db = await getTenantDb(ORG_A.id)
		const [row] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, id))
		expect(row!.balancePaidCents).toBe(0)
	})
})

describe('operator access', () => {
	it('needs a signed token of the right audience, scope and organization', async () => {
		const sent = await sendQuote()
		const call = (token: string | null) =>
			h.app.request(`/operator/catering/quotes/${sent.id}`, {
				headers: token ? { authorization: `Bearer ${token}` } : {},
			})
		expect((await call(null)).status).toBe(401)
		expect(
			(await call(await h.token({}, { secret: 'a-completely-different-secret-1234567' })))
				.status,
		).toBe(401)
		expect((await call(await h.token({}, { audience: 'someone-else' }))).status).toBe(401)
		expect((await call(await h.token({ role: 'viewer' }))).status).toBe(403)
		expect((await call(await h.token({ scope: 'inventory:read' }))).status).toBe(403)
		// An area-bound browser token never reaches orders.
		expect((await call(await h.token({ area: 'reports' }))).status).toBe(401)
		expect((await call(await h.token({ scope: 'orders:read' }))).status).toBe(200)
		// Reading is not writing.
		const write = await h.op('PATCH', `/quotes/${sent.id}`, { quoteNote: 'x' }, {
			claims: { scope: 'orders:read' },
		})
		expect(write.status).toBe(403)
		// Another organization's operator finds nothing (its own database has no such quote).
		const other = await h.op('GET', `/quotes/${sent.id}`, undefined, {
			orgId: ORG_B.id,
		})
		expect(other.status).toBe(404)
	})

	it('hides quotes and orders at a location the member cannot reach', async () => {
		const here = await sendQuote(LOC)
		const there = await sendQuote(LOC_2)
		const onlyLoc2 = { claims: { locationIds: [LOC_2] } }
		expect((await h.op('GET', `/quotes/${here.id}`, undefined, onlyLoc2)).status).toBe(
			404,
		)
		expect((await h.op('GET', `/quotes/${there.id}`, undefined, onlyLoc2)).status).toBe(
			200,
		)
		// An excluded location is the same 404 for every write.
		for (const [method, path, body] of [
			['PATCH', `/quotes/${here.id}`, { quoteNote: 'x' }],
			['POST', `/quotes/${here.id}/send`, undefined],
			['POST', `/quotes/${here.id}/cancel`, undefined],
		] as const) {
			const response = await h.op(method, path, body, onlyLoc2)
			expect(response.status).toBe(404)
		}
		const create = await h.op(
			'POST',
			'/quotes',
			{
				locationId: LOC,
				lines: [{ itemName: 'Platter', quantity: 1, unitPriceCents: 1_000 }],
			},
			onlyLoc2,
		)
		expect(create.status).toBe(404)
		const list = await (await h.op('GET', '', undefined, onlyLoc2)).json()
		expect(list.quotes.map((q: { id: string }) => q.id)).toEqual([there.id])
		// An order at the excluded location is hidden and cannot be changed.
		const placed = await (
			await h.postOrder(orderBody({ scheduledFor: '2026-06-20T16:00:00.000Z' }))
		).json()
		const orderId: string = placed.order.id
		await payOrder(h, ORG_A.id, orderId)
		expect((await h.op('GET', `/orders/${orderId}`, undefined, onlyLoc2)).status).toBe(
			404,
		)
		expect(
			(
				await h.op(
					'POST',
					`/orders/${orderId}/balance`,
					{ action: 'void' },
					onlyLoc2,
				)
			).status,
		).toBe(404)
		expect(
			(await h.op('POST', `/orders/${orderId}/charges`, { label: 'Tray', amountCents: 100 }, onlyLoc2))
				.status,
		).toBe(404)
		expect(
			(await (await h.op('GET', '', undefined, onlyLoc2)).json()).orders,
		).toHaveLength(0)
		// The member with every location still sees it.
		expect((await h.op('GET', `/orders/${orderId}`)).status).toBe(200)
	})

	it('rejects unknown keys and prices a browser cannot set', async () => {
		const sent = await sendQuote()
		const extra = await h.op('PATCH', `/quotes/${sent.id}`, {
			quoteNote: 'x',
			totalCents: 1,
		})
		expect(extra.status).toBe(400)
		const guest = await h.guest('POST', '/quote-requests', {
			body: { ...quoteRequestBody(), totalCents: 1 },
		})
		expect(guest.status).toBe(400)
		const price = await h.guest('POST', '/quote-requests', {
			body: quoteRequestBody({
				lines: [{ itemId: 'item-tray', quantity: 1, unitPriceCents: 1 }],
			}),
		})
		expect(price.status).toBe(400)
		// The refusal never echoes the key the caller chose.
		expect(JSON.stringify(await price.json())).not.toContain('unitPriceCents')
	})
})

describe('the kill switch (124-5)', () => {
	it('answers 503 on every guest catering route while operators and money already taken keep working', async () => {
		const sent = await sendQuote()
		const placed = await (
			await h.postOrder(orderBody({ scheduledFor: '2026-06-20T16:00:00.000Z' }))
		).json()
		const orderId: string = placed.order.id
		await payOrder(h, ORG_A.id, orderId)
		const accept = await (
			await h.guest('POST', `/quotes/${sent.id}/pay`, {
				body: { slug: 'acme' },
				headers: { 'X-Quote-Token': sent.token },
			})
		).json()
		const balance = await (
			await h.guest('POST', `/balance/${orderId}/pay`, {
				body: { slug: 'acme' },
				headers: {
					'X-Balance-Token': deriveBalanceToken(ORG_A.id, orderId, 1),
				},
			})
		).json()

		// The guest already started paying the quote before the switch was flipped.
		await h.system('/payment-session', {
			orgId: ORG_A.id,
			orderId: accept.orderRef,
			sessionId: 'cs_after_switch',
			processor: 'connect',
		})

		vi.stubEnv('CATERING_PUBLIC_ENABLED', 'false')
		const balanceToken = deriveBalanceToken(ORG_A.id, orderId, 1)
		const guestCalls: Response[] = [
			await h.guest('GET', `/options?slug=acme&locationId=${LOC}`),
			await h.guest('POST', '/quote-requests', { body: quoteRequestBody() }),
			await readQuote(sent.id, sent.token),
			await h.guest('POST', `/quotes/${sent.id}/pay`, {
				body: { slug: 'acme' },
				headers: { 'X-Quote-Token': sent.token },
			}),
			await h.guest('GET', `/balance/${orderId}?slug=acme`, {
				headers: { 'X-Balance-Token': balanceToken },
			}),
			await h.guest('POST', `/balance/${orderId}/pay`, {
				body: { slug: 'acme' },
				headers: { 'X-Balance-Token': balanceToken },
			}),
		]
		for (const response of guestCalls) {
			expect(response.status).toBe(503)
			expect((await response.json()).error).toBe('catering_unavailable')
		}
		// A new catering order is refused; a regular order of this node is not touched here.
		const refused = await h.postOrder(orderBody())
		expect(refused.status).toBe(503)
		// Starting new money through the bridge is stopped...
		expect(
			(
				await h.system('/quote', {
					orgId: ORG_A.id,
					orderId: accept.orderRef,
					paymentToken: accept.paymentToken,
				})
			).status,
		).toBe(503)
		expect(
			(
				await h.system('/payment-session', {
					orgId: ORG_A.id,
					orderId: balance.orderRef,
					sessionId: 'cs_stopped',
					processor: 'connect',
				})
			).status,
		).toBe(503)
		// ...but money already taken still settles.
		const db = await getTenantDb(ORG_A.id)
		const [quoteOrder] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.cateringQuoteId, sent.id))
		const settled = await h.system('/payment-status', {
			orgId: ORG_A.id,
			orderId: accept.orderRef,
			sessionId: 'cs_after_switch',
			processor: 'connect',
			status: 'paid',
			amountCents: quoteOrder!.depositCents ?? 0,
			currency: 'USD',
		})
		expect(settled.status).toBe(200)
		// The operator side keeps working.
		expect((await h.op('GET', '')).status).toBe(200)
		expect((await h.op('GET', `/orders/${orderId}`)).status).toBe(200)
	})
})

describe('what the App and other guests never see', () => {
	it('keeps guest words out of the guest quote view of someone else and out of every alert', async () => {
		const sent = await sendQuote()
		const view = JSON.stringify(await (await readQuote(sent.id, sent.token)).json())
		for (const secret of ['Rana', '555', 'rana@example.com', 'Board lunch', 'vegetarian']) {
			expect(view).not.toContain(secret)
		}
		const placed = await (
			await h.postOrder(orderBody({ scheduledFor: '2026-06-20T16:00:00.000Z' }))
		).json()
		await payOrder(h, ORG_A.id, placed.order.id)
		await vi.waitFor(() =>
			expect(h.notices.some((n) => n.kind === 'order_placed')).toBe(true),
		)
		const raw = JSON.stringify(h.notices)
		for (const secret of ['Rana', 'Khalid', '555', 'rana@example.com', 'Office lunch', 'nuts']) {
			expect(raw).not.toContain(secret)
		}
		for (const notice of h.notices) {
			expect(Object.keys(notice).sort()).toEqual([
				'count',
				'kind',
				'locationId',
				'orgId',
				'refId',
			])
		}
	})
})
