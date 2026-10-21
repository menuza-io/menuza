import { i18n } from '@lingui/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { reservationAlertCopy } from './alert-copy.ts'
import { RESERVATION_ALERT_KINDS } from './manager-alerts.ts'

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const translate = (message: { id: string; message: string }) =>
	i18n._(message as never)

describe('reservations alert wording', () => {
	it('says how many, with the right singular and plural', () => {
		expect(
			reservationAlertCopy('large_party_request', 1, translate).subject,
		).toBe('1 large-party request is waiting')
		expect(
			reservationAlertCopy('large_party_request', 3, translate).subject,
		).toBe('3 large-party requests are waiting')
	})

	it('has a subject and a next step for every kind, and names nobody', () => {
		for (const kind of RESERVATION_ALERT_KINDS) {
			const copy = reservationAlertCopy(kind, 2, translate)
			expect(copy.subject).toMatch(/2/)
			expect(copy.body.length).toBeGreaterThan(5)
			expect(`${copy.subject}${copy.body}`).not.toMatch(/undefined|NaN|\{/)
		}
	})

	it('treats a missing or odd count as one', () => {
		for (const count of [Number.NaN, 0, -3, 0.4]) {
			expect(
				reservationAlertCopy('payment_failed', count, translate).subject,
			).toMatch(/^1 booking/)
		}
	})

	it('adds the location to the body only when one is given', () => {
		expect(
			reservationAlertCopy('large_party_request', 2, translate).body,
		).not.toContain('Location')
		expect(
			reservationAlertCopy('large_party_request', 2, translate, 'Downtown')
				.body,
		).toContain('Location: Downtown')
	})
})
