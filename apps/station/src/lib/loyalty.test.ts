import {
	POS_STAFF_SESSION_HEADER,
	posAdjustmentSchema,
	posOrderLoyaltySchema,
} from '@repo/common/pos-orders'
import { describe, expect, it, vi } from 'vitest'
import { loadSettings, type PosSettings } from './config.ts'
import {
	approvalIdOf,
	bindingUsable,
	BINDING_SKEW_MS,
	buildLoyaltyCart,
	createLoyaltyApi,
	foldCodeInput,
	foldPhoneInput,
	LoyaltyApiError,
	nextReward,
	plausiblePhone,
	rewardAdjustment,
	saleLoyalty,
	spendingAllowed,
	toWireLoyalty,
	type LoyaltyApproval,
	type LoyaltyReward,
} from './loyalty.ts'
import { type Adjustment, type CartLine } from './pricing.ts'
import { type Session } from './signin.ts'

const settings = (over: Partial<PosSettings> = {}): PosSettings => ({
	...loadSettings(),
	tenantApiUrl: 'https://api.example.com/',
	deviceToken: 'pdv1.secret',
	...over,
})

const line = (over: Partial<CartLine> = {}): CartLine => ({
	id: 'l1',
	itemId: 'latte',
	name: 'Latte',
	variantId: null,
	variantLabel: null,
	quantity: 1,
	baseCents: 500,
	instructions: '',
	options: [],
	...over,
})

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})

const MEMBER = {
	binding: 'b'.repeat(32),
	bindingExpiresAt: 2_000_000,
	firstName: 'Ada',
	unitLabel: 'points',
	balance: { points: 120, reserved: 0, available: 120 },
}

const REWARD = {
	id: 'rw1',
	version: 2,
	name: 'Free coffee',
	description: null,
	pointsCost: 100,
	kind: 'items',
	discount: null,
	itemIds: ['latte'],
	categoryIds: [],
	freeItemId: 'latte',
	labels: { items: {}, categories: {} },
	currency: 'USD',
}

function api(
	fetchImpl: typeof fetch,
	session: Session | null = null,
	over = {},
) {
	return createLoyaltyApi(
		{ settings: () => settings(over), session: () => session },
		fetchImpl,
	)
}

/** What a call that must be refused rejects with. */
async function rejection(promise: Promise<unknown>): Promise<LoyaltyApiError> {
	try {
		await promise
	} catch (error) {
		return error as LoyaltyApiError
	}
	throw new Error('expected the call to be refused')
}

const calls = (fn: ReturnType<typeof vi.fn>) =>
	fn.mock.calls.map(([url, init]) => ({
		url: String(url),
		init: init as RequestInit,
		headers: init.headers as Record<string, string>,
		body: init.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
	}))

describe('the loyalty client', () => {
	it('identifies a member by code with the device secret and nothing else', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				json({ member: MEMBER, rewards: [REWARD], redemptionEnabled: true }),
			)
		const member = await api(fetchImpl as never).identify(' ABCD-1234 ')
		const [call] = calls(fetchImpl)
		expect(call!.url).toBe('https://api.example.com/pos/loyalty/identify')
		expect(call!.init.method).toBe('POST')
		expect(call!.init.credentials).toBe('omit')
		expect(call!.headers.Authorization).toBe('Bearer pdv1.secret')
		expect(call!.headers[POS_STAFF_SESSION_HEADER]).toBeUndefined()
		expect(call!.body).toEqual({ code: 'ABCD-1234' })
		expect(member.firstName).toBe('Ada')
		expect(member.rewards).toHaveLength(1)
		expect(member.redemptionEnabled).toBe(true)
		expect(member.joined).toBe(false)
	})

	it('sends the signed-in person’s server session when it has one', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(json({ sent: true, expiresAt: 5 }))
		const session: Session = {
			staff: { id: 's1', name: 'Sam' },
			role: 'cashier',
			mode: 'online',
			at: 1,
			serverSession: { token: 'session-token-xxxxxxxxxxxx', expiresAt: 9 },
		}
		await api(fetchImpl as never, session).joinSend(' +15550100401 ')
		const [call] = calls(fetchImpl)
		expect(call!.url).toBe('https://api.example.com/pos/loyalty/join/send')
		expect(call!.headers[POS_STAFF_SESSION_HEADER]).toBe(
			'session-token-xxxxxxxxxxxx',
		)
		expect(call!.body).toEqual({ phone: '+15550100401' })
	})

	it('a join verify tells the till whether the account was just opened', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			json({
				member: MEMBER,
				rewards: [],
				redemptionEnabled: false,
				joined: true,
			}),
		)
		const member = await api(fetchImpl as never).joinVerify(
			'+15550100401',
			'123456',
		)
		expect(calls(fetchImpl)[0]!.body).toEqual({
			phone: '+15550100401',
			code: '123456',
		})
		expect(member.joined).toBe(true)
		expect(member.redemptionEnabled).toBe(false)
	})

	it('reads a held member with the binding header, not the query string', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				json({ member: MEMBER, rewards: [], redemptionEnabled: true }),
			)
		await api(fetchImpl as never).member(MEMBER.binding)
		const [call] = calls(fetchImpl)
		expect(call!.url).toBe('https://api.example.com/pos/loyalty/member')
		expect(call!.headers['X-Loyalty-Binding']).toBe(MEMBER.binding)
		expect(call!.init.body).toBeUndefined()
	})

	it('an approval request carries an idempotency key; cancelling does not need one', async () => {
		const approval = {
			id: 'ap1',
			status: 'pending',
			saleId: '8f6e0c52-5b57-4b4e-9f0e-1c2b3d4e5f60',
			rewardId: 'rw1',
			rewardVersion: 2,
			rewardName: 'Free coffee',
			pointsCost: 100,
			discountMinor: 500,
			lines: [{ lineId: 'l1', discountMinor: 500, rewardUnits: 1 }],
			cartHash: 'h',
			redemptionId: null,
			expiresAt: 10,
			otpAvailable: true,
			otpSentAt: null,
		}
		const fetchImpl = vi.fn().mockImplementation(() => json({ approval }, 201))
		const client = api(fetchImpl as never)
		await client.requestApproval({
			binding: MEMBER.binding,
			rewardId: 'rw1',
			rewardVersion: 2,
			saleId: approval.saleId,
			cart: { currency: 'USD', lines: [] },
		})
		await client.cancelApproval('ap1')
		const [request, cancel] = calls(fetchImpl)
		expect(request!.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
		expect(request!.url).toContain('/pos/loyalty/approvals')
		expect(cancel!.url).toBe(
			'https://api.example.com/pos/loyalty/approvals/ap1/cancel',
		)
		expect(cancel!.headers['Idempotency-Key']).toBeUndefined()
	})

	it('drops a reward it cannot read instead of failing the answer', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			json({
				member: MEMBER,
				rewards: [
					REWARD,
					{ id: 'broken' },
					{ ...REWARD, id: 'rw2', kind: 'future' },
				],
				redemptionEnabled: true,
			}),
		)
		const member = await api(fetchImpl as never).identify('x')
		expect(member.rewards.map((r) => r.id)).toEqual(['rw1', 'rw2'])
	})

	it('maps the region’s refusals to codes the screens can act on', async () => {
		const refuse = async (
			status: number,
			body: unknown,
		): Promise<LoyaltyApiError> => {
			const fetchImpl = vi.fn().mockResolvedValue(json(body, status))
			try {
				await api(fetchImpl as never).identify('x')
			} catch (error) {
				return error as LoyaltyApiError
			}
			throw new Error('expected the call to be refused')
		}
		const unknown = await refuse(404, {
			error: 'code_invalid',
			code: 'code_invalid',
		})
		expect(unknown).toBeInstanceOf(LoyaltyApiError)
		expect(unknown.code).toBe('code_invalid')

		expect((await refuse(403, { error: 'loyalty_disabled' })).unavailable).toBe(
			true,
		)
		expect(
			(await refuse(503, { error: 'loyalty_unavailable' })).unavailable,
		).toBe(true)
		expect((await refuse(409, { error: 'program_inactive' })).unavailable).toBe(
			true,
		)
		expect(
			(await refuse(403, { error: 'redemption_disabled' })).redemptionOff,
		).toBe(true)
		expect(
			(await refuse(403, { error: 'staff_session_required' })).needsSignIn,
		).toBe(true)
		expect((await refuse(401, { error: 'invalid_device' })).deviceProblem).toBe(
			true,
		)
		const limited = await refuse(429, {
			error: 'rate_limited',
			retryAfterSeconds: 42,
		})
		expect(limited.rateLimited).toBe(true)
		expect(limited.retryAfterSeconds).toBe(42)
		// An answer that says nothing keeps the status.
		expect((await refuse(502, {})).code).toBe('http_502')
	})

	it('no answer is offline, and a 200 that is not the region’s is not trusted', async () => {
		const down = vi.fn().mockRejectedValue(new TypeError('failed to fetch'))
		const offline = await rejection(api(down as never).identify('x'))
		expect(offline.offline).toBe(true)

		const portal = vi
			.fn()
			.mockResolvedValue(new Response('<html>log in</html>'))
		const bad = await rejection(api(portal as never).identify('x'))
		expect(bad.code).toBe('malformed_response')

		const odd = vi.fn().mockResolvedValue(json({ member: { nope: true } }))
		const malformed = await rejection(api(odd as never).identify('x'))
		expect(malformed.status).toBe(502)
	})

	it('an unpaired terminal never calls out', async () => {
		const fetchImpl = vi.fn()
		const error = await rejection(
			api(fetchImpl as never, null, { deviceToken: null }).identify('x'),
		)
		expect(error.deviceProblem).toBe(true)
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('puts no phone number, code or binding in an error', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(json({ error: 'otp_invalid' }, 422))
		const error = await rejection(
			api(fetchImpl as never).joinVerify('+15550100401', '654321'),
		)
		expect(JSON.stringify([error.message, error.code])).not.toMatch(
			/5550100401|654321/,
		)
	})
})

describe('the cart the region prices a reward against', () => {
	const byItem = new Map([
		['latte', ['hot']],
		['muffin', ['bakery', 'sweet']],
	])

	it('carries ids, categories, prices and what discounts already took', () => {
		const cart = buildLoyaltyCart({
			currency: 'USD',
			lines: [
				line({ id: 'l1', quantity: 2, options: [] }),
				line({
					id: 'l2',
					itemId: 'muffin',
					variantId: 'big',
					baseCents: 300,
					options: [
						{
							groupId: 'g',
							groupName: 'Extras',
							optionId: 'o',
							optionName: 'Jam',
							quantity: 1,
							unitCents: 50,
							taxable: true,
						},
					],
				}),
			],
			adjustments: [],
			categoryIdsByItem: byItem,
		})
		expect(cart).toEqual({
			currency: 'USD',
			lines: [
				{
					lineId: 'l1',
					itemId: 'latte',
					variantId: null,
					categoryIds: ['hot'],
					quantity: 2,
					unitBaseMinor: 500,
					unitMinor: 500,
					discountedMinor: 0,
				},
				{
					lineId: 'l2',
					itemId: 'muffin',
					variantId: 'big',
					categoryIds: ['bakery', 'sweet'],
					quantity: 1,
					unitBaseMinor: 300,
					unitMinor: 350,
					discountedMinor: 0,
				},
			],
		})
	})

	it('a discount that names its lines comes off those lines, capped at what they cost', () => {
		const discount: Adjustment = {
			id: 'auto:d1',
			kind: 'discount',
			label: '10% lattes',
			amountCents: 500,
			lineAmounts: { l1: 9_999 },
		}
		const cart = buildLoyaltyCart({
			currency: 'USD',
			lines: [
				line({ id: 'l1' }),
				line({ id: 'l2', itemId: 'muffin', baseCents: 300 }),
			],
			adjustments: [discount],
			categoryIdsByItem: byItem,
		})
		// The line cost 500, so it loses 500; nothing is left over to spread.
		expect(cart.lines.map((l) => l.discountedMinor)).toEqual([500, 0])
	})

	it('what no line claims is spread over what is left, in proportion, by largest remainder', () => {
		const cart = buildLoyaltyCart({
			currency: 'USD',
			lines: [
				line({ id: 'l1', baseCents: 100 }),
				line({ id: 'l2', baseCents: 100 }),
				line({ id: 'l3', baseCents: 100 }),
			],
			adjustments: [
				{ id: 'manual:m1', kind: 'discount', label: 'Staff', amountCents: 100 },
			],
			categoryIdsByItem: byItem,
		})
		expect(cart.lines.map((l) => l.discountedMinor)).toEqual([34, 33, 33])
	})

	it('a loyalty row is never a discount under itself', () => {
		const cart = buildLoyaltyCart({
			currency: 'USD',
			lines: [line()],
			adjustments: [
				{
					id: 'loyalty:ap1',
					kind: 'loyalty',
					label: 'Free coffee',
					amountCents: 500,
					lineAmounts: { l1: 500 },
				},
			],
			categoryIdsByItem: byItem,
		})
		expect(cart.lines[0]!.discountedMinor).toBe(0)
	})
})

describe('the reward on the sale', () => {
	const approval: LoyaltyApproval = {
		id: 'ap1',
		status: 'approved',
		saleId: 's',
		rewardId: 'rw1',
		rewardVersion: 2,
		rewardName: 'Free coffee',
		pointsCost: 100,
		discountMinor: 500,
		lines: [
			{ lineId: 'l1', discountMinor: 500, rewardUnits: 1 },
			{ lineId: 'l2', discountMinor: 0, rewardUnits: 0 },
		],
		redemptionId: 'red1',
		expiresAt: 10,
		otpAvailable: true,
		otpSentAt: null,
	}

	it('is a loyalty adjustment the server accepts, split over the lines it took from', () => {
		const row = rewardAdjustment(approval)
		expect(row).toEqual({
			id: 'loyalty:ap1',
			kind: 'loyalty',
			label: 'Free coffee',
			amountCents: 500,
			lineAmounts: { l1: 500 },
		})
		expect(posAdjustmentSchema.safeParse(row).success).toBe(true)
		expect(approvalIdOf(row)).toBe('ap1')
		expect(approvalIdOf({ id: 'auto:x' })).toBeNull()
	})

	it('carries no line split when the approval gave none', () => {
		const row = rewardAdjustment({ ...approval, lines: [] })
		expect(row.lineAmounts).toBeUndefined()
	})
})

describe('what the sale carries so the member earns', () => {
	const lines = [line({ id: 'l1' }), line({ id: 'l2', itemId: 'muffin' })]
	const byItem = new Map([['muffin', ['bakery']]])

	it('is the binding and each line’s categories, never a phone number', () => {
		const loyalty = saleLoyalty({
			binding: 'bind',
			lines,
			categoryIdsByItem: byItem,
		})
		expect(loyalty).toEqual({
			binding: 'bind',
			categories: { l1: [], l2: ['bakery'] },
		})
		const wire = toWireLoyalty(loyalty, lines)
		expect(wire).toEqual({
			binding: 'bind',
			lines: [
				{ id: 'l1', categoryIds: [] },
				{ id: 'l2', categoryIds: ['bakery'] },
			],
		})
		// The shape the server reads (contract 5).
		expect(posOrderLoyaltySchema.parse(wire)).toEqual(wire)
		expect(JSON.stringify(wire)).not.toMatch(/\+?\d{7,}/)
	})

	it('a sale with no member sends nothing', () => {
		expect(toWireLoyalty(null, lines)).toBeNull()
		expect(toWireLoyalty(undefined, lines)).toBeNull()
	})

	it('only the lines still on the sale go up', () => {
		const loyalty = saleLoyalty({
			binding: 'b',
			lines,
			categoryIdsByItem: byItem,
		})
		expect(toWireLoyalty(loyalty, [lines[1]!])!.lines).toEqual([
			{ id: 'l2', categoryIds: ['bakery'] },
		])
	})
})

describe('when spending is offered', () => {
	const NOW = 1_000_000
	const member = { redemptionEnabled: true, bindingExpiresAt: NOW + 3_600_000 }
	const online = {
		online: true,
		signInRequired: false,
		session: null,
		now: NOW,
	}

	it('needs a member', () => {
		expect(spendingAllowed({ ...online, member: null })).toEqual({
			ok: false,
			reason: 'no_member',
		})
	})

	it('is never offered offline: earning needs only the held binding', () => {
		expect(spendingAllowed({ ...online, online: false, member })).toEqual({
			ok: false,
			reason: 'offline',
		})
		expect(bindingUsable(member, NOW)).toBe(true)
	})

	it('is refused when spending is switched off', () => {
		expect(
			spendingAllowed({
				...online,
				member: { ...member, redemptionEnabled: false },
			}),
		).toEqual({ ok: false, reason: 'spending_off' })
	})

	it('a binding is good for a little longer than its expiry, for a till clock that runs fast', () => {
		const expired = { ...member, bindingExpiresAt: NOW - 1_000 }
		expect(bindingUsable(expired, NOW)).toBe(true)
		expect(
			bindingUsable({ bindingExpiresAt: NOW - BINDING_SKEW_MS - 1 }, NOW),
		).toBe(false)
		expect(
			spendingAllowed({
				...online,
				member: { ...member, bindingExpiresAt: NOW - BINDING_SKEW_MS - 1 },
			}),
		).toEqual({ ok: false, reason: 'binding_expired' })
	})

	it('a terminal that requires sign-in needs the person’s server session', () => {
		const offlineSignIn: Pick<Session, 'serverSession'> = {}
		expect(
			spendingAllowed({
				...online,
				member,
				signInRequired: true,
				session: offlineSignIn,
			}),
		).toEqual({ ok: false, reason: 'sign_in_again' })
		expect(
			spendingAllowed({
				...online,
				member,
				signInRequired: true,
				session: { serverSession: { token: 't', expiresAt: 1 } },
			}),
		).toEqual({ ok: true })
		expect(spendingAllowed({ ...online, member })).toEqual({ ok: true })
	})
})

describe('progress and typing helpers', () => {
	const reward = (id: string, pointsCost: number): LoyaltyReward => ({
		id,
		version: 1,
		name: id,
		description: null,
		pointsCost,
		kind: 'order',
		currency: 'USD',
	})

	it('the next reward is the cheapest one not yet affordable', () => {
		const rewards = [
			reward('big', 500),
			reward('small', 100),
			reward('mid', 250),
		]
		expect(nextReward(rewards, 120)).toEqual({
			reward: rewards[2],
			needed: 130,
			progress: 120 / 250,
		})
		expect(nextReward(rewards, 0)!.reward.id).toBe('small')
		expect(nextReward(rewards, 500)).toBeNull()
		expect(nextReward(rewards, -40)!.progress).toBe(0)
	})

	it('folds Arabic-Indic digits and drops spaces and dashes', () => {
		expect(foldPhoneInput('+٩٦٦ ٥٠-١٢٣ ٤٥٦٧')).toBe('+966501234567')
		expect(foldPhoneInput('(555) 010-0401')).toBe('5550100401')
		expect(foldCodeInput(' ١٢٣ ٤٥٦ ')).toBe('123456')
		expect(plausiblePhone('+1 555 010 0401')).toBe(true)
		expect(plausiblePhone('12345')).toBe(false)
		expect(plausiblePhone('abc')).toBe(false)
	})
})
