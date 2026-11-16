import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	defaultGiftCardSettings,
	GiftCardDomainError,
	type GiftCardSettings,
} from '@repo/common/gift-cards'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	giftCardLedger,
	giftCards,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import { clearGiftCardContextCache } from '../lib/gift-card-context.ts'
import { openGiftCardCode } from '../lib/gift-card-secret.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'

const sent = vi.hoisted(
	() => [] as Array<{ to: string; subject: string; html: string }>,
)

vi.mock('../lib/tenant-email.ts', () => ({
	canSendTenantEmail: () => true,
	sendTenantEmail: vi.fn(
		async (input: { to: string; subject: string; html: string }) => {
			sent.push({ to: input.to, subject: input.subject, html: input.html })
			return { status: 'sent' as const }
		},
	),
}))
vi.mock('../lib/reservations-context.ts', () => ({
	getReservationsContext: vi.fn(async () => ({
		organization: {
			name: 'Test Kitchen',
			defaultLocale: 'en',
			siteOrigin: 'https://test.example',
			emailTheme: { organizationName: 'Test Kitchen' },
		},
		locations: [{ id: 'loc_a', timeZone: 'America/Chicago' }],
	})),
}))
vi.mock('../lib/gift-card-context.ts', () => ({
	getGiftCardFlagState: vi.fn(async () => ({
		status: 'on' as const,
		features: { enabled: true, online: true, pos: true },
		settings: {
			presetsMinor: [2500, 5000],
			minAmountMinor: 500,
			maxAmountMinor: 50_000,
			allowCustomAmount: true,
			expiryMonths: null,
			designs: [{ key: 'classic', enabled: true, imageKey: null }],
			defaultDesign: 'classic',
			defaultLocationId: null,
			limits: {
				maxCardMajor: 500,
				maxPerPurchaseMajor: 500,
				maxPurchasesPer24h: 3,
				holdThresholdMajor: 100,
				holdHours: 2,
				burstPerHour: 5,
			},
		},
		currency: 'USD',
		locations: [],
	})),
	clearGiftCardContextCache: vi.fn(),
}))
vi.mock('../lib/gift-card-notify.ts', () => ({
	postGiftCardNotify: vi.fn(async () => 'delivered' as const),
}))

import {
	adjustGiftCard,
	chargeGiftCard,
	redeemGiftCardAtTill,
	refundGiftCardCharge,
	sellGiftCard,
	topUpGiftCard,
	voidGiftCard,
} from './gift-card-service.ts'
import {
	applyGiftCardDispute,
	applyGiftCardPaymentEvent,
	approveHeldGiftCard,
	bindGiftCardPaymentSession,
	bookGiftCardPurchaseRefund,
	createGiftCardPurchase,
	getGiftCardQuote,
	runGiftCardTick,
} from './gift-card-purchase-service.ts'
import {
	claimGiftCard,
	createShowToken,
	listSavedGiftCards,
} from './gift-card-account-service.ts'
import {
	giftShareOfOrder,
	refundGiftShareInTx,
	restoreOrderGiftCardsInTx,
} from './gift-card-orders.ts'
import { redeemGiftCardInTx } from './gift-card-service.ts'
import { findGiftCardByCode, giftCardBalance } from './gift-card-store.ts'
import { runTenantTransaction } from '@repo/tenant-db'

const ORG = 'org_gift_cards_svc'
let dir = ''
const settings: GiftCardSettings = {
	...defaultGiftCardSettings(),
	minAmountMinor: 500,
	maxAmountMinor: 50_000,
}
const actor = { id: 'user_1', name: 'Pat Manager' }
let n = 0
const rid = () => `req-${Date.now().toString(36)}-${(n += 1)}`

async function sell(amountMinor: number, code?: string) {
	return sellGiftCard({
		orgId: ORG,
		code,
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

async function redeem(code: string, amountMinor: number, requestId = rid()) {
	return redeemGiftCardAtTill({
		orgId: ORG,
		code,
		amountMinor,
		saleId: `sale-${requestId}`,
		clientRequestId: requestId,
		deviceId: 'dev_1',
		locationId: 'loc_b',
		actor,
	})
}

async function expectCode(promise: Promise<unknown>, code: string) {
	let caught: unknown
	try {
		await promise
	} catch (error) {
		caught = error
	}
	expect(caught, `expected ${code}`).toBeInstanceOf(GiftCardDomainError)
	expect((caught as GiftCardDomainError).code).toBe(code)
	return caught as GiftCardDomainError
}

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-cards-svc-'))
	process.env.TENANT_DB_DIR = dir
	process.env.DATA_REGION = 'us'
	process.env.AUTH_HMAC_SECRET = 'gift-card-test-hmac-secret-0123456789abcdef'
	process.env.INTERNAL_COMMAND_TOKEN = 'gift-card-test-internal-0123456789'
	syncEnvFromProcess()
	await provisionTenantDb(ORG)
})

afterAll(async () => {
	await destroyTenantDb(ORG).catch(() => undefined)
	fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
	sent.length = 0
	clearGiftCardContextCache()
})

describe('selling and redeeming at the till', () => {
	it('sells a card with a code shown once, and a replay returns the same card', async () => {
		const clientRequestId = rid()
		const input = {
			orgId: ORG,
			amountMinor: 5000,
			currency: 'USD',
			locationId: 'loc_a',
			actor,
			deviceId: 'dev_1',
			clientRequestId,
			paymentMethod: 'cash' as const,
			settings,
		}
		const first = await sellGiftCard(input)
		expect(first.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/)
		expect(first.balanceMinor).toBe(5000)
		const replay = await sellGiftCard(input)
		expect(replay.cardId).toBe(first.cardId)
		expect(replay.code).toBeNull()
		const db = await getTenantDb(ORG)
		expect(await giftCardBalance(db, first.cardId)).toBe(5000)
		// Only the hash and the last four are kept.
		const row = await db
			.select()
			.from(giftCards)
			.where(eq(giftCards.id, first.cardId))
			.get()
		expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/)
		expect(row?.last4).toBe(first.code!.slice(-4))
		expect(JSON.stringify(row)).not.toContain(first.code!)
	})

	it('finds the card by what a person types (case, dashes and look-alikes)', async () => {
		const sold = await sell(2500)
		const db = await getTenantDb(ORG)
		const typed = sold.formattedCode!.toLowerCase()
		expect((await findGiftCardByCode(db, typed))?.id).toBe(sold.cardId)
		expect(await findGiftCardByCode(db, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ')).toBeNull()
	})

	it('refuses an amount outside the settings', async () => {
		await expectCode(sell(100), 'amount_out_of_range')
		await expectCode(sell(60_000), 'amount_out_of_range')
	})

	it('redeems at most the balance, answers the balance, and replays by key', async () => {
		const sold = await sell(5000)
		const requestId = rid()
		const first = await redeem(sold.code!, 3000, requestId)
		expect(first.balanceMinor).toBe(2000)
		const error = await expectCode(
			redeem(sold.code!, 2500),
			'gift_card_balance_low',
		)
		expect(error.details.balanceMinor).toBe(2000)
		const replay = await redeem(sold.code!, 3000, requestId)
		expect(replay.reference).toBe(first.reference)
		const db = await getTenantDb(ORG)
		expect(await giftCardBalance(db, sold.cardId)).toBe(2000)
	})

	it('never takes more than the balance when redemptions race', async () => {
		const sold = await sell(10_000)
		const results = await Promise.allSettled(
			Array.from({ length: 8 }, () => redeem(sold.code!, 3000)),
		)
		const ok = results.filter((r) => r.status === 'fulfilled')
		const refused = results.filter(
			(r): r is PromiseRejectedResult => r.status === 'rejected',
		)
		expect(ok).toHaveLength(3)
		expect(refused).toHaveLength(5)
		for (const r of refused) {
			expect((r.reason as GiftCardDomainError).code).toBe(
				'gift_card_balance_low',
			)
		}
		const db = await getTenantDb(ORG)
		expect(await giftCardBalance(db, sold.cardId)).toBe(1000)
	})

	it('tops up an active card and refuses past the largest card', async () => {
		const sold = await sell(5000)
		const topped = await topUpGiftCard({
			orgId: ORG,
			code: sold.code!,
			amountMinor: 2500,
			locationId: 'loc_a',
			actor,
			deviceId: 'dev_1',
			clientRequestId: rid(),
			settings,
		})
		expect(topped.balanceMinor).toBe(7500)
		await expectCode(
			topUpGiftCard({
				orgId: ORG,
				code: sold.code!,
				amountMinor: 49_000,
				locationId: 'loc_a',
				actor,
				deviceId: 'dev_1',
				clientRequestId: rid(),
				settings,
			}),
			'amount_out_of_range',
		)
	})

	it('records where a card was sold and where it was spent', async () => {
		const sold = await sell(4000)
		await redeem(sold.code!, 1000)
		const db = await getTenantDb(ORG)
		const rows = await db
			.select()
			.from(giftCardLedger)
			.where(eq(giftCardLedger.cardId, sold.cardId))
		expect(rows.find((r) => r.kind === 'issue')?.locationId).toBe('loc_a')
		expect(rows.find((r) => r.kind === 'redeem')?.locationId).toBe('loc_b')
	})
})

describe('adjust, void, charge', () => {
	it('adjusts only against the expected balance, with a reason and a named operator', async () => {
		const sold = await sell(5000)
		const error = await expectCode(
			adjustGiftCard({
				orgId: ORG,
				cardId: sold.cardId,
				expectedBalanceMinor: 4000,
				deltaMinor: 500,
				reason: 'goodwill',
				actor,
			}),
			'stale_balance',
		)
		expect(error.details.balanceMinor).toBe(5000)
		await expectCode(
			adjustGiftCard({
				orgId: ORG,
				cardId: sold.cardId,
				expectedBalanceMinor: 5000,
				deltaMinor: 500,
				reason: '   ',
				actor,
			}),
			'invalid_request',
		)
		await expectCode(
			adjustGiftCard({
				orgId: ORG,
				cardId: sold.cardId,
				expectedBalanceMinor: 5000,
				deltaMinor: 500,
				reason: 'goodwill',
				actor: { id: null, name: null },
			}),
			'invalid_request',
		)
		const done = await adjustGiftCard({
			orgId: ORG,
			cardId: sold.cardId,
			expectedBalanceMinor: 5000,
			deltaMinor: -1000,
			reason: 'typed wrong at the till',
			actor,
		})
		expect(done.balanceMinor).toBe(4000)
		await expectCode(
			adjustGiftCard({
				orgId: ORG,
				cardId: sold.cardId,
				expectedBalanceMinor: 4000,
				deltaMinor: -5000,
				reason: 'too much',
				actor,
			}),
			'gift_card_balance_low',
		)
		const db = await getTenantDb(ORG)
		const adjust = await db
			.select()
			.from(giftCardLedger)
			.where(eq(giftCardLedger.cardId, sold.cardId))
		const line = adjust.find((r) => r.kind === 'adjust')
		expect(line?.actorName).toBe('Pat Manager')
		expect(line?.reason).toBe('typed wrong at the till')
	})

	it('voids a card: the balance goes, it cannot be spent, a second void is a no-op', async () => {
		const sold = await sell(5000)
		const voided = await voidGiftCard({
			orgId: ORG,
			cardId: sold.cardId,
			reason: 'lost',
			actor,
		})
		expect(voided.removedMinor).toBe(5000)
		await expectCode(redeem(sold.code!, 100), 'gift_card_voided')
		const again = await voidGiftCard({
			orgId: ORG,
			cardId: sold.cardId,
			reason: 'lost',
			actor,
		})
		expect(again.removedMinor).toBe(0)
		const db = await getTenantDb(ORG)
		expect(await giftCardBalance(db, sold.cardId)).toBe(0)
	})

	it('charges from the app: over the balance is refused, a replayed key charges once, and a refund never exceeds the charge', async () => {
		const sold = await sell(5000)
		await expectCode(
			chargeGiftCard({
				orgId: ORG,
				cardId: sold.cardId,
				amountMinor: 6000,
				note: 'catering deposit',
				locationId: null,
				actor,
				clientRequestId: rid(),
			}),
			'gift_card_balance_low',
		)
		await expectCode(
			chargeGiftCard({
				orgId: ORG,
				cardId: sold.cardId,
				amountMinor: 1000,
				note: '',
				locationId: null,
				actor,
				clientRequestId: rid(),
			}),
			'invalid_request',
		)
		const clientRequestId = rid()
		const charge = await chargeGiftCard({
			orgId: ORG,
			cardId: sold.cardId,
			amountMinor: 3000,
			note: 'catering deposit',
			attachTo: { kind: 'quote', id: 'quote_1' },
			locationId: null,
			actor,
			clientRequestId,
		})
		const replay = await chargeGiftCard({
			orgId: ORG,
			cardId: sold.cardId,
			amountMinor: 3000,
			note: 'catering deposit',
			attachTo: { kind: 'quote', id: 'quote_1' },
			locationId: null,
			actor,
			clientRequestId,
		})
		expect(replay.chargeId).toBe(charge.chargeId)
		expect(replay.balanceMinor).toBe(2000)
		const refund = await refundGiftCardCharge({
			orgId: ORG,
			cardId: sold.cardId,
			chargeId: charge.chargeId,
			amountMinor: 2000,
			actor,
			clientRequestId: rid(),
		})
		expect(refund.balanceMinor).toBe(4000)
		await expectCode(
			refundGiftCardCharge({
				orgId: ORG,
				cardId: sold.cardId,
				chargeId: charge.chargeId,
				amountMinor: 1500,
				actor,
				clientRequestId: rid(),
			}),
			'gift_card_refund_exceeds_charge',
		)
		const db = await getTenantDb(ORG)
		const history = await db
			.select()
			.from(giftCardLedger)
			.where(eq(giftCardLedger.cardId, sold.cardId))
		const entry = history.find(
			(r) => r.sourceType === 'manual_charge' && r.kind === 'redeem',
		)
		expect(entry?.channel).toBe('app')
		expect(entry?.note).toBe('catering deposit')
		expect(entry?.actorName).toBe('Pat Manager')
	})
})

describe('printed (inactive) cards', () => {
	async function inactiveCard() {
		const db = await getTenantDb(ORG)
		const { insertGiftCard } = await import('./gift-card-service.ts')
		return runTenantTransaction(db, (tx) =>
			insertGiftCard(tx, {
				status: 'inactive',
				source: 'print',
				currency: 'USD',
				now: Date.now(),
				expiresAt: null,
				locationId: 'loc_a',
			}),
		)
	}

	it('cannot be redeemed or topped up until it is sold, then works anywhere', async () => {
		const { code } = await inactiveCard()
		await expectCode(redeem(code, 100), 'gift_card_inactive')
		await expectCode(
			topUpGiftCard({
				orgId: ORG,
				code,
				amountMinor: 1000,
				locationId: 'loc_a',
				actor,
				deviceId: 'dev_1',
				clientRequestId: rid(),
				settings,
			}),
			'gift_card_inactive',
		)
		const activated = await sell(2500, code)
		expect(activated.status).toBe('active')
		expect(activated.balanceMinor).toBe(2500)
		await expectCode(sell(2500, code), 'already_active')
		expect((await redeem(code, 1000)).balanceMinor).toBe(1500)
	})
})

describe('online purchases', () => {
	const purchaser = {
		customerId: null,
		name: 'Buyer',
		email: 'buyer@example.test',
	}

	async function start(
		overrides: Partial<Parameters<typeof createGiftCardPurchase>[0]> = {},
	) {
		return createGiftCardPurchase({
			orgId: ORG,
			settings,
			currency: 'USD',
			locationId: 'loc_a',
			amountMinor: 5000,
			designKey: 'classic',
			recipient: { name: 'Friend', email: `friend-${rid()}@example.test` },
			sendToSelf: false,
			senderName: 'Buyer',
			message: 'Enjoy',
			deliverAt: null,
			purchaser: { ...purchaser, email: `buyer-${rid()}@example.test` },
			locale: 'en',
			deviceId: `device-${rid()}`,
			...overrides,
		})
	}

	async function pay(
		started: Awaited<ReturnType<typeof start>>,
		options: {
			settings?: GiftCardSettings
			risk?: {
				level: 'normal' | 'elevated' | 'highest'
				paymentFingerprint?: string
			}
		} = {},
	) {
		const sessionId = `cs_${rid()}`
		const bound = await bindGiftCardPaymentSession({
			orgId: ORG,
			cardId: started.cardId,
			sessionId,
			processor: 'connect',
		})
		expect(bound.ok).toBe(true)
		const event = {
			orgId: ORG,
			cardId: started.cardId,
			sessionId,
			processor: 'connect' as const,
			status: 'paid' as const,
			amountCents: started.totalMinor,
			currency: 'USD',
			paymentId: `pi_${rid()}`,
			settings: options.settings ?? settings,
			risk: options.risk,
		}
		const result = await applyGiftCardPaymentEvent(event)
		return Object.assign(result, {
			replay: () => applyGiftCardPaymentEvent(event),
		})
	}

	it('is a pending card, quoted and paid through the gc: bridge, then active and delivered', async () => {
		const started = await start()
		expect(started.orderRef).toBe(`gc:${started.cardId}`)
		const quote = await getGiftCardQuote(
			ORG,
			started.cardId,
			started.paymentToken,
		)
		expect(quote.ok && quote.data.totalCents).toBe(5000)
		const forged = await getGiftCardQuote(ORG, started.cardId, 'x'.repeat(64))
		expect(forged.ok).toBe(false)
		// Not spendable before it is paid.
		const db = await getTenantDb(ORG)
		const row = await db
			.select()
			.from(giftCards)
			.where(eq(giftCards.id, started.cardId))
			.get()
		expect(row?.status).toBe('pending')
		expect(row?.sealedCode).toBeTruthy()

		const paid = await pay(started)
		expect(paid.ok).toBe(true)
		const after = await db
			.select()
			.from(giftCards)
			.where(eq(giftCards.id, started.cardId))
			.get()
		expect(after?.status).toBe('active')
		expect(await giftCardBalance(db, started.cardId)).toBe(5000)
		// A redelivered event changes nothing and issues nothing twice.
		const replay = await paid.replay()
		expect(replay.ok).toBe(true)
		expect(await giftCardBalance(db, started.cardId)).toBe(5000)

		// Receipt to the buyer, card to the recipient, the seal cleared.
		const delivered = await db
			.select()
			.from(giftCards)
			.where(eq(giftCards.id, started.cardId))
			.get()
		expect(delivered?.deliveredAt).not.toBeNull()
		expect(delivered?.sealedCode).toBeNull()
		expect(sent.some((m) => m.to.startsWith('buyer-'))).toBe(true)
		const toRecipient = sent.find((m) => m.to.startsWith('friend-'))
		expect(toRecipient?.html).toMatch(
			/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/,
		)
		// The delivery email is the only place the code appears.
		expect(sent.find((m) => m.to.startsWith('buyer-'))?.html).not.toMatch(
			/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/,
		)
	})

	it('keeps the processing fee out of the balance', async () => {
		const started = await start({ feeMinor: 150 })
		expect(started.totalMinor).toBe(5150)
		await pay(started)
		const db = await getTenantDb(ORG)
		expect(await giftCardBalance(db, started.cardId)).toBe(5000)
	})

	it('refuses a payment of the wrong amount into review, never into a balance', async () => {
		const started = await start()
		const sessionId = `cs_${rid()}`
		await bindGiftCardPaymentSession({
			orgId: ORG,
			cardId: started.cardId,
			sessionId,
			processor: 'connect',
		})
		const result = await applyGiftCardPaymentEvent({
			orgId: ORG,
			cardId: started.cardId,
			sessionId,
			processor: 'connect',
			status: 'paid',
			amountCents: 100,
			currency: 'USD',
			settings,
		})
		expect(result.ok && result.data.paymentStatus).toBe('review')
		const db = await getTenantDb(ORG)
		expect(await giftCardBalance(db, started.cardId)).toBe(0)
	})

	it('refuses purchases over a limit before payment, without saying which', async () => {
		const tight: GiftCardSettings = {
			...settings,
			maxAmountMinor: 1_000_000,
			limits: {
				...settings.limits,
				maxCardMajor: 100,
				maxPerPurchaseMajor: 100,
				maxPurchasesPer24h: 2,
			},
		}
		const error = await expectCode(
			start({ settings: tight, amountMinor: 20_000 }),
			'purchase_limit',
		)
		expect(JSON.stringify(error.details)).toBe('{}')
		const email = `repeat-${rid()}@example.test`
		const device = `device-${rid()}`
		await start({
			settings: tight,
			amountMinor: 1000,
			purchaser: { ...purchaser, email },
			deviceId: device,
		})
		await start({
			settings: tight,
			amountMinor: 1000,
			purchaser: { ...purchaser, email },
			deviceId: `d-${rid()}`,
		})
		await expectCode(
			start({
				settings: tight,
				amountMinor: 1000,
				purchaser: { ...purchaser, email },
				deviceId: `d-${rid()}`,
			}),
			'purchase_limit',
		)
		// The same device is limited on its own, with another email.
		await start({ settings: tight, amountMinor: 1000, deviceId: device })
		await expectCode(
			start({ settings: tight, amountMinor: 1000, deviceId: device }),
			'purchase_limit',
		)
	})

	it('holds a first-time buyer’s immediate high-value card, and the tick releases it after the delay', async () => {
		const started = await start({ amountMinor: 20_000 })
		const first = await pay(started)
		expect(first.ok).toBe(true)
		const db = await getTenantDb(ORG)
		const held = await db
			.select()
			.from(giftCards)
			.where(eq(giftCards.id, started.cardId))
			.get()
		expect(held?.status).toBe('held')
		expect(held?.holdReason).toBe('first_buyer')
		expect(held?.holdUntil).toBeGreaterThan(Date.now())
		// Held means unspendable and undelivered.
		const code = openGiftCardCode(held!.sealedCode!)!
		await expectCode(redeem(code, 100), 'gift_card_held')
		expect(sent.find((m) => m.to.startsWith('friend-'))).toBeUndefined()
		// Not released early.
		await runGiftCardTick(ORG, { now: Date.now() + 60 * 60_000 })
		expect(
			(
				await db
					.select()
					.from(giftCards)
					.where(eq(giftCards.id, started.cardId))
					.get()
			)?.status,
		).toBe('held')
		// Released after the delay, and delivered then.
		const totals = await runGiftCardTick(ORG, {
			now: Date.now() + 2 * 60 * 60_000 + 1000,
		})
		expect(totals.released).toBeGreaterThanOrEqual(1)
		const released = await db
			.select()
			.from(giftCards)
			.where(eq(giftCards.id, started.cardId))
			.get()
		expect(released?.status).toBe('active')
		expect(sent.find((m) => m.to.startsWith('friend-'))).toBeDefined()
	})

	it('does not hold a scheduled (later) card or a small one', async () => {
		const laterEmail = `later-${rid()}@example.test`
		const later = await start({
			amountMinor: 20_000,
			deliverAt: Date.now() + 3 * 24 * 60 * 60_000,
			recipient: { name: 'Later', email: laterEmail },
		})
		await pay(later)
		const small = await start({ amountMinor: 2000 })
		await pay(small)
		const db = await getTenantDb(ORG)
		expect(
			(
				await db
					.select()
					.from(giftCards)
					.where(eq(giftCards.id, later.cardId))
					.get()
			)?.status,
		).toBe('active')
		expect(
			(
				await db
					.select()
					.from(giftCards)
					.where(eq(giftCards.id, small.cardId))
					.get()
			)?.status,
		).toBe('active')
		// The scheduled card waits for its date.
		expect(sent.find((m) => m.to === laterEmail)).toBeUndefined()
		// Until its date: then the tick sends it.
		await runGiftCardTick(ORG, { now: Date.now() + 4 * 24 * 60 * 60_000 })
		expect(sent.find((m) => m.to === laterEmail)).toBeDefined()
	})

	it('holds an elevated-risk payment for review until approved, and review is not timed', async () => {
		const started = await start({ amountMinor: 2000 })
		await pay(started, {
			risk: { level: 'elevated', paymentFingerprint: 'fp_1' },
		})
		const db = await getTenantDb(ORG)
		const held = await db
			.select()
			.from(giftCards)
			.where(eq(giftCards.id, started.cardId))
			.get()
		expect(held?.status).toBe('held')
		expect(held?.holdReason).toBe('provider_risk')
		expect(held?.holdUntil).toBeNull()
		await runGiftCardTick(ORG, { now: Date.now() + 48 * 60 * 60_000 })
		expect(
			(
				await db
					.select()
					.from(giftCards)
					.where(eq(giftCards.id, started.cardId))
					.get()
			)?.status,
		).toBe('held')
		await approveHeldGiftCard({ orgId: ORG, cardId: started.cardId, actor })
		expect(
			(
				await db
					.select()
					.from(giftCards)
					.where(eq(giftCards.id, started.cardId))
					.get()
			)?.status,
		).toBe('active')
		await expectCode(
			approveHeldGiftCard({ orgId: ORG, cardId: started.cardId, actor }),
			'not_held',
		)
	})

	it('holds a payment card that bought too many in a day', async () => {
		const tight: GiftCardSettings = {
			...settings,
			limits: { ...settings.limits, maxPurchasesPer24h: 2 },
		}
		const fingerprint = `fp_${rid()}`
		for (let i = 0; i < 2; i += 1) {
			const started = await start({ settings: tight, amountMinor: 1000 })
			await pay(started, {
				settings: tight,
				risk: { level: 'normal', paymentFingerprint: fingerprint },
			})
		}
		const third = await start({ settings: tight, amountMinor: 1000 })
		await pay(third, {
			settings: tight,
			risk: { level: 'normal', paymentFingerprint: fingerprint },
		})
		const db = await getTenantDb(ORG)
		const row = await db
			.select()
			.from(giftCards)
			.where(eq(giftCards.id, third.cardId))
			.get()
		expect(row?.status).toBe('held')
		expect(row?.holdReason).toBe('manual')
	})

	it('freezes a disputed purchase at once, keeps what was spent, and removes the rest if the dispute is lost', async () => {
		const started = await start({ amountMinor: 2000 })
		await pay(started)
		const db = await getTenantDb(ORG)
		const row = await db
			.select()
			.from(giftCards)
			.where(eq(giftCards.id, started.cardId))
			.get()
		const code = openGiftCardCode(row!.sealedCode ?? '') // already delivered: sealed is gone
		expect(code).toBeNull()
		// Spend 500 before the dispute, using the code from the delivery email.
		const emailed = sent.find((m) => m.to.startsWith('friend-'))!
		const codeText = emailed.html.match(
			/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/,
		)![0]
		await redeem(codeText, 500)

		const frozen = await applyGiftCardDispute({
			orgId: ORG,
			cardId: started.cardId,
			status: 'open',
		})
		expect(frozen.ok && frozen.status).toBe('frozen')
		await expectCode(redeem(codeText, 100), 'gift_card_frozen')
		// Idempotent.
		const again = await applyGiftCardDispute({
			orgId: ORG,
			cardId: started.cardId,
			status: 'open',
		})
		expect(again.ok && again.changed).toBe(false)
		const history = await db
			.select()
			.from(giftCardLedger)
			.where(eq(giftCardLedger.cardId, started.cardId))
		expect(
			history.some(
				(h) => h.kind === 'event' && /frozen: dispute/.test(h.reason ?? ''),
			),
		).toBe(true)

		const lost = await applyGiftCardDispute({
			orgId: ORG,
			cardId: started.cardId,
			status: 'lost',
		})
		expect(lost.ok && lost.status).toBe('voided')
		expect(await giftCardBalance(db, started.cardId)).toBe(0)
		expect(
			(
				await db
					.select()
					.from(giftCardLedger)
					.where(eq(giftCardLedger.cardId, started.cardId))
			).some((h) => h.kind === 'dispute_removal'),
		).toBe(true)
	})

	it('lifts the freeze when the dispute is won', async () => {
		const started = await start({ amountMinor: 2000 })
		await pay(started)
		await applyGiftCardDispute({
			orgId: ORG,
			cardId: started.cardId,
			status: 'open',
		})
		const won = await applyGiftCardDispute({
			orgId: ORG,
			cardId: started.cardId,
			status: 'won',
		})
		expect(won.ok && won.status).toBe('active')
	})

	it('refunds a purchase only up to the unspent balance', async () => {
		const started = await start({ amountMinor: 3000 })
		await pay(started)
		const db = await getTenantDb(ORG)
		const emailed = sent.find((m) => m.to.startsWith('friend-'))!
		const codeText = emailed.html.match(
			/[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/,
		)![0]
		await redeem(codeText, 1000)
		const error = await expectCode(
			bookGiftCardPurchaseRefund({
				orgId: ORG,
				cardId: started.cardId,
				amountMinor: 2500,
				actor,
			}),
			'refund_exceeds_unspent',
		)
		expect(error.details.unspentMinor).toBe(2000)
		const booked = await bookGiftCardPurchaseRefund({
			orgId: ORG,
			cardId: started.cardId,
			actor,
		})
		expect(booked.refundMinor).toBe(2000)
		expect(booked.voided).toBe(true)
		expect(await giftCardBalance(db, started.cardId)).toBe(0)
		await expectCode(
			bookGiftCardPurchaseRefund({ orgId: ORG, cardId: started.cardId, actor }),
			'refund_exceeds_unspent',
		)
	})

	it('never delays or holds a till sale', async () => {
		const sold = await sell(40_000)
		const db = await getTenantDb(ORG)
		const row = await db
			.select()
			.from(giftCards)
			.where(eq(giftCards.id, sold.cardId))
			.get()
		expect(row?.status).toBe('active')
		expect((await redeem(sold.code!, 100)).balanceMinor).toBe(39_900)
	})

	it('voids a purchase whose payment never started, and keeps a late payment for review', async () => {
		const started = await start({ amountMinor: 1500 })
		await runGiftCardTick(ORG, { now: Date.now() + 2 * 60 * 60_000 })
		const db = await getTenantDb(ORG)
		expect(
			(
				await db
					.select()
					.from(giftCards)
					.where(eq(giftCards.id, started.cardId))
					.get()
			)?.status,
		).toBe('voided')
		const sessionId = `cs_${rid()}`
		// A session bound after the window cannot attach to a voided purchase.
		const bound = await bindGiftCardPaymentSession({
			orgId: ORG,
			cardId: started.cardId,
			sessionId,
			processor: 'connect',
		})
		expect(bound.ok).toBe(false)
		const late = await applyGiftCardPaymentEvent({
			orgId: ORG,
			cardId: started.cardId,
			sessionId,
			processor: 'connect',
			status: 'paid',
			amountCents: 1500,
			currency: 'USD',
			settings,
		})
		expect(late.ok && late.data.paymentStatus).toBe('review')
		expect(await giftCardBalance(db, started.cardId)).toBe(0)
	})
})

describe("a guest's account", () => {
	async function customer(name: string) {
		const db = await getTenantDb(ORG)
		const [row] = await db
			.insert(customers)
			.values({ name, email: `${name}@example.test` })
			.returning()
		return row!.id
	}

	it('saves a card by its code, moves it with the full code, and keeps the balance on erasure', async () => {
		const sold = await sell(5000)
		const alice = await customer(`alice-${rid()}`)
		const bob = await customer(`bob-${rid()}`)
		const mine = await claimGiftCard({
			orgId: ORG,
			customerId: alice,
			code: sold.code!,
		})
		expect(mine.alreadyMine).toBe(false)
		expect(
			(await claimGiftCard({ orgId: ORG, customerId: alice, code: sold.code! }))
				.alreadyMine,
		).toBe(true)
		expect((await listSavedGiftCards(ORG, alice))[0]?.balanceMinor).toBe(5000)
		// A wrong code saves nothing.
		await expectCode(
			claimGiftCard({ orgId: ORG, customerId: bob, code: 'ZZZZZZZZZZZZZZZZ' }),
			'code_invalid',
		)
		// Another account saving it needs the full code and takes it over.
		const moved = await claimGiftCard({
			orgId: ORG,
			customerId: bob,
			code: sold.code!,
		})
		expect(moved.movedFrom).toBe(alice)
		expect(await listSavedGiftCards(ORG, alice)).toHaveLength(0)
		expect(await listSavedGiftCards(ORG, bob)).toHaveLength(1)
		// Saving is a convenience: the code still spends.
		expect((await redeem(sold.code!, 1000)).balanceMinor).toBe(4000)
		// Erasing the person unlinks the card and keeps the balance.
		const db = await getTenantDb(ORG)
		await db.delete(customers).where(eq(customers.id, bob))
		const row = await db
			.select()
			.from(giftCards)
			.where(eq(giftCards.id, sold.cardId))
			.get()
		expect(row?.holderCustomerId).toBeNull()
		expect(await giftCardBalance(db, sold.cardId)).toBe(4000)
	})

	it('shows a one-use QR token that is not the code, expires, and spends once', async () => {
		const sold = await sell(5000)
		const carol = await customer(`carol-${rid()}`)
		await claimGiftCard({ orgId: ORG, customerId: carol, code: sold.code! })
		const dave = await customer(`dave-${rid()}`)
		await expectCode(
			createShowToken({ orgId: ORG, customerId: dave, cardId: sold.cardId }),
			'not_found',
		)
		const { token, expiresAt } = await createShowToken({
			orgId: ORG,
			customerId: carol,
			cardId: sold.cardId,
		})
		expect(token).not.toContain(sold.code!)
		expect(expiresAt).toBeGreaterThan(Date.now())
		const first = await redeem(token, 1500)
		expect(first.balanceMinor).toBe(3500)
		// Replaying the same token is refused.
		await expectCode(redeem(token, 100), 'code_invalid')
		// An expired token is refused.
		const second = await createShowToken({
			orgId: ORG,
			customerId: carol,
			cardId: sold.cardId,
			now: Date.now() - 10 * 60_000,
		})
		await expectCode(redeem(second.token, 100), 'code_invalid')
		// A new token supersedes the older one.
		const a = await createShowToken({
			orgId: ORG,
			customerId: carol,
			cardId: sold.cardId,
		})
		const b = await createShowToken({
			orgId: ORG,
			customerId: carol,
			cardId: sold.cardId,
		})
		await expectCode(redeem(a.token, 100), 'code_invalid')
		expect((await redeem(b.token, 100)).balanceMinor).toBe(3400)
	})
})

describe('orders: giving the card its part back', () => {
	async function redeemForOrder(amountMinor: number, orderId: string) {
		const sold = await sell(5000)
		const db = await getTenantDb(ORG)
		await runTenantTransaction(db, async (tx) => {
			const card = await findGiftCardByCode(tx, sold.code!)
			await redeemGiftCardInTx(tx, {
				card: card!,
				amountMinor,
				sourceType: 'restaurant_order',
				sourceId: orderId,
				channel: 'online',
				locationId: 'loc_a',
				idempotencyKey: `redeem:order:${orderId}`,
				now: Date.now(),
			})
		})
		return { sold, db }
	}

	it('refunds the card first and never more than the redemption took', async () => {
		const orderId = `order-${rid()}`
		const { sold, db } = await redeemForOrder(3000, orderId)
		const first = await runTenantTransaction(db, (tx) =>
			refundGiftShareInTx(tx, {
				orderId,
				wantMinor: 2000,
				key: 'k1',
				reason: 'order refunded',
				now: Date.now(),
			}),
		)
		expect(first).toBe(2000)
		// A replay of the same key returns the same amount and books nothing more.
		expect(
			await runTenantTransaction(db, (tx) =>
				refundGiftShareInTx(tx, {
					orderId,
					wantMinor: 2000,
					key: 'k1',
					reason: 'order refunded',
					now: Date.now(),
				}),
			),
		).toBe(2000)
		// Only 1000 of the redemption is left to give back.
		expect(
			await runTenantTransaction(db, (tx) =>
				refundGiftShareInTx(tx, {
					orderId,
					wantMinor: 5000,
					key: 'k2',
					reason: 'order refunded',
					now: Date.now(),
				}),
			),
		).toBe(1000)
		expect(
			await runTenantTransaction(db, (tx) =>
				refundGiftShareInTx(tx, {
					orderId,
					wantMinor: 5000,
					key: 'k3',
					reason: 'order refunded',
					now: Date.now(),
				}),
			),
		).toBe(0)
		expect(await giftCardBalance(db, sold.cardId)).toBe(5000)
		const share = await giftShareOfOrder(db, orderId)
		expect(share).toMatchObject({
			redeemedMinor: 3000,
			refundedMinor: 3000,
			remainingMinor: 0,
		})
	})

	it('restores the whole part of an order that never completed, once', async () => {
		const orderId = `order-${rid()}`
		const { sold, db } = await redeemForOrder(1800, orderId)
		await runTenantTransaction(db, (tx) =>
			restoreOrderGiftCardsInTx(tx, [orderId], Date.now()),
		)
		await runTenantTransaction(db, (tx) =>
			restoreOrderGiftCardsInTx(tx, [orderId], Date.now()),
		)
		expect(await giftCardBalance(db, sold.cardId)).toBe(5000)
	})

	it('refunds to a voided card without stranding the money', async () => {
		const orderId = `order-${rid()}`
		const { sold, db } = await redeemForOrder(1000, orderId)
		await voidGiftCard({
			orgId: ORG,
			cardId: sold.cardId,
			reason: 'lost',
			actor,
		})
		await runTenantTransaction(db, (tx) =>
			restoreOrderGiftCardsInTx(tx, [orderId], Date.now()),
		)
		expect(await giftCardBalance(db, sold.cardId)).toBe(1000)
	})
})
