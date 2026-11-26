import { describe, expect, it } from 'vitest'
import {
	activeCateringCutoffs,
	balanceDueAtMs,
	balanceDueDate,
	balanceOrderRef,
	buildCateringQnA,
	cateringFaqJsonLd,
	cateringKnowledgeText,
	cateringSettingsSchema,
	checkCateringLimits,
	computeDepositSplit,
	defaultCateringSettings,
	dueAtForDate,
	eventDayBeforeAlertAtMs,
	inCateringQuietHours,
	isCateringDateOrderable,
	nextBalanceReminder,
	parseBalanceOrderRef,
	parseCateringSettings,
	parseQuoteOrderRef,
	priceCateringQuote,
	quoteOrderRef,
	quotePayability,
	readCateringPolicy,
	validateCateringEvent,
	validateCateringSettings,
	type CateringSettings,
} from './catering.ts'

const NY = 'America/New_York'

function settingsWith(patch: Partial<CateringSettings>): CateringSettings {
	return { ...defaultCateringSettings(), enabled: true, ...patch }
}

describe('catering settings', () => {
	it('defaults are off and parse from stored JSON', () => {
		const defaults = defaultCateringSettings()
		expect(defaults.enabled).toBe(false)
		expect(defaults.noticeHours).toBe(24)
		expect(
			parseCateringSettings(JSON.stringify(settingsWith({}))),
		).toMatchObject({ enabled: true })
		expect(parseCateringSettings('not json')).toBeNull()
		expect(parseCateringSettings(null)).toBeNull()
		// Unknown keys are refused (strict): a bad row reads as off.
		expect(parseCateringSettings({ enabled: true, surprise: 1 })).toBeNull()
	})

	it('rejects more than 24 cutoffs and an order-by that is not before the range', () => {
		const cutoff = (i: number) => ({
			id: `c${i}`,
			from: '2026-12-20',
			to: '2026-12-24',
			orderByDate: '2026-12-10',
			orderByTime: '17:00',
		})
		expect(
			cateringSettingsSchema.safeParse({
				cutoffs: Array.from({ length: 25 }, (_, i) => cutoff(i)),
			}).success,
		).toBe(false)
		expect(
			cateringSettingsSchema.safeParse({
				cutoffs: Array.from({ length: 24 }, (_, i) => cutoff(i)),
			}).success,
		).toBe(true)
		expect(
			cateringSettingsSchema.safeParse({
				cutoffs: [{ ...cutoff(0), orderByDate: '2026-12-20' }],
			}).success,
		).toBe(false)
		expect(
			cateringSettingsSchema.safeParse({
				cutoffs: [{ ...cutoff(0), to: '2026-12-19' }],
			}).success,
		).toBe(false)
	})

	it('validates a min above the max, no fulfillment and a range in the past', () => {
		const problems = validateCateringSettings(
			settingsWith({
				minMinor: 5000,
				maxMinor: 1000,
				fulfillments: { pickup: false, delivery: false },
				quoteMode: 'optional',
				cutoffs: [
					{
						id: 'old',
						from: '2026-01-01',
						to: '2026-01-02',
						orderByDate: '2025-12-20',
						orderByTime: '10:00',
					},
				],
			}),
			{
				timeZone: NY,
				now: new Date('2026-06-01T12:00:00Z'),
				quotesFlag: false,
			},
		)
		expect(problems).toHaveLength(4)
	})
})

describe('readCateringPolicy', () => {
	const settings = settingsWith({ quoteMode: 'optional' })
	it('is off without the context, the location or the enabled setting', () => {
		expect(readCateringPolicy(undefined, 'loc')).toBeNull()
		expect(readCateringPolicy({ locations: {} }, 'loc')).toBeNull()
		expect(
			readCateringPolicy(
				{ quotes: true, locations: { loc: { ...settings, enabled: false } } },
				'loc',
			),
		).toBeNull()
	})
	it('needs the quotes flag for a quote mode', () => {
		expect(
			readCateringPolicy(
				{ quotes: false, locations: { loc: settings } },
				'loc',
			),
		).toMatchObject({ quotes: false, settings: { quoteMode: 'off' } })
		expect(
			readCateringPolicy({ quotes: true, locations: { loc: settings } }, 'loc'),
		).toMatchObject({ quotes: true, settings: { quoteMode: 'optional' } })
	})
})

describe('cutoffs (#255)', () => {
	// Orders for Dec 20 to 24 close on Dec 10 at 5:00 PM New York time (EST, UTC-5).
	const settings = settingsWith({
		cutoffs: [
			{
				id: 'xmas',
				from: '2026-12-20',
				to: '2026-12-24',
				orderByDate: '2026-12-10',
				orderByTime: '17:00',
				note: { en: 'Holiday baking' },
			},
		],
	})
	const withZone = { cutoffs: settings.cutoffs, timeZone: NY }
	const event = new Date('2026-12-22T17:00:00Z')

	it('shows the order-by moment before it and refuses after it', () => {
		const before = isCateringDateOrderable(
			withZone,
			new Date('2026-12-10T21:59:00Z'),
			event,
		)
		expect(before).toMatchObject({
			orderable: true,
			orderBy: { orderByAtMs: Date.parse('2026-12-10T22:00:00Z') },
		})
		const at = isCateringDateOrderable(
			withZone,
			new Date('2026-12-10T22:00:00Z'),
			event,
		)
		expect(at.orderable).toBe(false)
		if (!at.orderable) expect(at.cutoff.note).toEqual({ en: 'Holiday baking' })
	})

	it('does not touch dates outside the range', () => {
		const outside = isCateringDateOrderable(
			withZone,
			new Date('2026-12-15T12:00:00Z'),
			new Date('2026-12-26T17:00:00Z'),
		)
		expect(outside).toEqual({ orderable: true, orderBy: null })
	})

	it('evaluates in the location zone across a daylight-saving change', () => {
		// New York springs forward on 2026-03-08 at 2:00 AM.
		const dst = {
			cutoffs: [
				{
					id: 'dst',
					from: '2026-03-08',
					to: '2026-03-09',
					orderByDate: '2026-03-06',
					orderByTime: '17:00',
				},
			],
			timeZone: NY,
		}
		// 17:00 EST on Mar 6 is 22:00Z.
		expect(
			isCateringDateOrderable(
				dst,
				new Date('2026-03-06T21:59:00Z'),
				new Date('2026-03-08T20:00:00Z'),
			).orderable,
		).toBe(true)
		expect(
			isCateringDateOrderable(
				dst,
				new Date('2026-03-06T22:00:00Z'),
				new Date('2026-03-08T20:00:00Z'),
			).orderable,
		).toBe(false)
		// 23:30 EDT on Mar 8 is 03:30Z on Mar 9: still the 8th in New York.
		const lateEvening = new Date('2026-03-09T03:30:00Z')
		expect(
			isCateringDateOrderable(
				{
					...dst,
					cutoffs: [
						{ ...dst.cutoffs[0]!, from: '2026-03-08', to: '2026-03-08' },
					],
				},
				new Date('2026-03-07T00:00:00Z'),
				lateEvening,
			).orderable,
		).toBe(false)
		// A cutoff after the change: 17:00 EDT on Mar 10 is 21:00Z (UTC-4, not -5).
		const after = {
			cutoffs: [
				{
					id: 'after',
					from: '2026-03-12',
					to: '2026-03-13',
					orderByDate: '2026-03-10',
					orderByTime: '17:00',
				},
			],
			timeZone: NY,
		}
		expect(
			isCateringDateOrderable(
				after,
				new Date('2026-03-10T20:59:00Z'),
				new Date('2026-03-12T16:00:00Z'),
			).orderable,
		).toBe(true)
		expect(
			isCateringDateOrderable(
				after,
				new Date('2026-03-10T21:00:00Z'),
				new Date('2026-03-12T16:00:00Z'),
			).orderable,
		).toBe(false)
	})

	it('picks the earliest order-by moment of overlapping ranges', () => {
		const overlapping = {
			timeZone: NY,
			cutoffs: [
				{
					id: 'late',
					from: '2026-12-20',
					to: '2026-12-24',
					orderByDate: '2026-12-12',
					orderByTime: '12:00',
				},
				{
					id: 'early',
					from: '2026-12-22',
					to: '2026-12-23',
					orderByDate: '2026-12-08',
					orderByTime: '12:00',
				},
			],
		}
		const status = isCateringDateOrderable(
			overlapping,
			new Date('2026-12-09T12:00:00Z'),
			new Date('2026-12-22T17:00:00Z'),
		)
		expect(status.orderable).toBe(false)
		if (!status.orderable) expect(status.cutoff.id).toBe('early')
		// A date only the later cutoff covers is still open then.
		expect(
			isCateringDateOrderable(
				overlapping,
				new Date('2026-12-09T12:00:00Z'),
				new Date('2026-12-20T17:00:00Z'),
			).orderable,
		).toBe(true)
	})

	it('archives a cutoff whose range has ended', () => {
		const list = activeCateringCutoffs(
			settingsWith({
				cutoffs: [
					{
						id: 'past',
						from: '2026-11-20',
						to: '2026-11-24',
						orderByDate: '2026-11-10',
						orderByTime: '12:00',
					},
					{
						id: 'now',
						from: '2026-12-20',
						to: '2026-12-24',
						orderByDate: '2026-12-10',
						orderByTime: '12:00',
					},
				],
			}),
			new Date('2026-11-25T12:00:00Z'),
			NY,
		)
		expect(list.map((c) => c.id)).toEqual(['now'])
	})
})

describe('validateCateringEvent', () => {
	const now = new Date('2026-06-01T15:00:00Z')
	const settings = settingsWith({ noticeHours: 48, maxDaysAhead: 30 })
	const base = { settings, timeZone: NY, now }

	it('refuses an event inside the notice period', () => {
		const result = validateCateringEvent({
			...base,
			eventAt: new Date('2026-06-02T15:00:00Z'),
		})
		expect(result).toMatchObject({
			ok: false,
			failure: { code: 'catering_too_soon' },
		})
	})

	it('accepts exactly the notice period and refuses beyond the window', () => {
		expect(
			validateCateringEvent({
				...base,
				eventAt: new Date('2026-06-03T15:00:00Z'),
			}).ok,
		).toBe(true)
		expect(
			validateCateringEvent({
				...base,
				eventAt: new Date('2026-07-05T15:00:00Z'),
			}),
		).toMatchObject({ ok: false, failure: { code: 'catering_too_far' } })
	})

	it('refuses a closed time and a passed cutoff', () => {
		expect(
			validateCateringEvent({
				...base,
				eventAt: new Date('2026-06-10T15:00:00Z'),
				isOpenAt: () => ({ isOpen: false, reason: 'Closed today' }),
			}),
		).toMatchObject({ ok: false, failure: { code: 'catering_closed' } })
		const withCutoff = settingsWith({
			noticeHours: 0,
			cutoffs: [
				{
					id: 'c',
					from: '2026-06-10',
					to: '2026-06-12',
					orderByDate: '2026-06-01',
					orderByTime: '09:00',
				},
			],
		})
		expect(
			validateCateringEvent({
				settings: withCutoff,
				timeZone: NY,
				now,
				eventAt: new Date('2026-06-11T16:00:00Z'),
			}),
		).toMatchObject({ ok: false, failure: { code: 'catering_cutoff_passed' } })
	})
})

describe('checkCateringLimits', () => {
	const settings = settingsWith({
		minMinor: 10_000,
		maxMinor: 500_000,
		maxGuests: 100,
		fulfillments: { pickup: true, delivery: false },
	})
	it('checks fulfillment, minimum, maximum and guests', () => {
		const ok = {
			settings,
			subtotalCents: 20_000,
			guestCount: 20,
			fulfillment: 'pickup' as const,
		}
		expect(checkCateringLimits(ok).ok).toBe(true)
		expect(
			checkCateringLimits({ ...ok, fulfillment: 'delivery' }),
		).toMatchObject({
			failure: { code: 'catering_fulfillment' },
		})
		expect(checkCateringLimits({ ...ok, subtotalCents: 9_999 })).toMatchObject({
			failure: { code: 'catering_minimum' },
		})
		expect(
			checkCateringLimits({ ...ok, subtotalCents: 500_001 }),
		).toMatchObject({
			failure: { code: 'catering_maximum' },
		})
		expect(checkCateringLimits({ ...ok, guestCount: 101 })).toMatchObject({
			failure: { code: 'catering_guests' },
		})
	})
})

describe('deposit and balance (#361)', () => {
	it('splits a 30 percent deposit', () => {
		expect(computeDepositSplit({ totalCents: 10_000, percent: 30 })).toEqual({
			depositCents: 3_000,
			balanceCents: 7_000,
			percent: 30,
		})
		// Rounds to a minor unit and never takes the whole total as a deposit.
		expect(
			computeDepositSplit({ totalCents: 3_333, percent: 30 }),
		).toMatchObject({ depositCents: 1_000, balanceCents: 2_333 })
		expect(computeDepositSplit({ totalCents: 10_000, percent: 0 })).toEqual({
			depositCents: 10_000,
			balanceCents: 0,
			percent: 100,
		})
		expect(
			computeDepositSplit({ totalCents: 10_000, percent: 100 }),
		).toMatchObject({ balanceCents: 0 })
	})

	it('puts the balance due at the end of the day N days before the event', () => {
		const event = new Date('2026-06-20T22:00:00Z') // 6:00 PM EDT on Jun 20
		const dueAt = balanceDueAtMs(event, 3, NY)
		expect(balanceDueDate(dueAt, NY)).toBe('2026-06-17')
		expect(dueAt).toBe(Date.parse('2026-06-18T04:00:00Z'))
		expect(dueAtForDate('2026-06-17', NY)).toBe(dueAt)
	})

	it('sends one reminder before the due date and one when overdue, outside quiet hours', () => {
		const dueAt = balanceDueAtMs(new Date('2026-06-20T22:00:00Z'), 3, NY)
		const state = {
			balanceDueAtMs: dueAt,
			balanceCents: 7_000,
			balanceState: 'due' as const,
			beforeDueSentAtMs: null as number | null,
			overdueSentAtMs: null as number | null,
			eventAtMs: Date.parse('2026-06-20T22:00:00Z'),
		}
		const options = { timeZone: NY, reminderDaysBeforeDue: 2 }
		// Reminder day is Jun 15; midnight is quiet, so it waits for 08:00 EDT (12:00Z).
		const early = nextBalanceReminder(state, {
			...options,
			now: Date.parse('2026-06-15T04:30:00Z'),
		})
		expect(early).toEqual({
			due: null,
			nextAtMs: Date.parse('2026-06-15T12:00:00Z'),
		})
		expect(
			nextBalanceReminder(state, {
				...options,
				now: Date.parse('2026-06-15T13:00:00Z'),
			}),
		).toEqual({ due: 'before_due', nextAtMs: null })
		// Once sent, nothing more until the due moment.
		const sent = {
			...state,
			beforeDueSentAtMs: Date.parse('2026-06-15T13:00:00Z'),
		}
		expect(
			nextBalanceReminder(sent, {
				...options,
				now: Date.parse('2026-06-17T16:00:00Z'),
			}),
		).toMatchObject({ due: null })
		// Overdue starts at the due instant (00:00 EDT, quiet) and goes at 08:00.
		expect(
			nextBalanceReminder(sent, {
				...options,
				now: Date.parse('2026-06-18T05:00:00Z'),
			}),
		).toEqual({ due: null, nextAtMs: Date.parse('2026-06-18T12:00:00Z') })
		expect(
			nextBalanceReminder(sent, {
				...options,
				now: Date.parse('2026-06-18T12:05:00Z'),
			}),
		).toEqual({ due: 'overdue', nextAtMs: null })
		// Sent, paid and voided balances send nothing.
		const both = {
			...sent,
			overdueSentAtMs: Date.parse('2026-06-18T12:05:00Z'),
		}
		expect(
			nextBalanceReminder(both, {
				...options,
				now: Date.parse('2026-06-19T12:00:00Z'),
			}),
		).toEqual({ due: null, nextAtMs: null })
		expect(
			nextBalanceReminder(
				{ ...state, balanceState: 'paid' },
				{
					...options,
					now: Date.parse('2026-06-19T12:00:00Z'),
				},
			),
		).toEqual({ due: null, nextAtMs: null })
		expect(
			nextBalanceReminder(
				{ ...state, balanceState: 'void' },
				{
					...options,
					now: Date.parse('2026-06-19T12:00:00Z'),
				},
			),
		).toEqual({ due: null, nextAtMs: null })
	})

	it('skips the before-due reminder once the balance is already overdue', () => {
		const dueAt = Date.parse('2026-06-18T04:00:00Z')
		const result = nextBalanceReminder(
			{
				balanceDueAtMs: dueAt,
				balanceCents: 100,
				balanceState: 'due',
				beforeDueSentAtMs: null,
				overdueSentAtMs: null,
				eventAtMs: dueAt + 3 * 86_400_000,
			},
			{
				now: Date.parse('2026-06-18T15:00:00Z'),
				timeZone: NY,
				reminderDaysBeforeDue: 2,
			},
		)
		expect(result.due).toBe('overdue')
	})

	it('has quiet hours from 21:00 to 08:00 local', () => {
		expect(inCateringQuietHours(Date.parse('2026-06-15T02:00:00Z'), NY)).toBe(
			true,
		) // 22:00
		expect(inCateringQuietHours(Date.parse('2026-06-15T13:00:00Z'), NY)).toBe(
			false,
		) // 09:00
	})

	it('alerts the restaurant the day before at 09:00 local', () => {
		expect(eventDayBeforeAlertAtMs(new Date('2026-06-20T22:00:00Z'), NY)).toBe(
			Date.parse('2026-06-19T13:00:00Z'),
		)
	})
})

describe('quotes', () => {
	it('prices tax-exclusive and tax-inclusive quotes', () => {
		const lines = [
			{ quantity: 10, unitPriceCents: 1_000, taxable: true },
			{ quantity: 1, unitPriceCents: 500, taxable: false },
		]
		const charges = [{ amountCents: 2_000, taxable: false }]
		expect(
			priceCateringQuote({
				lines,
				charges,
				taxRatePercent: 10,
				taxInclusive: false,
			}),
		).toMatchObject({
			subtotalCents: 12_500,
			taxCents: 1_000,
			totalCents: 13_500,
		})
		expect(
			priceCateringQuote({
				lines,
				charges,
				taxRatePercent: 10,
				taxInclusive: true,
			}),
		).toMatchObject({ taxCents: 909, totalCents: 12_500 })
	})

	it('only a sent, unexpired quote is payable', () => {
		const now = 1_000_000
		expect(
			quotePayability({ status: 'sent', expiresAtMs: now + 1 }, now).ok,
		).toBe(true)
		expect(
			quotePayability({ status: 'accepted', expiresAtMs: now + 1 }, now).ok,
		).toBe(true)
		expect(
			quotePayability({ status: 'sent', expiresAtMs: now }, now),
		).toMatchObject({
			failure: { code: 'quote_expired' },
		})
		expect(
			quotePayability({ status: 'draft', expiresAtMs: null }, now),
		).toMatchObject({
			failure: { code: 'quote_not_payable' },
		})
		expect(
			quotePayability({ status: 'paid', expiresAtMs: null }, now),
		).toMatchObject({
			failure: { code: 'quote_not_payable' },
		})
		expect(
			quotePayability({ status: 'cancelled', expiresAtMs: null }, now),
		).toMatchObject({
			failure: { code: 'quote_cancelled' },
		})
	})

	it('builds and parses bridge refs', () => {
		const id = '0b2f4c5e-1a3d-4e6f-8a9b-1c2d3e4f5a6b'
		expect(parseQuoteOrderRef(quoteOrderRef(id))).toBe(id)
		expect(parseBalanceOrderRef(balanceOrderRef(id))).toBe(id)
		expect(parseQuoteOrderRef(balanceOrderRef(id))).toBeNull()
		expect(parseQuoteOrderRef('quote:x')).toBeNull()
		expect(parseBalanceOrderRef('tab:' + id)).toBeNull()
	})
})

describe('good to know answers (#325)', () => {
	const facts = {
		currency: 'USD',
		deliveryZoneNames: ['Downtown'],
		deliveryFeeMinor: 1_500,
	}
	const options = { locale: 'en', defaultLocale: 'en', facts }

	it('hides unanswered typed questions and fills setting-backed ones', () => {
		const entries = buildCateringQnA(
			settingsWith({
				noticeHours: 48,
				fulfillments: { pickup: true, delivery: false },
			}),
			options,
		)
		expect(entries.map((e) => e.id)).toEqual(['notice', 'delivery'])
		expect(entries[0]?.answer).toContain('48 hours')
		expect(entries[1]?.answer).toBe('Catering is for pickup only.')
	})

	it('shows typed answers and custom questions, localized', () => {
		const settings = settingsWith({
			minMinor: 25_000,
			maxGuests: 80,
			deposit: {
				percent: 30,
				balanceDueDaysBeforeEvent: 3,
				reminderDaysBeforeDue: 2,
				cancellationNote: {
					en: 'Cancel 48 hours ahead for a refund.',
					ar: 'ألغِ قبل 48 ساعة.',
				},
			},
			questions: {
				standard: {
					cutlery: { en: 'Yes, we bring plates and cutlery.', ar: 'نعم.' },
				},
				custom: [
					{
						id: 'parking',
						question: { en: 'Is there parking?' },
						answer: { en: 'Free parking at the back.' },
					},
				],
			},
		})
		const en = buildCateringQnA(settings, options)
		expect(en.find((e) => e.id === 'cutlery')?.answer).toBe(
			'Yes, we bring plates and cutlery.',
		)
		expect(en.find((e) => e.id === 'minimum')?.answer).toContain('$250.00')
		expect(en.find((e) => e.id === 'deposit')?.answer).toContain('30% deposit')
		expect(en.find((e) => e.id === 'deposit')?.answer).toContain(
			'Cancel 48 hours ahead',
		)
		expect(en.at(-1)).toMatchObject({
			id: 'parking',
			source: 'custom',
			answer: 'Free parking at the back.',
		})
		const ar = buildCateringQnA(settings, { ...options, locale: 'ar' })
		expect(ar.find((e) => e.id === 'cutlery')?.answer).toBe('نعم.')
		// A typed answer with no Arabic copy falls back to the default locale.
		expect(ar.at(-1)?.answer).toBe('Free parking at the back.')
	})

	it('changing the minimum notice updates the matching answer', () => {
		const before = buildCateringQnA(settingsWith({ noticeHours: 48 }), options)
		const after = buildCateringQnA(settingsWith({ noticeHours: 72 }), options)
		expect(before.find((e) => e.id === 'notice')?.answer).toContain('48 hours')
		expect(after.find((e) => e.id === 'notice')?.answer).toContain('72 hours')
	})

	it('makes FAQ structured data and phone agent text from the same entries', () => {
		const entries = buildCateringQnA(settingsWith({ noticeHours: 24 }), options)
		const ld = cateringFaqJsonLd(entries)
		expect(ld).toMatchObject({ '@type': 'FAQPage' })
		expect(JSON.stringify(ld)).toContain('24 hours')
		expect(cateringKnowledgeText(entries)).toContain(
			'We need at least 24 hours of notice.',
		)
		expect(cateringFaqJsonLd([])).toBeNull()
	})
})
