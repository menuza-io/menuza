import {
	LOYALTY_ERROR_CODES,
	loyaltyPublicRewardSchema,
	type LoyaltyPublicReward,
} from '@repo/loyalty'
import {
	approvalDetail,
	channelLabel,
	describeEarning,
	describeReward,
	formatCountdown,
	formatDelta,
	formatEntryDate,
	formatMinor,
	formatPoints,
	isolateLtr,
	isolateName,
	progressPercent,
	spellCode,
	historyEntryLabel,
} from './format'
import { LOYALTY_ERROR_LABELS, loyaltyErrorLabelKey } from './labels'
import { type LoyaltyClientErrorCode } from './loyalty-client'
import { testApproval, testEntry, testProgram } from '@/test/loyalty/fixtures'
import { catalogI18n, testI18n } from '@/test/loyalty/i18n'

const i18n = testI18n('en')

function testReward(
	overrides: Partial<LoyaltyPublicReward> = {},
): LoyaltyPublicReward {
	const base = testProgram().rewards[0]
	if (!base) throw new Error('fixture program has no rewards')
	return loyaltyPublicRewardSchema.parse({ ...base, ...overrides })
}

describe('points', () => {
	it('uses the program unit, with a singular for exactly one', () => {
		expect(formatPoints(1, 'points', i18n)).toBe('1 point')
		expect(formatPoints(1200, 'points', i18n)).toBe('1,200 points')
		expect(formatPoints(0, 'stars', i18n)).toBe('0 stars')
		expect(formatPoints(1, 'stars', i18n)).toBe('1 star')
		expect(formatPoints(-30, 'points', i18n)).toBe('-30 points')
	})

	it('keeps Western digits in Arabic', () => {
		const text = formatPoints(1200, 'points', testI18n('ar'))
		expect(text).not.toMatch(/[٠-٩]/)
		expect(text).toMatch(/^1\D?200 points$/)
	})

	it('signs history changes with a real minus sign', () => {
		expect(formatDelta(12, 'points', i18n)).toBe('+12 points')
		expect(formatDelta(-1, 'stars', i18n)).toBe('−1 star')
	})

	it('uses the Arabic form for each count, with a number wherever a sign is', () => {
		const ar = catalogI18n('ar')
		expect(formatPoints(1, 'points', ar)).toBe('نقطة واحدة')
		expect(formatPoints(2, 'points', ar)).toBe('نقطتان')
		expect(formatPoints(3, 'points', ar)).toBe('3 نقاط')
		expect(formatPoints(11, 'points', ar)).toBe('11 نقطة')
		expect(formatPoints(100, 'points', ar)).toBe('100 نقطة')
		expect(formatPoints(2, 'stars', ar)).toBe('نجمتان')
		expect(formatPoints(5, 'stars', ar)).toBe('5 نجوم')
		expect(formatPoints(-2, 'points', ar)).toBe('‎-2 نقطة')
		expect(formatDelta(2, 'points', ar)).toBe('+2 نقطة')
		expect(formatDelta(-1, 'points', ar)).toBe('−1 نقطة')
	})

	it('measures progress with integer math, from 0 to 100', () => {
		expect(progressPercent(150, 400)).toBe(37)
		expect(progressPercent(-20, 400)).toBe(0)
		expect(progressPercent(900, 400)).toBe(100)
		expect(progressPercent(5, 0)).toBe(100)
		// 57 / 100 * 100 is 56.99… in floating point; the website showed 56%.
		expect(progressPercent(57, 100)).toBe(57)
		expect(progressPercent(1, 3)).toBe(33)
	})
})

describe('rewards', () => {
	it('describes a fixed amount off the whole order', () => {
		const reward = testReward({
			name: 'Five off',
			discount: { type: 'fixed', amountMinor: 500 },
		})
		expect(describeReward(reward, i18n)).toEqual({
			value: '$5.00 off',
			scope: 'Applies to your whole order',
			cap: null,
		})
	})

	it('describes a percentage with or without a cap', () => {
		expect(
			describeReward(
				testReward({
					discount: { type: 'percent', percentBp: 1500, maxDiscountMinor: 300 },
				}),
				i18n,
			),
		).toEqual({
			value: '15% off',
			scope: 'Applies to your whole order',
			cap: 'Up to $3.00 off',
		})
		expect(
			describeReward(
				testReward({
					discount: {
						type: 'percent',
						percentBp: 1250,
						maxDiscountMinor: null,
					},
				}),
				i18n,
			),
		).toMatchObject({ value: '12.5% off', cap: null })
	})

	it('names a free item, or stays generic without its name', () => {
		const reward = testReward({
			kind: 'free_item',
			discount: null,
			freeItemId: 'itm_latte',
			labels: { items: { itm_latte: 'Latte' }, categories: {} },
		})
		expect(describeReward(reward, i18n)).toEqual({
			value: 'Free Latte',
			scope: 'One item. Paid extras are still charged.',
			cap: null,
		})
		expect(
			describeReward({ ...reward, labels: { items: {}, categories: {} } }, i18n)
				.value,
		).toBe('A free item')
	})

	it('lists the items or categories covered, and never a partial list', () => {
		const items = testReward({
			kind: 'items',
			itemIds: ['a', 'b'],
			labels: { items: { a: 'Latte', b: 'Mocha' }, categories: {} },
		})
		expect(describeReward(items, i18n).scope).toBe('Applies to Latte and Mocha')
		expect(
			describeReward(
				{ ...items, labels: { items: { a: 'Latte' }, categories: {} } },
				i18n,
			).scope,
		).toBe('Applies to selected items')
		const categories = testReward({
			kind: 'categories',
			categoryIds: ['c'],
			labels: { items: {}, categories: { c: 'Pastries' } },
		})
		expect(describeReward(categories, i18n).scope).toBe('Applies to Pastries')
	})

	it("uses each currency's own minor unit", () => {
		expect(
			describeReward(
				testReward({
					currency: 'JPY',
					discount: { type: 'fixed', amountMinor: 500 },
				}),
				i18n,
			).value,
		).toBe('¥500 off')
		expect(
			describeReward(
				testReward({
					currency: 'KWD',
					discount: { type: 'fixed', amountMinor: 1500 },
				}),
				i18n,
			).value,
		).toContain('1.500')
		expect(formatMinor(1500, 'KWD', 'en')).toContain('1.500')
	})
})

describe('earning', () => {
	it('describes spend earning and what does not count', () => {
		const program = testProgram({
			earning: { method: 'spend', points: 1, perMinor: 100 },
			minimumSpendMinor: 0,
		})
		expect(describeEarning(program, i18n)).toEqual([
			'1 point for every $1.00 you spend',
			'Tax, tips and delivery fees do not count toward earning.',
		])
	})

	it('describes visit, item and category earning', () => {
		expect(
			describeEarning(
				testProgram({
					earning: { method: 'visit', points: 10 },
					minimumSpendMinor: 0,
				}),
				i18n,
			),
		).toEqual(['10 points for each visit (once a day)'])
		expect(
			describeEarning(
				testProgram({
					earning: { method: 'items', points: 5, itemIds: ['a'] },
					minimumSpendMinor: 0,
					labels: { items: { a: 'Latte' }, categories: {} },
				}),
				i18n,
			),
		).toEqual(['5 points for each Latte'])
		expect(
			describeEarning(
				testProgram({
					earning: { method: 'categories', points: 2, categoryIds: ['c'] },
					minimumSpendMinor: 0,
				}),
				i18n,
			),
		).toEqual(['2 points for each item from eligible categories'])
	})

	it('adds the minimum spend', () => {
		expect(
			describeEarning(
				testProgram({
					earning: { method: 'visit', points: 10 },
					minimumSpendMinor: 1000,
				}),
				i18n,
			),
		).toEqual([
			'10 points for each visit (once a day)',
			'Purchases of at least $10.00 qualify.',
			'Tax, tips and delivery fees do not count toward earning.',
		])
	})
})

describe('history', () => {
	it('names every entry type and channel', () => {
		expect(historyEntryLabel(testEntry({ type: 'earn' }), i18n)).toBe('Earned')
		expect(
			historyEntryLabel(testEntry({ type: 'earn_reversal', delta: -12 }), i18n),
		).toBe('Refund adjustment')
		expect(
			historyEntryLabel(
				testEntry({ type: 'redeem', delta: -100, rewardName: 'Free coffee' }),
				i18n,
			),
		).toBe('Redeemed ⁨Free coffee⁩')
		expect(
			historyEntryLabel(testEntry({ type: 'redeem', delta: -100 }), i18n),
		).toBe('Redeemed a reward')
		expect(
			historyEntryLabel(
				testEntry({ type: 'redeem_restore', delta: 100 }),
				i18n,
			),
		).toBe('Reward returned')
		expect(
			historyEntryLabel(
				testEntry({ type: 'adjust', reason: 'goodwill' }),
				i18n,
			),
		).toBe('Adjusted by staff')
		expect(channelLabel('web', i18n)).toBe('Online')
		expect(channelLabel('pos', i18n)).toBe('In store')
		expect(channelLabel('qr', i18n)).toBe('Table order')
		expect(channelLabel('native', i18n)).toBe('App')
		expect(channelLabel(null, i18n)).toBeNull()
	})

	it('formats dates in the customer locale with Western digits', () => {
		const at = Date.UTC(2030, 0, 15, 12)
		expect(formatEntryDate(at, 'en', 'date')).toBe('Jan 15, 2030')
		expect(formatEntryDate(at, 'ar')).not.toMatch(/[٠-٩]/)
	})
})

describe('member codes and till requests', () => {
	it('spells a member code one character at a time', () => {
		expect(spellCode('ABCD-EFGH')).toBe('A B C D, E F G H')
	})

	it('counts down in minutes and seconds, never below zero', () => {
		expect(formatCountdown(300_000)).toBe('5:00')
		expect(formatCountdown(299_001)).toBe('5:00')
		expect(formatCountdown(61_000)).toBe('1:01')
		expect(formatCountdown(-5)).toBe('0:00')
	})

	it('describes what a till request spends', () => {
		expect(approvalDetail(testApproval(), 'points', i18n)).toBe(
			'Spends 100 points for $5.00 off',
		)
	})

	it('isolates typed names and numbers in their own direction', () => {
		expect(isolateName('$20 off')).toBe('⁨$20 off⁩')
		expect(isolateLtr('4:05')).toBe('⁦4:05⁩')
	})
})

describe('errors', () => {
	it('maps failures to messages and falls back to a generic one', () => {
		expect(loyaltyErrorLabelKey('network')).toBe('errorNetwork')
		expect(loyaltyErrorLabelKey('redemption_disabled')).toBe('redemptionPaused')
		expect(loyaltyErrorLabelKey('approval_not_found')).toBe('approvalClosed')
		expect(loyaltyErrorLabelKey('organization_mismatch')).toBe('errorWrongSite')
		expect(loyaltyErrorLabelKey('stale_version')).toBe('errorGeneric')
	})

	it('has a message for every code', () => {
		const codes: LoyaltyClientErrorCode[] = [
			...LOYALTY_ERROR_CODES,
			'signed_out',
			'organization_mismatch',
			'organization_not_found',
			'network',
			'invalid_response',
			'unknown',
		]
		expect(codes.filter((code) => !LOYALTY_ERROR_LABELS[code])).toEqual([])
	})
})
