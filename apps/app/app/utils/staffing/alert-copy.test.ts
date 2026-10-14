import { i18n } from '@lingui/core'
import { MANAGER_ALERT_KINDS } from '@repo/staffing'
import { beforeAll, describe, expect, it } from 'vitest'
import { staffingAlertCopy } from './alert-copy.ts'

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const translate = (message: { id: string; message: string }) =>
	i18n._(message as never)

describe('time clock alert wording', () => {
	it('says how many people, with the right singular and plural', () => {
		expect(staffingAlertCopy('no_clock_in', 1, translate).subject).toBe(
			'1 person has not clocked in',
		)
		expect(staffingAlertCopy('no_clock_in', 3, translate).subject).toBe(
			'3 people have not clocked in',
		)
		expect(staffingAlertCopy('overtime_reached', 2, translate).subject).toBe(
			'2 people have reached overtime',
		)
	})

	it('has a subject and a next step for every kind, and names nobody', () => {
		for (const kind of MANAGER_ALERT_KINDS) {
			const copy = staffingAlertCopy(kind, 2, translate)
			expect(copy.subject.length).toBeGreaterThan(5)
			expect(copy.body.length).toBeGreaterThan(5)
			expect(`${copy.subject}${copy.body}`).not.toMatch(/undefined|NaN|\{/)
		}
	})

	it('treats a missing or odd count as one rather than showing nonsense', () => {
		for (const count of [Number.NaN, 0, -3, 0.4]) {
			expect(
				staffingAlertCopy('missed_clock_out', count, translate).subject,
			).toMatch(/^1 person/)
		}
	})
})
