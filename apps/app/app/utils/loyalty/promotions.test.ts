import { i18n, type MessageDescriptor } from '@lingui/core'
import {
	loyaltyPromotionSchema,
	type LoyaltyProgramConfig,
	type LoyaltyPromotion,
} from '@repo/loyalty'
import { beforeAll, describe, expect, it } from 'vitest'
import {
	describePromotionEffect,
	describePromotionExample,
	describePromotionLocations,
	describePromotionSchedule,
	instantToLocalInput,
	minutesToTimeInput,
	multiplierToInput,
	newPromotionId,
	parseLocalInput,
	parseMultiplierToBp,
	parseTimeInput,
	promotionExample,
	promotionStatus,
} from './promotions.ts'

const NY = 'America/New_York'
// Tuesday 2026-01-13, New York wall-clock time (EST, UTC-5).
const tuesdayNy = (hour: number, minute = 0) =>
	Date.UTC(2026, 0, 13, hour + 5, minute)

const tx = (descriptor: MessageDescriptor) => i18n._(descriptor)

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function promotion(extra: Record<string, unknown> = {}): LoyaltyPromotion {
	return loyaltyPromotionSchema.parse({
		id: 'p1',
		name: 'Double',
		kind: 'multiplier',
		value: 20_000,
		...extra,
	})
}

const CONFIG: LoyaltyProgramConfig = {
	name: 'Club',
	unitLabel: 'points',
	currency: 'USD',
	timeZone: NY,
	minimumSpendMinor: 0,
	earning: { method: 'spend', points: 1, perMinor: 100 },
	terms: '',
	labels: { items: {}, categories: {} },
	promotions: [],
	promotionStacking: 'best',
}

describe('multiplier input', () => {
	it.each([
		[20_000, '2'],
		[15_000, '1.5'],
		[12_500, '1.25'],
		[100_000, '10'],
	])('shows %i basis points as %s', (bp, text) => {
		expect(multiplierToInput(bp)).toBe(text)
	})

	it.each([
		['2', 20_000],
		['1.5', 15_000],
		['1.25', 12_500],
		['1.05', 10_500],
		['10', 100_000],
		['١٫٥', 15_000],
	])('reads %s', (text, bp) => {
		expect(parseMultiplierToBp(text)).toBe(bp)
	})

	it.each(['', '1', '0.5', '10.01', '11', '1,5', 'two', '2x', '1.555', '-2'])(
		'refuses %j',
		(text) => {
			expect(parseMultiplierToBp(text)).toBeNull()
		},
	)
})

describe('time input', () => {
	it('round-trips minutes', () => {
		expect(minutesToTimeInput(0)).toBe('00:00')
		expect(minutesToTimeInput(15 * 60 + 5)).toBe('15:05')
		expect(minutesToTimeInput(1440)).toBe('00:00')
		expect(parseTimeInput('15:05')).toBe(905)
		expect(parseTimeInput('9:30')).toBe(570)
	})

	it.each(['', '24:00', '12:60', 'noon', '1530'])('refuses %j', (text) => {
		expect(parseTimeInput(text)).toBeNull()
	})
})

describe('date-time input in the program time zone', () => {
	it('reads wall-clock time in the zone, not the browser zone', () => {
		expect(parseLocalInput('2026-01-13T15:00', NY)).toBe(tuesdayNy(15))
		expect(parseLocalInput('2026-07-14T15:00', NY)).toBe(
			Date.UTC(2026, 6, 14, 19, 0),
		)
	})

	it('writes it back the same way', () => {
		expect(instantToLocalInput(tuesdayNy(15, 30), NY)).toBe('2026-01-13T15:30')
		expect(instantToLocalInput(null, NY)).toBe('')
	})

	it('tells an empty field from an impossible date', () => {
		expect(parseLocalInput('', NY)).toBeNull()
		expect(parseLocalInput('2026-02-31T10:00', NY)).toBeUndefined()
		expect(parseLocalInput('tomorrow', NY)).toBeUndefined()
	})
})

describe('promotionStatus', () => {
	it('is paused whenever it is switched off, whatever its dates say', () => {
		expect(
			promotionStatus(promotion({ enabled: false }), tuesdayNy(12), NY),
		).toBe('paused')
	})

	it('is live inside its dates and weekly window, scheduled outside, ended after', () => {
		const happyHour = promotion({
			recurring: { weekdays: [2], fromMinute: 900, toMinute: 1020 },
		})
		expect(promotionStatus(happyHour, tuesdayNy(15, 30), NY)).toBe('live')
		expect(promotionStatus(happyHour, tuesdayNy(14, 59), NY)).toBe('scheduled')
		expect(promotionStatus(happyHour, tuesdayNy(17), NY)).toBe('scheduled')

		const dated = promotion({
			startsAt: tuesdayNy(12),
			endsAt: tuesdayNy(18),
		})
		expect(promotionStatus(dated, tuesdayNy(11), NY)).toBe('scheduled')
		expect(promotionStatus(dated, tuesdayNy(12), NY)).toBe('live')
		expect(promotionStatus(dated, tuesdayNy(18), NY)).toBe('ended')
	})

	it('reads the weekly window in the program zone, not UTC', () => {
		const tuesdayEvening = promotion({
			recurring: { weekdays: [2], fromMinute: 20 * 60, toMinute: 22 * 60 },
		})
		// 2026-01-14 02:00 UTC is still Tuesday 21:00 in New York.
		expect(
			promotionStatus(tuesdayEvening, Date.UTC(2026, 0, 14, 2, 0), NY),
		).toBe('live')
	})

	it('does not read a location list as "not running"', () => {
		expect(
			promotionStatus(promotion({ locationIds: ['loc_2'] }), tuesdayNy(12), NY),
		).toBe('live')
	})
})

describe('descriptions', () => {
	it('says what a promotion does in one sentence', () => {
		expect(describePromotionEffect(promotion(), tx)).toBe(
			'2x points on the whole order',
		)
		expect(
			describePromotionEffect(promotion({ kind: 'bonus', value: 5 }), tx),
		).toBe('5 bonus points on every purchase')
		expect(
			describePromotionEffect(promotion({ kind: 'bonus', value: 1 }), tx),
		).toBe('1 bonus point on every purchase')
		expect(
			describePromotionEffect(
				promotion({
					scope: { type: 'items', itemIds: ['latte'] },
					labels: { items: { latte: 'Latte' }, categories: {} },
				}),
				tx,
			),
		).toBe('2x points on Latte')
		expect(
			describePromotionEffect(
				promotion({
					kind: 'bonus',
					value: 3,
					scope: { type: 'categories', categoryIds: ['a', 'b', 'c'] },
					labels: { items: {}, categories: { a: 'Drinks', b: 'Cakes' } },
				}),
				tx,
			),
		).toBe('3 bonus points for each of Drinks, Cakes and 1 more')
	})

	it('describes when it runs', () => {
		const at = { locale: 'en-US', timeZone: NY }
		expect(describePromotionSchedule(promotion(), at, tx)).toBe('Always')
		const weekly = describePromotionSchedule(
			promotion({
				recurring: { weekdays: [4, 2], fromMinute: 900, toMinute: 1020 },
			}),
			at,
			tx,
		)
		expect(weekly).toContain('Tue, Thu')
		expect(weekly).toMatch(/3:00\s?PM to 5:00\s?PM/)
		const dated = describePromotionSchedule(
			promotion({ startsAt: tuesdayNy(12), endsAt: tuesdayNy(18) }),
			at,
			tx,
		)
		expect(dated).toContain('from ')
		expect(dated).toContain('until ')
	})

	it('describes where it applies', () => {
		const locations = [
			{ id: 'a', name: 'Downtown' },
			{ id: 'b', name: 'Airport' },
			{ id: 'c', name: 'Mall' },
		]
		expect(describePromotionLocations(promotion(), locations, tx)).toBe(
			'All locations',
		)
		expect(
			describePromotionLocations(
				promotion({ locationIds: ['a'] }),
				locations,
				tx,
			),
		).toBe('Downtown')
		expect(
			describePromotionLocations(
				promotion({ locationIds: ['a', 'b', 'c'] }),
				locations,
				tx,
			),
		).toBe('Downtown, Airport and 1 more')
	})
})

describe('promotionExample', () => {
	const now = tuesdayNy(10)

	it('doubles a $20.00 order for a 2x promotion', () => {
		const example = promotionExample({
			config: CONFIG,
			promotion: promotion(),
			now,
		})
		expect(example).toMatchObject({
			orderMinor: 2000,
			basePoints: 20,
			bonusPoints: 20,
			totalPoints: 40,
			applies: true,
		})
	})

	it('picks a time inside the weekly window, in the program zone', () => {
		const happyHour = promotion({
			recurring: { weekdays: [2], fromMinute: 900, toMinute: 1020 },
		})
		const example = promotionExample({
			config: CONFIG,
			promotion: happyHour,
			now,
		})
		expect(example.applies).toBe(true)
		expect(instantToLocalInput(example.at, NY)).toBe('2026-01-13T16:00')
		expect(
			describePromotionExample(
				example,
				{ currency: 'USD', locale: 'en-US', timeZone: NY },
				tx,
			),
		).toMatch(
			/^A \$20\.00 order on Jan 13, 2026.* earns 20 points; with this promotion it earns 40\.$/,
		)
	})

	it('moves to the next matching weekday when today is not one', () => {
		const wednesdays = promotion({
			recurring: { weekdays: [3], fromMinute: 600, toMinute: 700 },
		})
		const example = promotionExample({
			config: CONFIG,
			promotion: wednesdays,
			now,
		})
		expect(instantToLocalInput(example.at, NY).slice(0, 10)).toBe('2026-01-14')
		expect(example.applies).toBe(true)
	})

	it('starts at the promotion start when it has not begun', () => {
		const later = promotion({ startsAt: tuesdayNy(10) + 3 * 86_400_000 })
		const example = promotionExample({ config: CONFIG, promotion: later, now })
		expect(example.at).toBe(later.startsAt)
		expect(example.applies).toBe(true)
	})

	it('runs the real earning rule, including a minimum spend', () => {
		const example = promotionExample({
			config: { ...CONFIG, minimumSpendMinor: 3000 },
			promotion: promotion(),
			now,
		})
		// The sample grows to the minimum so the example still earns.
		expect(example.orderMinor).toBe(3000)
		expect(example.basePoints).toBe(30)
		expect(example.totalPoints).toBe(60)
	})

	it('builds a sample that matches an items program and an items promotion', () => {
		const example = promotionExample({
			config: {
				...CONFIG,
				earning: { method: 'items', points: 5, itemIds: ['mocha'] },
			},
			promotion: promotion({
				kind: 'bonus',
				value: 3,
				scope: { type: 'items', itemIds: ['latte'] },
			}),
			now,
		})
		// One mocha line earns 5; one latte line earns the 3 bonus.
		expect(example.basePoints).toBe(5)
		expect(example.bonusPoints).toBe(3)
	})

	it('says so when the promotion adds nothing to the sample', () => {
		// Item scopes need item points, which a visit program does not give.
		const example = promotionExample({
			config: { ...CONFIG, earning: { method: 'visit', points: 10 } },
			promotion: promotion({
				scope: { type: 'items', itemIds: ['latte'] },
			}),
			now,
		})
		expect(example.applies).toBe(false)
		expect(
			describePromotionExample(
				example,
				{ currency: 'USD', locale: 'en-US', timeZone: NY },
				tx,
			),
		).toContain('this promotion adds nothing to it')
	})
})

describe('newPromotionId', () => {
	it('makes ids the contract accepts, one per call', () => {
		const a = newPromotionId()
		const b = newPromotionId()
		expect(a).not.toBe(b)
		expect(loyaltyPromotionSchema.shape.id.safeParse(a).success).toBe(true)
	})
})
