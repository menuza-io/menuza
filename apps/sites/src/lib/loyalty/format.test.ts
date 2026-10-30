import { LOYALTY_ERROR_CODES } from '@repo/loyalty'
import { describe, expect, it } from 'vitest'
import { type LoyaltyClientErrorCode } from '../loyalty-client.ts'
import {
	approvalDetail,
	channelLabel,
	describeEarning,
	describeReward,
	formatCountdown,
	formatDelta,
	formatEntryDate,
	formatPoints,
	historyEntryLabel,
	loyaltyErrorLabelKey,
	progressPercent,
	spellCode,
} from './format.ts'
import {
	testApproval,
	testEntry,
	testProgram,
	testReward,
} from './test-fixtures.ts'
import { catalogLoyaltyLabels, testLoyaltyLabels } from './test-labels.ts'

const labels = testLoyaltyLabels()

describe('points', () => {
	it('uses the program unit, with a singular for exactly one', () => {
		expect(formatPoints(1, 'points', labels, 'en')).toBe('1 point')
		expect(formatPoints(1200, 'points', labels, 'en')).toBe('1,200 points')
		expect(formatPoints(0, 'stars', labels, 'en')).toBe('0 stars')
		expect(formatPoints(1, 'stars', labels, 'en')).toBe('1 star')
		expect(formatPoints(-30, 'points', labels, 'en')).toBe('-30 points')
	})

	it('keeps Western digits in Arabic', () => {
		const text = formatPoints(1200, 'points', labels, 'ar')
		expect(text).not.toMatch(/[\u0660-\u0669]/)
		expect(text).toMatch(/^1\D?200 points$/)
	})

	it('signs history changes with a real minus sign', () => {
		expect(formatDelta(12, 'points', labels, 'en')).toBe('+12 points')
		expect(formatDelta(-1, 'stars', labels, 'en')).toBe('\u22121 star')
	})

	it('uses the Arabic form for each count, with a number wherever a sign is', () => {
		const ar = catalogLoyaltyLabels('ar')
		expect(formatPoints(1, 'points', ar, 'ar')).toBe('نقطة واحدة')
		expect(formatPoints(2, 'points', ar, 'ar')).toBe('نقطتان')
		expect(formatPoints(3, 'points', ar, 'ar')).toBe('3 نقاط')
		expect(formatPoints(11, 'points', ar, 'ar')).toBe('11 نقطة')
		expect(formatPoints(100, 'points', ar, 'ar')).toBe('100 نقطة')
		expect(formatPoints(2, 'stars', ar, 'ar')).toBe('نجمتان')
		expect(formatPoints(5, 'stars', ar, 'ar')).toBe('5 نجوم')
		// Intl marks the minus left-to-right.
		expect(formatPoints(-2, 'points', ar, 'ar')).toBe('\u200e-2 نقطة')
		expect(formatDelta(2, 'points', ar, 'ar')).toBe('+2 نقطة')
		expect(formatDelta(-1, 'points', ar, 'ar')).toBe('\u22121 نقطة')
	})

	it('measures progress from 0 to 100', () => {
		expect(progressPercent(150, 400)).toBe(37)
		expect(progressPercent(-20, 400)).toBe(0)
		expect(progressPercent(900, 400)).toBe(100)
		expect(progressPercent(5, 0)).toBe(100)
	})
})

describe('rewards', () => {
	it('describes a fixed amount off the whole order', () => {
		expect(describeReward(testReward(), labels, 'en')).toEqual({
			value: '$5.00 off',
			scope: labels.rewardScopeOrder,
			cap: null,
		})
	})

	it('describes a percentage with or without a cap', () => {
		expect(
			describeReward(
				testReward({
					discount: { type: 'percent', percentBp: 1500, maxDiscountMinor: 300 },
				}),
				labels,
				'en',
			),
		).toEqual({
			value: '15% off',
			scope: labels.rewardScopeOrder,
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
				labels,
				'en',
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
		expect(describeReward(reward, labels, 'en')).toEqual({
			value: 'Free Latte',
			scope: labels.rewardFreeItemNote,
			cap: null,
		})
		expect(
			describeReward(
				{ ...reward, labels: { items: {}, categories: {} } },
				labels,
				'en',
			).value,
		).toBe(labels.rewardFreeItemGeneric)
	})

	it('lists the items or categories covered, and never a partial list', () => {
		const items = testReward({
			kind: 'items',
			itemIds: ['a', 'b'],
			labels: { items: { a: 'Latte', b: 'Mocha' }, categories: {} },
		})
		expect(describeReward(items, labels, 'en').scope).toBe(
			'Applies to Latte and Mocha',
		)
		expect(
			describeReward(
				{ ...items, labels: { items: { a: 'Latte' }, categories: {} } },
				labels,
				'en',
			).scope,
		).toBe(labels.rewardScopeItemsGeneric)
		const categories = testReward({
			kind: 'categories',
			categoryIds: ['c'],
			labels: { items: {}, categories: { c: 'Pastries' } },
		})
		expect(describeReward(categories, labels, 'en').scope).toBe(
			'Applies to Pastries',
		)
	})

	it("uses each currency's own minor unit", () => {
		expect(
			describeReward(
				testReward({
					currency: 'JPY',
					discount: { type: 'fixed', amountMinor: 500 },
				}),
				labels,
				'en',
			).value,
		).toBe('¥500 off')
		expect(
			describeReward(
				testReward({
					currency: 'KWD',
					discount: { type: 'fixed', amountMinor: 1500 },
				}),
				labels,
				'en',
			).value,
		).toContain('1.500')
	})
})

describe('earning', () => {
	it('describes spend earning and what does not count', () => {
		expect(describeEarning(testProgram(), labels, 'en')).toEqual([
			'1 point for every $1.00 you spend',
			labels.earnExcludes,
		])
	})

	it('describes visit, item and category earning', () => {
		expect(
			describeEarning(
				testProgram({ earning: { method: 'visit', points: 10 } }),
				labels,
				'en',
			),
		).toEqual(['10 points for each visit (once a day)'])
		expect(
			describeEarning(
				testProgram({
					earning: { method: 'items', points: 5, itemIds: ['a'] },
					labels: { items: { a: 'Latte' }, categories: {} },
				}),
				labels,
				'en',
			),
		).toEqual(['5 points for each Latte'])
		expect(
			describeEarning(
				testProgram({
					earning: { method: 'categories', points: 2, categoryIds: ['c'] },
				}),
				labels,
				'en',
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
				labels,
				'en',
			),
		).toEqual([
			'10 points for each visit (once a day)',
			'Purchases of at least $10.00 qualify.',
			labels.earnExcludes,
		])
	})
})

describe('history', () => {
	it('names every entry type and channel', () => {
		expect(historyEntryLabel(testEntry(), labels)).toBe(labels.historyEarn)
		expect(
			historyEntryLabel(
				testEntry({ type: 'earn_reversal', delta: -12 }),
				labels,
			),
		).toBe(labels.historyEarnReversal)
		expect(
			historyEntryLabel(
				testEntry({ type: 'redeem', delta: -100, rewardName: 'Free coffee' }),
				labels,
			),
		).toBe('Redeemed \u2068Free coffee\u2069')
		expect(
			historyEntryLabel(testEntry({ type: 'redeem', delta: -100 }), labels),
		).toBe(labels.historyRedeemGeneric)
		expect(
			historyEntryLabel(
				testEntry({ type: 'redeem_restore', delta: 100 }),
				labels,
			),
		).toBe(labels.historyRedeemRestore)
		expect(
			historyEntryLabel(
				testEntry({ type: 'adjust', reason: 'goodwill' }),
				labels,
			),
		).toBe(labels.historyAdjust)
		expect(channelLabel('web', labels)).toBe(labels.channelWeb)
		expect(channelLabel('pos', labels)).toBe(labels.channelPos)
		expect(channelLabel('qr', labels)).toBe(labels.channelQr)
		expect(channelLabel('native', labels)).toBe(labels.channelNative)
		expect(channelLabel(null, labels)).toBeNull()
	})

	it('formats dates in the visitor locale with Western digits', () => {
		const at = Date.UTC(2030, 0, 15, 12)
		expect(formatEntryDate(at, 'en', 'date')).toBe('Jan 15, 2030')
		expect(formatEntryDate(at, 'ar')).not.toMatch(/[\u0660-\u0669]/)
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
		expect(approvalDetail(testApproval(), 'points', labels, 'en')).toBe(
			'Spends 100 points for $5.00 off',
		)
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
		expect(codes.filter((code) => !labels[loyaltyErrorLabelKey(code)])).toEqual(
			[],
		)
	})
})
