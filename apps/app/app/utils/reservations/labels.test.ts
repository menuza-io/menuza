import { describe, expect, it } from 'vitest'
import {
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

	it('strips the org prefix from tag ids', () => {
		expect(stripTagPrefix('tag_acme_birthday')).toBe('birthday')
		expect(humanizeEnum('tag_acme_window_seat')).toBe('Window seat')
	})
})
