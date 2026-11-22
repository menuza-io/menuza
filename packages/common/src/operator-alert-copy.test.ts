import { describe, expect, it } from 'vitest'
import {
	alertCopy,
	alertLocale,
	alertSmsText,
	formatAlertMoney,
	type AlertSubject,
} from './operator-alert-copy.ts'

const GUEST_STRINGS = [
	'Layla Hassan',
	'+966501234567',
	'layla@example.com',
	'Al Olaya St',
	'no onions',
]

const subjects: AlertSubject[] = [
	{
		kind: 'orders_new',
		orderNumber: 'W-0042',
		fulfillment: 'pickup',
		scheduledForMs: Date.UTC(2026, 10, 21, 15, 45),
		totalCents: 3850,
		currency: 'SAR',
		dishCount: 4,
		large: true,
	},
	{
		kind: 'orders_large',
		orderNumber: 'W-0043',
		fulfillment: 'delivery',
		scheduledForMs: null,
		totalCents: 98000,
		currency: 'SAR',
		dishCount: 20,
		soon: false,
	},
	{ kind: 'orders_waiting', orderNumbers: ['W-1', 'W-2', 'W-3', 'W-4'] },
	{
		kind: 'orders_due_soon',
		orderNumbers: ['W-9'],
		dueAtMs: Date.UTC(2026, 10, 21, 16, 0),
	},
	{ kind: 'orders_payment_review', orderNumber: 'W-7' },
	{ kind: 'ordering_paused_long', mode: 'paused', hours: 2 },
	{
		kind: 'station_offline',
		label: 'Kitchen',
		state: 'offline',
		minutes: 5,
		allKitchenOffline: false,
		waitingOrderNumber: null,
	},
	{
		kind: 'station_offline',
		label: 'Kitchen',
		state: 'offline',
		minutes: 6,
		allKitchenOffline: true,
		waitingOrderNumber: 'W-8',
	},
	{
		kind: 'station_offline',
		label: 'Kitchen',
		state: 'back_online',
		minutes: 9,
		allKitchenOffline: false,
		waitingOrderNumber: null,
	},
]

describe('alert copy', () => {
	for (const locale of ['en', 'ar'] as const) {
		it(`is built only from facts, never a guest (${locale}, KSA location)`, () => {
			for (const subject of subjects) {
				const copy = alertCopy(subject, {
					locale,
					locationName: 'Riyadh Olaya',
					timeZone: 'Asia/Riyadh',
				})
				const all = JSON.stringify(copy)
				for (const guest of GUEST_STRINGS) expect(all).not.toContain(guest)
				expect(copy.title.length).toBeGreaterThan(0)
				expect(copy.title.length).toBeLessThanOrEqual(65)
				expect(copy.body.length).toBeLessThanOrEqual(178)
			}
		})
	}

	it('says the order number, type, time and total for a new order', () => {
		const copy = alertCopy(subjects[0]!, {
			locale: 'en',
			locationName: 'Downtown',
			timeZone: 'Asia/Riyadh',
		})
		expect(copy.title).toBe('New order W-0042')
		expect(copy.body).toContain('Pickup 6:45 PM')
		expect(copy.body).toContain('Large order')
		expect(copy.body).toContain('Downtown')
		expect(copy.body).toMatch(/SAR|ر\.س/)
	})

	it('marks a test order TEST', () => {
		const copy = alertCopy(subjects[0]!, { locale: 'en', test: true })
		expect(copy.title.startsWith('TEST')).toBe(true)
	})

	it('names several waiting orders once, capped', () => {
		const copy = alertCopy(subjects[2]!, {
			locale: 'en',
			locationName: 'Downtown',
		})
		expect(copy.title).toBe('4 orders are waiting')
		expect(copy.body).toContain('W-1, W-2, W-3 +1')
	})

	it('has its own words for the critical tablet case and for recovery', () => {
		expect(alertCopy(subjects[7]!, { locale: 'en' }).title).toBe(
			'Every kitchen tablet is offline',
		)
		expect(alertCopy(subjects[8]!, { locale: 'en' }).title).toBe(
			'Kitchen is back online',
		)
		expect(
			alertCopy(subjects[6]!, { locale: 'en', locationName: 'Downtown' }).title,
		).toBe('Kitchen has been offline for 5 minutes')
	})

	it('picks Arabic for ar locales and formats money in the currency', () => {
		expect(alertLocale('ar-SA')).toBe('ar')
		expect(alertLocale('en-US')).toBe('en')
		expect(alertLocale(null)).toBe('en')
		expect(formatAlertMoney(3850, 'USD', 'en')).toBe('$38.50')
		expect(formatAlertMoney(1000, 'JPY', 'en')).toContain('1,000')
	})

	it('ends a text with the opt-out phrase and the link', () => {
		const text = alertSmsText(
			alertCopy(subjects[0]!, { locale: 'en' }),
			'https://app.example/acme/orders',
		)
		expect(text).toContain('https://app.example/acme/orders')
		expect(text.endsWith('Reply STOP to opt out.')).toBe(true)
	})
})
