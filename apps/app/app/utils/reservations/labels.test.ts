import { describe, expect, it } from 'vitest'
import {
	clientLabel,
	CONTACT_STATUS_LABELS,
	enumLabel,
	humanizeEnum,
	RESERVATION_STATUS_LABELS,
	stripTagPrefix,
} from './labels.ts'

describe('reservation labels', () => {
	const translate = (d: { message?: string; id?: string }) =>
		`T:${d.message ?? d.id}`

	it('translates known enums and humanizes unknown values', () => {
		expect(enumLabel(translate, RESERVATION_STATUS_LABELS, 'seated')).toMatch(
			/^T:/,
		)
		expect(enumLabel(translate, RESERVATION_STATUS_LABELS, 'half_done')).toBe(
			'Half done',
		)
		expect(enumLabel(translate, RESERVATION_STATUS_LABELS, null)).toBe('')
	})

	it('keys contact statuses on the canonical left_message | no_answer | wrong_number values', () => {
		expect(Object.keys(CONTACT_STATUS_LABELS).sort()).toEqual([
			'left_message',
			'no_answer',
			'none',
			'not_contacted',
			'wrong_number',
		])
		for (const value of ['left_message', 'no_answer', 'wrong_number']) {
			const label = enumLabel(translate, CONTACT_STATUS_LABELS, value)
			expect(label).toMatch(/^T:/)
		}
	})

	it('strips the org prefix from tag ids', () => {
		expect(stripTagPrefix('tag_acme_birthday')).toBe('birthday')
		expect(humanizeEnum('tag_acme_window_seat')).toBe('Window seat')
	})
})

describe('clientLabel', () => {
	const translate = (d: { message?: string; id?: string }) =>
		`T:${d.message ?? d.id}`

	it('translates the recorded X-Client values', () => {
		expect(clientLabel(translate, 'web')).toBe('T:Web')
		expect(clientLabel(translate, 'ios')).toBe('T:iOS app')
		expect(clientLabel(translate, 'android')).toBe('T:Android app')
	})

	it('shows an unknown value exactly as received and nothing when empty', () => {
		expect(clientLabel(translate, 'kiosk_v2')).toBe('kiosk_v2')
		expect(clientLabel(translate, null)).toBe('')
	})
})
