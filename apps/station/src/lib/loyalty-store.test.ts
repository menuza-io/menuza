// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerLoyaltyListeners } from './loyalty-hooks.ts'
import {
	chooseReward,
	forgetMember,
	handleCleared,
	handleRewardDropped,
	identifyByCode,
	initialLoyaltyState,
	listenToCart,
	markPlaced,
	pollApproval,
	removeReward,
	RewardRefusal,
	sendApprovalCode,
	sendJoinCode,
	submitApprovalCode,
	useLoyalty,
	verifyJoinCode,
	type Env,
} from './loyalty-store.ts'
import {
	LoyaltyApiError,
	type LoyaltyApi,
	type LoyaltyApproval,
	type LoyaltyMember,
	type LoyaltyReward,
} from './loyalty.ts'
import { type CartLine } from './pricing.ts'
import { usePos } from './store.ts'

const NOW = 1_000_000
const SALE = '8f6e0c52-5b57-4b4e-9f0e-1c2b3d4e5f60'

const REWARD: LoyaltyReward = {
	id: 'rw1',
	version: 2,
	name: 'Free coffee',
	description: null,
	pointsCost: 100,
	kind: 'items',
	currency: 'USD',
}

const MEMBER: LoyaltyMember = {
	binding: 'b'.repeat(32),
	bindingExpiresAt: NOW + 3_600_000,
	firstName: 'Ada',
	unitLabel: 'points',
	balance: { points: 120, reserved: 0, available: 120 },
	rewards: [REWARD],
	redemptionEnabled: true,
	joined: false,
}

const approval = (over: Partial<LoyaltyApproval> = {}): LoyaltyApproval => ({
	id: 'ap1',
	status: 'pending',
	saleId: SALE,
	rewardId: 'rw1',
	rewardVersion: 2,
	rewardName: 'Free coffee',
	pointsCost: 100,
	discountMinor: 500,
	lines: [{ lineId: 'l1', discountMinor: 500, rewardUnits: 1 }],
	redemptionId: null,
	expiresAt: NOW + 900_000,
	otpAvailable: true,
	otpSentAt: null,
	...over,
})

const LINE: Omit<CartLine, 'id'> = {
	itemId: 'latte',
	name: 'Latte',
	variantId: null,
	variantLabel: null,
	quantity: 1,
	baseCents: 500,
	instructions: '',
	options: [],
}

/** The fake region: every call is a spy, answering the happy path unless a test says otherwise. */
function fakeApi() {
	return {
		identify: vi.fn().mockResolvedValue(MEMBER),
		joinSend: vi
			.fn()
			.mockResolvedValue({ sent: true, expiresAt: NOW + 300_000 }),
		joinVerify: vi.fn().mockResolvedValue({ ...MEMBER, joined: true }),
		member: vi.fn().mockResolvedValue(MEMBER),
		revoke: vi.fn().mockResolvedValue({ ok: true }),
		quote: vi.fn().mockResolvedValue({
			quote: {
				rewardId: 'rw1',
				rewardVersion: 2,
				applicable: true,
				code: null,
				discountMinor: 500,
				pointsCost: 100,
				affordable: true,
				targetLineId: null,
			},
			availableAfter: 20,
		}),
		requestApproval: vi.fn().mockResolvedValue(approval()),
		approval: vi.fn().mockResolvedValue(approval()),
		cancelApproval: vi
			.fn()
			.mockResolvedValue(approval({ status: 'cancelled' })),
		sendOtp: vi
			.fn()
			.mockResolvedValue(approval({ otpSentAt: NOW, otpAvailable: true })),
		verifyOtp: vi.fn().mockResolvedValue(approval({ status: 'approved' })),
	}
}

let api: ReturnType<typeof fakeApi>
let env: Env
let online = true

function makeEnv(): Env {
	return {
		api: api as unknown as LoyaltyApi,
		cart: () => {
			const s = usePos.getState()
			return {
				currency: 'USD',
				lines: s.lines,
				adjustments: s.adjustments,
				categoryIdsByItem: new Map([['latte', ['hot']]]),
				activeOrderId: s.activeOrderId,
				online,
				signInRequired: false,
				session: null,
			}
		},
		applyReward: (reward) => usePos.getState().setLoyaltyReward(reward),
		now: () => NOW,
		uuid: () => SALE,
	}
}

/** Lets the fire-and-forget work the cart notices start settle. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
	api = fakeApi()
	env = makeEnv()
	online = true
	useLoyalty.setState(initialLoyaltyState, false)
	registerLoyaltyListeners({})
	usePos.setState({
		lines: [],
		adjustments: [],
		activeOrderId: null,
		location: null,
		snapshot: null,
		categories: [],
	})
	usePos.getState().addLine(LINE)
})

afterEach(() => {
	registerLoyaltyListeners({})
})

const adjustments = () => usePos.getState().adjustments
const loyaltyRows = () => adjustments().filter((row) => row.kind === 'loyalty')

describe('identifying a member', () => {
	it('a member code makes the guest the member for this sale', async () => {
		await identifyByCode(env, 'ABCD-1234')
		expect(api.identify).toHaveBeenCalledWith('ABCD-1234')
		expect(useLoyalty.getState().member?.firstName).toBe('Ada')
	})

	it('a phone number joins them: a code is sent, then read back', async () => {
		await sendJoinCode(env, '+15550100401')
		expect(api.joinSend).toHaveBeenCalledWith('+15550100401')
		// Sending a code identifies no one yet.
		expect(useLoyalty.getState().member).toBeNull()
		await verifyJoinCode(env, '+15550100401', '123456')
		expect(api.joinVerify).toHaveBeenCalledWith('+15550100401', '123456')
		expect(useLoyalty.getState().member?.joined).toBe(true)
	})

	it('a wrong code identifies no one and the error reaches the screen', async () => {
		api.identify.mockRejectedValue(new LoyaltyApiError(404, 'code_invalid'))
		await expect(identifyByCode(env, 'NOPE')).rejects.toMatchObject({
			code: 'code_invalid',
		})
		expect(useLoyalty.getState().member).toBeNull()
		expect(useLoyalty.getState().unavailable).toBe(false)
	})

	it('loyalty being off is remembered, so the cart stops offering it', async () => {
		api.identify.mockRejectedValue(new LoyaltyApiError(403, 'loyalty_disabled'))
		await expect(identifyByCode(env, 'X')).rejects.toBeInstanceOf(
			LoyaltyApiError,
		)
		expect(useLoyalty.getState().unavailable).toBe(true)
		// A later success proves it is on after all.
		api.identify.mockResolvedValue(MEMBER)
		await identifyByCode(env, 'X')
		expect(useLoyalty.getState().unavailable).toBe(false)
	})
})

describe('spending a reward', () => {
	beforeEach(async () => {
		await identifyByCode(env, 'ABCD-1234')
	})

	it('prices the reward on this cart, asks the member, and waits', async () => {
		const result = await chooseReward(env, REWARD)
		expect(result.status).toBe('pending')

		const quoted = api.quote.mock.calls[0]![0]
		expect(quoted.binding).toBe(MEMBER.binding)
		expect(quoted.rewardId).toBe('rw1')
		expect(quoted.cart.lines[0]).toMatchObject({
			itemId: 'latte',
			categoryIds: ['hot'],
			unitMinor: 500,
			discountedMinor: 0,
		})

		const asked = api.requestApproval.mock.calls[0]![0]
		expect(asked).toMatchObject({
			rewardId: 'rw1',
			rewardVersion: 2,
			saleId: SALE,
		})
		expect(asked.idempotencyKey).toBeTruthy()
		expect(useLoyalty.getState().waiting?.approval.id).toBe('ap1')
		// Nothing is taken off until the member approves.
		expect(loyaltyRows()).toHaveLength(0)
	})

	it('puts the reward on the cart when the member approves, split as the region said', async () => {
		await chooseReward(env, REWARD)
		const lineId = usePos.getState().lines[0]!.id
		api.approval.mockResolvedValue(
			approval({
				status: 'approved',
				redemptionId: 'red1',
				lines: [{ lineId, discountMinor: 500, rewardUnits: 1 }],
			}),
		)
		const answer = await pollApproval(env)
		expect(answer?.status).toBe('approved')
		expect(loyaltyRows()).toEqual([
			{
				id: 'loyalty:ap1',
				kind: 'loyalty',
				label: 'Free coffee',
				amountCents: 500,
				lineAmounts: { [lineId]: 500 },
			},
		])
		expect(useLoyalty.getState().applied).toEqual({
			approvalId: 'ap1',
			name: 'Free coffee',
			discountMinor: 500,
		})
		expect(useLoyalty.getState().waiting).toBeNull()
	})

	it('a member who is still deciding keeps the request open', async () => {
		await chooseReward(env, REWARD)
		await pollApproval(env)
		expect(useLoyalty.getState().waiting?.approval.status).toBe('pending')
		expect(loyaltyRows()).toHaveLength(0)
	})

	it('a declined, expired or cancelled request ends, and the next one gets a new sale id', async () => {
		for (const status of ['declined', 'expired', 'cancelled'] as const) {
			await chooseReward(env, REWARD)
			api.approval.mockResolvedValue(approval({ status }))
			await pollApproval(env)
			expect(useLoyalty.getState().waiting).toBeNull()
			expect(useLoyalty.getState().applied).toBeNull()
			expect(useLoyalty.getState().saleId).toBeNull()
			expect(loyaltyRows()).toHaveLength(0)
		}
	})

	it('a one-time code to the member’s phone approves it too', async () => {
		await chooseReward(env, REWARD)
		await sendApprovalCode(env)
		expect(api.sendOtp).toHaveBeenCalledWith('ap1')
		expect(useLoyalty.getState().waiting?.otpSent).toBe(true)
		await submitApprovalCode(env, '123456')
		expect(api.verifyOtp).toHaveBeenCalledWith('ap1', '123456')
		expect(useLoyalty.getState().applied?.approvalId).toBe('ap1')
		expect(loyaltyRows()).toHaveLength(1)
	})

	it('a wrong one-time code leaves the request open for another try', async () => {
		await chooseReward(env, REWARD)
		await sendApprovalCode(env)
		api.verifyOtp.mockRejectedValue(new LoyaltyApiError(422, 'otp_invalid'))
		await expect(submitApprovalCode(env, '000000')).rejects.toMatchObject({
			code: 'otp_invalid',
		})
		expect(useLoyalty.getState().waiting?.approval.id).toBe('ap1')
		expect(loyaltyRows()).toHaveLength(0)
	})

	it('the member can approve in their wallet before the till even polls', async () => {
		api.requestApproval.mockResolvedValue(approval({ status: 'approved' }))
		const result = await chooseReward(env, REWARD)
		expect(result.status).toBe('approved')
		expect(loyaltyRows()).toHaveLength(1)
	})

	it('a tab being added to is approved under its own order id', async () => {
		usePos.setState({ activeOrderId: 'tab-order-id' })
		await chooseReward(env, REWARD)
		expect(api.requestApproval.mock.calls[0]![0].saleId).toBe('tab-order-id')
	})

	it('a withdrawn request is never asked again under the same sale id', async () => {
		let n = 0
		env = { ...makeEnv(), uuid: () => `sale-${++n}` }
		await chooseReward(env, REWARD)
		await chooseReward(env, REWARD)
		const ids = api.requestApproval.mock.calls.map(([call]) => call.saleId)
		// The first request was withdrawn before the second, so the second is a new sale id.
		expect(ids).toHaveLength(2)
		expect(ids[0]).not.toBe(ids[1])
	})

	it('choosing another reward withdraws the first', async () => {
		await chooseReward(env, REWARD)
		await chooseReward(env, { ...REWARD, id: 'rw2' })
		expect(api.cancelApproval).toHaveBeenCalledWith('ap1')
		expect(useLoyalty.getState().waiting).not.toBeNull()
	})

	it('removing the reward gives the points back and takes it off the cart', async () => {
		api.requestApproval.mockResolvedValue(approval({ status: 'approved' }))
		await chooseReward(env, REWARD)
		expect(loyaltyRows()).toHaveLength(1)
		await removeReward(env)
		expect(api.cancelApproval).toHaveBeenCalledWith('ap1')
		expect(loyaltyRows()).toHaveLength(0)
		expect(useLoyalty.getState().applied).toBeNull()
		expect(useLoyalty.getState().saleId).toBeNull()
		// The member is still on the sale: they earn on it.
		expect(useLoyalty.getState().member).not.toBeNull()
	})

	it('removing a reward still works when the region cannot be reached', async () => {
		api.requestApproval.mockResolvedValue(approval({ status: 'approved' }))
		await chooseReward(env, REWARD)
		api.cancelApproval.mockRejectedValue(
			new LoyaltyApiError(0, 'network_unavailable'),
		)
		await removeReward(env)
		expect(loyaltyRows()).toHaveLength(0)
	})
})

describe('when a reward cannot be used', () => {
	beforeEach(async () => {
		await identifyByCode(env, 'ABCD-1234')
	})

	const refused = async (reason: string) => {
		const error = await chooseReward(env, REWARD).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(RewardRefusal)
		expect((error as RewardRefusal).reason).toBe(reason)
	}

	it('offline: spending is never offered, and nothing is sent', async () => {
		online = false
		await refused('offline')
		expect(api.quote).not.toHaveBeenCalled()
		expect(api.requestApproval).not.toHaveBeenCalled()
	})

	it('spending switched off for the restaurant', async () => {
		useLoyalty.setState({ member: { ...MEMBER, redemptionEnabled: false } })
		await refused('spending_off')
		expect(api.quote).not.toHaveBeenCalled()
	})

	it('an empty cart has nothing to take a reward off', async () => {
		usePos.setState({ lines: [] })
		await refused('empty_cart')
	})

	it('a reward that does not apply to these items is not asked for', async () => {
		api.quote.mockResolvedValue({
			quote: {
				rewardId: 'rw1',
				rewardVersion: 2,
				applicable: false,
				code: 'reward_not_applicable',
				discountMinor: 0,
				pointsCost: 100,
				affordable: true,
				targetLineId: null,
			},
			availableAfter: 120,
		})
		await refused('not_applicable')
		expect(api.requestApproval).not.toHaveBeenCalled()
		expect(useLoyalty.getState().quoting).toBeNull()
	})

	it('a reward the member cannot afford is not asked for', async () => {
		api.quote.mockResolvedValue({
			quote: {
				rewardId: 'rw1',
				rewardVersion: 2,
				applicable: true,
				code: 'insufficient_points',
				discountMinor: 500,
				pointsCost: 100,
				affordable: false,
				targetLineId: null,
			},
			availableAfter: -10,
		})
		await refused('not_affordable')
		expect(api.requestApproval).not.toHaveBeenCalled()
	})

	it('a region error leaves nothing half done', async () => {
		api.requestApproval.mockRejectedValue(
			new LoyaltyApiError(409, 'reward_unavailable'),
		)
		await expect(chooseReward(env, REWARD)).rejects.toMatchObject({
			code: 'reward_unavailable',
		})
		expect(useLoyalty.getState().quoting).toBeNull()
		expect(useLoyalty.getState().waiting).toBeNull()
		expect(loyaltyRows()).toHaveLength(0)
	})
})

describe('when the cart changes under an approved reward', () => {
	beforeEach(async () => {
		listenToCart(() => env)
		await identifyByCode(env, 'ABCD-1234')
		api.requestApproval.mockResolvedValue(approval({ status: 'approved' }))
		await chooseReward(env, REWARD)
		expect(loyaltyRows()).toHaveLength(1)
	})

	it('adding an item ends the reward and gives the points back', async () => {
		usePos.getState().addLine({ ...LINE, itemId: 'muffin', name: 'Muffin' })
		await settled()
		expect(loyaltyRows()).toHaveLength(0)
		expect(api.cancelApproval).toHaveBeenCalledWith('ap1')
		expect(useLoyalty.getState().applied).toBeNull()
		expect(useLoyalty.getState().saleId).toBeNull()
		expect(useLoyalty.getState().member).not.toBeNull()
	})

	it('changing a quantity or removing a line ends it too', async () => {
		const id = usePos.getState().lines[0]!.id
		usePos.getState().setQuantity(id, 2)
		await settled()
		expect(api.cancelApproval).toHaveBeenCalledTimes(1)
		expect(loyaltyRows()).toHaveLength(0)
	})

	it("a reward stored on a loaded tab is not this session's to cancel", async () => {
		usePos.setState({ activeOrderId: 'tab1' })
		useLoyalty.setState({ applied: null, saleId: null }, false)
		api.cancelApproval.mockClear()
		// Releasing the tab (as another terminal takes it over) or editing it.
		usePos.getState().releaseTab()
		await settled()
		expect(api.cancelApproval).not.toHaveBeenCalled()
		await handleRewardDropped(env, 'ap1')
		expect(api.cancelApproval).not.toHaveBeenCalled()
	})

	it('a cart change with no reward on it cancels nothing', async () => {
		await removeReward(env)
		api.cancelApproval.mockClear()
		usePos.getState().addLine({ ...LINE, itemId: 'muffin', name: 'Muffin' })
		await settled()
		expect(api.cancelApproval).not.toHaveBeenCalled()
	})
})

describe('when the sale ends', () => {
	beforeEach(async () => {
		listenToCart(() => env)
		await identifyByCode(env, 'ABCD-1234')
	})

	it('a sold order keeps its reward and forgets the member', async () => {
		api.requestApproval.mockResolvedValue(approval({ status: 'approved' }))
		await chooseReward(env, REWARD)
		markPlaced()
		usePos.getState().clearOrder()
		await settled()
		// The order carries the reward now: the region settles it from the upload.
		expect(api.cancelApproval).not.toHaveBeenCalled()
		expect(api.revoke).toHaveBeenCalledWith(MEMBER.binding)
		expect(useLoyalty.getState().member).toBeNull()
		expect(useLoyalty.getState().applied).toBeNull()
		expect(useLoyalty.getState().placed).toBe(false)
	})

	it('an order thrown away gives the reward back', async () => {
		api.requestApproval.mockResolvedValue(approval({ status: 'approved' }))
		await chooseReward(env, REWARD)
		usePos.getState().clearOrder()
		await settled()
		expect(api.cancelApproval).toHaveBeenCalledWith('ap1')
		expect(api.revoke).toHaveBeenCalledWith(MEMBER.binding)
		expect(useLoyalty.getState().member).toBeNull()
	})

	it('a request still waiting for the member is withdrawn too', async () => {
		await chooseReward(env, REWARD)
		usePos.getState().clearOrder()
		await settled()
		expect(api.cancelApproval).toHaveBeenCalledWith('ap1')
		expect(useLoyalty.getState().waiting).toBeNull()
	})

	it('a member with no reward is simply forgotten, and the next sale starts clean', async () => {
		markPlaced()
		usePos.getState().clearOrder()
		await settled()
		expect(api.cancelApproval).not.toHaveBeenCalled()
		expect(api.revoke).toHaveBeenCalledTimes(1)
		expect(useLoyalty.getState()).toMatchObject({
			member: null,
			saleId: null,
			applied: null,
			waiting: null,
			placed: false,
		})
	})

	it('what was learnt about the restaurant outlives the sale', async () => {
		useLoyalty.setState({ unavailable: true })
		await handleCleared(env)
		expect(useLoyalty.getState().unavailable).toBe(true)
	})

	it('"not them" gives back the reward and forgets the binding', async () => {
		api.requestApproval.mockResolvedValue(approval({ status: 'approved' }))
		await chooseReward(env, REWARD)
		await forgetMember(env)
		expect(api.cancelApproval).toHaveBeenCalledWith('ap1')
		expect(api.revoke).toHaveBeenCalledWith(MEMBER.binding)
		expect(loyaltyRows()).toHaveLength(0)
		expect(useLoyalty.getState().member).toBeNull()
	})

	it('forgetting a member still works when the region cannot be reached', async () => {
		api.revoke.mockRejectedValue(new LoyaltyApiError(0, 'network_unavailable'))
		await expect(forgetMember(env)).resolves.toBeUndefined()
		expect(useLoyalty.getState().member).toBeNull()
	})
})

describe('the member is held in memory only', () => {
	it('nothing about the member is written to storage', async () => {
		const setItem = vi.spyOn(Storage.prototype, 'setItem')
		await identifyByCode(env, 'ABCD-1234')
		await sendJoinCode(env, '+15550100401')
		expect(setItem).not.toHaveBeenCalled()
		if (typeof localStorage !== 'undefined') {
			const stored = Object.keys(localStorage)
				.map((key) => `${key}=${localStorage.getItem(key) ?? ''}`)
				.join('\n')
			expect(stored).not.toContain(MEMBER.binding)
		}
		setItem.mockRestore()
	})
})
