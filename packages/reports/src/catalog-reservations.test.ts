import { describe, expect, it } from 'vitest'
import { getSubject, organizationCatalog } from './catalog.ts'
import {
	RESERVATIONS_REPORT_SUBJECTS,
	reservationsSubjects,
} from './catalog-reservations.ts'
import { createReportDefinition, type ReportDefinition } from './dsl.ts'
import {
	isReportRunError,
	runReport,
	validateReportDefinition,
} from './engine.ts'

const NOW = new Date('2031-03-20T12:00:00.000Z')

function ok<T extends object>(result: T | { error: string }): T {
	if ('error' in result) throw new Error(JSON.stringify(result))
	return result
}

function booking(patch: Record<string, unknown>) {
	const status = String(patch.status ?? 'finished')
	return {
		startsAt: new Date('2031-03-10T19:00:00Z'),
		timeZone: 'UTC',
		service: 'Dinner',
		partySize: 2,
		covers: 2,
		status,
		isBooked: ['cancelled', 'declined', 'expired'].includes(status) ? 0 : 1,
		isNoShow: status === 'no_show' ? 1 : 0,
		isCancelled: status === 'cancelled' ? 1 : 0,
		isLateCancel: 0,
		isFinished: status === 'finished' ? 1 : 0,
		bookingCount: 1,
		...patch,
	}
}

function ratioReport(
	subject: string,
	valueField: string,
	timeframeField: string,
	groupBy: string[] = [],
): ReportDefinition {
	return createReportDefinition({
		subject,
		timeframe: { field: timeframeField, preset: 'all_time' },
		groupBy,
		visualization: {
			chartStyle: groupBy.length > 0 ? 'table' : 'single_number',
			measure: 'ratio',
			valueField,
			sortBy: 'none',
			hideCounts: false,
		},
		settings: { title: 'Rate', notes: '', timezone: 'UTC' },
	})
}

describe('reservations catalog', () => {
	it('registers every reservations subject in the organization catalog', () => {
		for (const id of RESERVATIONS_REPORT_SUBJECTS) {
			expect(getSubject(organizationCatalog, id), id).toBeDefined()
		}
	})

	it('carries no field that could hold guest contact details or free text', () => {
		const banned =
			/name|phone|email|note|allerg|dietary|request|address|guest|comment|message/i
		for (const subject of reservationsSubjects) {
			for (const field of subject.fields) {
				// `service` and `location` are business names, not people.
				if (['service', 'location', 'experience'].includes(field.id)) continue
				expect(banned.test(field.id), `${subject.id}.${field.id}`).toBe(false)
			}
		}
	})

	it('computes a no-show rate from 0/1 number flags, exactly over any group', () => {
		const records = [
			booking({ status: 'finished' }),
			booking({ status: 'finished' }),
			booking({ status: 'no_show' }),
			booking({ status: 'cancelled' }),
			booking({ status: 'finished', service: 'Lunch' }),
			booking({ status: 'no_show', service: 'Lunch' }),
		]
		const whole = ok(
			runReport(
				organizationCatalog,
				ratioReport('bookings', 'noShowRate', 'startsAt'),
				records,
				NOW,
			),
		)
		// 2 no-shows over 5 booked parties; the cancelled one is not booked.
		expect(whole.value).toBeCloseTo(40)
		expect(whole.valueInfo).toMatchObject({ measure: 'ratio', type: 'percent' })

		const byService = ok(
			runReport(
				organizationCatalog,
				ratioReport('bookings', 'noShowRate', 'startsAt', ['service']),
				records,
				NOW,
			),
		)
		const rate = (label: string) =>
			byService.segments.find((s) => s.label === label)?.value
		expect(rate('Dinner')).toBeCloseTo(100 / 3)
		expect(rate('Lunch')).toBeCloseTo(50)
	})

	it('computes late-cancel share and cancellation rate', () => {
		const records = [
			booking({ status: 'cancelled', isLateCancel: 1 }),
			booking({ status: 'cancelled' }),
			booking({ status: 'cancelled' }),
			booking({ status: 'finished' }),
		]
		const share = ok(
			runReport(
				organizationCatalog,
				ratioReport('bookings', 'lateCancelShare', 'startsAt'),
				records,
				NOW,
			),
		)
		expect(share.value).toBeCloseTo(100 / 3)
		const rate = ok(
			runReport(
				organizationCatalog,
				ratioReport('bookings', 'cancellationRate', 'startsAt'),
				records,
				NOW,
			),
		)
		expect(rate.value).toBeCloseTo(75)
	})

	it('leaves a rate with no booked parties unknown rather than zero', () => {
		const result = ok(
			runReport(
				organizationCatalog,
				ratioReport('bookings', 'noShowRate', 'startsAt'),
				[booking({ status: 'cancelled' })],
				NOW,
			),
		)
		expect(result.value).toBeUndefined()
	})

	it('averages a signed turn-time difference and skips parties without one', () => {
		const definition = createReportDefinition({
			subject: 'bookings',
			timeframe: { field: 'startsAt', preset: 'all_time' },
			visualization: {
				chartStyle: 'single_number',
				measure: 'average',
				valueField: 'turnVarianceMinutes',
				sortBy: 'none',
				hideCounts: false,
			},
			settings: { title: 'Variance', notes: '', timezone: 'UTC' },
		})
		const result = ok(
			runReport(
				organizationCatalog,
				definition,
				[
					booking({ turnVarianceMinutes: -10 }),
					booking({ turnVarianceMinutes: 4 }),
					booking({ turnVarianceMinutes: null }),
				],
				NOW,
			),
		)
		expect(result.value).toBe(-3)
	})

	it('rejects a ratio over a field that is not a ratio', () => {
		expect(
			validateReportDefinition(
				organizationCatalog,
				ratioReport('bookings', 'isNoShow', 'startsAt'),
			),
		).not.toBeNull()
	})

	it('measures pacing slots over their limit and covers against the limit', () => {
		const slot = (patch: Record<string, unknown>) => ({
			startsAt: new Date('2031-03-10T19:00:00Z'),
			timeZone: 'UTC',
			service: 'Dinner',
			bookings: 2,
			covers: 8,
			maxCovers: 10,
			maxParties: null,
			overLimit: false,
			slotCount: 1,
			overLimitSlots: 0,
			...patch,
		})
		const records = [
			slot({}),
			slot({ covers: 14, overLimit: true, overLimitSlots: 1 }),
			slot({ covers: 5, maxCovers: null }),
		]
		const over = ok(
			runReport(
				organizationCatalog,
				ratioReport('pacing_slots', 'overLimitShare', 'startsAt'),
				records,
				NOW,
			),
		)
		expect(over.value).toBeCloseTo(100 / 3)
		const use = ok(
			runReport(
				organizationCatalog,
				ratioReport('pacing_slots', 'coversUtilization', 'startsAt'),
				records,
				NOW,
			),
		)
		// The slot with no limit is left out: (8 + 14) / (10 + 10).
		expect(use.value).toBeCloseTo(110)
		expect(isReportRunError(use)).toBe(false)
	})
})
