import { describe, expect, test } from 'vitest'
import {
	buildOrderAttribution,
	ORDER_ATTRIBUTION_WINDOW_MS,
	orderAttributionInputSchema,
	parseStoredAttribution,
} from './order-attribution.ts'

const NOW = Date.UTC(2026, 10, 21, 12)
const DAY = 24 * 60 * 60 * 1000

describe('the attribution a browser sends', () => {
	test('keeps known values, capped and without control characters', () => {
		const parsed = orderAttributionInputSchema.parse({
			utmSource: ' news\u0007letter ',
			campaignId: 'camp-1',
			touchedAt: NOW,
		})
		expect(parsed).toEqual({
			utmSource: 'newsletter',
			utmMedium: undefined,
			utmCampaign: undefined,
			utmContent: undefined,
			campaignId: 'camp-1',
			stepId: undefined,
			shortLinkId: undefined,
			touchedAt: NOW,
		})
	})

	test('refuses an oversized value and an unknown field', () => {
		expect(
			orderAttributionInputSchema.safeParse({ utmSource: 'x'.repeat(101) })
				.success,
		).toBe(false)
		expect(
			orderAttributionInputSchema.safeParse({ utmSource: 'x'.repeat(100) })
				.success,
		).toBe(true)
		for (const extra of [
			{ visitorId: 'abc' },
			{ ip: '1.2.3.4' },
			{ userAgent: 'x' },
			{ coupon: 'FREE' },
		]) {
			expect(orderAttributionInputSchema.safeParse(extra).success).toBe(false)
		}
		expect(
			orderAttributionInputSchema.safeParse({ touchedAt: -1 }).success,
		).toBe(false)
		expect(
			orderAttributionInputSchema.safeParse({ touchedAt: 1.5 }).success,
		).toBe(false)
		expect(orderAttributionInputSchema.safeParse('x').success).toBe(false)
	})
})

describe('buildOrderAttribution', () => {
	const base = { orderSource: null, shortLinkKnown: true, now: NOW } as const

	test('a UTM visit two days earlier is still credited', () => {
		const built = buildOrderAttribution({
			...base,
			attribution: {
				utmSource: 'newsletter',
				utmMedium: 'email',
				utmCampaign: 'spring',
				touchedAt: NOW - 2 * DAY,
			},
		})
		expect(built.source).toBe('newsletter')
		expect(built.attribution).toMatchObject({
			utmSource: 'newsletter',
			utmCampaign: 'spring',
			touchedAt: NOW - 2 * DAY,
		})
	})

	test('a touch older than 7 days, or from the future, is dropped: direct', () => {
		for (const touchedAt of [
			NOW - ORDER_ATTRIBUTION_WINDOW_MS - 1,
			NOW - 30 * DAY,
			NOW + DAY,
		]) {
			expect(
				buildOrderAttribution({
					...base,
					attribution: { utmSource: 'old', touchedAt },
				}),
			).toEqual({ attribution: null, source: 'direct' })
		}
		// Without a time there is no touch to trust.
		expect(
			buildOrderAttribution({ ...base, attribution: { utmSource: 'x' } }),
		).toEqual({ attribution: null, source: 'direct' })
	})

	test('a message click is attributed to its campaign, by medium', () => {
		const email = buildOrderAttribution({
			...base,
			attribution: {
				utmSource: 'menuza',
				utmMedium: 'email',
				campaignId: 'camp-1',
				touchedAt: NOW - DAY,
			},
		})
		expect(email.source).toBe('email')
		expect(email.attribution?.campaignId).toBe('camp-1')
		expect(
			buildOrderAttribution({
				...base,
				attribution: { utmMedium: 'SMS', campaignId: 'camp-1', touchedAt: NOW },
			}).source,
		).toBe('sms')
		expect(
			buildOrderAttribution({
				...base,
				attribution: { campaignId: 'camp-1', touchedAt: NOW },
			}).source,
		).toBe('campaign')
	})

	test('the short-link id is stored when the guest came from #159, and only when it exists', () => {
		const built = buildOrderAttribution({
			...base,
			attribution: {
				shortLinkId: 'link-9',
				campaignId: 'camp-1',
				touchedAt: NOW - 3600_000,
			},
		})
		expect(built.source).toBe('short_link')
		expect(built.attribution?.shortLinkId).toBe('link-9')
		const unknown = buildOrderAttribution({
			...base,
			shortLinkKnown: false,
			attribution: { shortLinkId: 'made-up', touchedAt: NOW },
		})
		expect(unknown).toEqual({ attribution: null, source: 'direct' })
	})

	test('QR table and poster orders keep their own source', () => {
		for (const orderSource of ['qr_table', 'qr_poster'] as const) {
			expect(
				buildOrderAttribution({
					...base,
					orderSource,
					attribution: { utmSource: 'x', touchedAt: NOW },
				}).source,
			).toBe(orderSource)
		}
	})

	test('a coupon alone is a source of its own; a touch outranks it', () => {
		expect(
			buildOrderAttribution({
				...base,
				attribution: null,
				couponCode: 'SPRING10',
			}),
		).toEqual({
			attribution: { coupon: 'SPRING10' },
			source: 'coupon',
		})
		expect(
			buildOrderAttribution({
				...base,
				couponCode: 'SPRING10',
				attribution: { utmSource: 'flyer', touchedAt: NOW },
			}).source,
		).toBe('flyer')
	})

	test('no touch and no coupon is direct, and a step without its campaign is dropped', () => {
		expect(buildOrderAttribution({ ...base, attribution: null })).toEqual({
			attribution: null,
			source: 'direct',
		})
		expect(
			buildOrderAttribution({
				...base,
				attribution: { stepId: 'node-1', touchedAt: NOW },
			}),
		).toEqual({ attribution: null, source: 'direct' })
	})
})

describe('parseStoredAttribution', () => {
	test('reads json text or an object, and nothing else', () => {
		expect(
			parseStoredAttribution('{"utmSource":"a","touchedAt":5,"x":"y"}'),
		).toEqual({
			utmSource: 'a',
			touchedAt: 5,
		})
		expect(parseStoredAttribution({ campaignId: 'c' })).toEqual({
			campaignId: 'c',
		})
		expect(parseStoredAttribution('nope')).toBeNull()
		expect(parseStoredAttribution(null)).toBeNull()
		expect(parseStoredAttribution('{}')).toBeNull()
	})
})
