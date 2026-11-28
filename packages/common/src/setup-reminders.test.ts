import { describe, expect, it } from 'vitest'
import {
	SETUP_STEP_COPY,
	setupReminderCopy,
	setupReminderLocale,
} from './setup-reminders.ts'

describe('setup reminder copy (#271)', () => {
	it('names the step in plain words with its time and the progress', () => {
		const copy = setupReminderCopy({
			locale: 'en',
			organizationName: 'Acme Grill',
			stepKey: 'launch_location_details',
			done: 4,
			total: 7,
		})
		expect(copy.heading).toBe(
			'Add your address and opening hours, about 3 minutes',
		)
		expect(copy.progress).toBe('4 of 7 done')
		expect(copy.subject).toBe(
			'Next step for Acme Grill: Add your address and opening hours',
		)
		expect(copy.dir).toBe('ltr')
	})

	it('is written in Arabic, right to left, for an Arabic organization', () => {
		const copy = setupReminderCopy({
			locale: setupReminderLocale('ar-SA'),
			organizationName: 'مطعم النخيل',
			stepKey: 'launch_go_live',
			done: 5,
			total: 6,
		})
		expect(copy.dir).toBe('rtl')
		expect(copy.heading).toContain('انشر موقعك')
		expect(copy.progress).toBe('5 من 6 مكتملة')
		expect(copy.actionLabel).toBe('أكمل الإعداد')
	})

	it('has a sentence and a time for every required launch step, and falls back for an unknown one', () => {
		for (const [key, step] of Object.entries(SETUP_STEP_COPY)) {
			expect(step.en.length, key).toBeGreaterThan(10)
			expect(step.ar.length, key).toBeGreaterThan(5)
			expect(step.minutes, key).toBeGreaterThan(0)
		}
		expect(
			setupReminderCopy({
				locale: 'en',
				organizationName: 'A',
				stepKey: 'nope',
				done: 0,
				total: 1,
			}).heading,
		).toContain('Finish your setup')
	})

	it('never holds a number, a person or a guest', () => {
		const text = JSON.stringify(
			setupReminderCopy({
				locale: 'en',
				organizationName: 'Acme',
				stepKey: 'launch_menu',
				done: 1,
				total: 6,
			}),
		)
		expect(text).not.toMatch(/guest|customer|order #|\$/i)
	})
})
