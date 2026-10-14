import { describe, expect, it } from 'vitest'
import {
	renderApplicantEmail,
	type ApplicantEmailInput,
} from './applicant-email.ts'

const base: Omit<ApplicantEmailInput, 'kind'> = {
	locale: 'en',
	firstName: 'Sara',
	organizationName: 'Acme Kitchen',
	postingTitle: 'Line cook',
	scopeName: 'Downtown',
	timeZone: 'America/Chicago',
	interview: {
		scheduledAt: Date.UTC(2026, 9, 16, 19, 30),
		durationMinutes: 45,
		mode: 'in_person',
		details: 'Ask for Hana',
		rescheduled: false,
	},
}

describe('renderApplicantEmail', () => {
	it('keeps the subject on one line whatever the posting title holds', () => {
		const mail = renderApplicantEmail({
			...base,
			kind: 'interview_invite',
			postingTitle: 'Line cook\r\nBcc: victim@example.com',
			organizationName: 'Acme\nKitchen',
		})
		expect(mail.subject).not.toMatch(/[\r\n]/)
		expect(mail.subject).toBe('Interview for Line cook Bcc: victim@example.com')
	})

	it('invites with the time in the scope zone, the length and the details', () => {
		const mail = renderApplicantEmail({ ...base, kind: 'interview_invite' })
		expect(mail.subject).toBe('Interview for Line cook')
		expect(mail.text).toMatch(/2:30\s?PM/)
		expect(mail.text).toContain('45 min')
		expect(mail.text).toContain('In person (Downtown)')
		expect(mail.text).toContain('Ask for Hana')
		expect(mail.text).toContain('Acme Kitchen')
		expect(mail.html).toContain('lang="en"')
	})

	it('says when an interview has moved or been cancelled', () => {
		expect(
			renderApplicantEmail({
				...base,
				kind: 'interview_invite',
				interview: { ...base.interview!, rescheduled: true },
			}).subject,
		).toContain('has moved')
		expect(
			renderApplicantEmail({ ...base, kind: 'interview_cancelled' }).subject,
		).toContain('cancelled')
	})

	it.each(['thanks', 'position_filled', 'keep_on_file'] as const)(
		'declines politely with the %s template',
		(template) => {
			const mail = renderApplicantEmail({ ...base, kind: 'decline', template })
			expect(mail.subject).toBe('Your application for Line cook')
			expect(mail.text).toContain('Hi Sara,')
			expect(mail.text).not.toMatch(/score|dealbreaker|screener|flag/i)
			if (template === 'position_filled') expect(mail.text).toContain('filled')
			if (template === 'keep_on_file') expect(mail.text).toContain('on file')
		},
	)

	it('is written right to left in Arabic', () => {
		const mail = renderApplicantEmail({
			...base,
			locale: 'ar',
			kind: 'interview_invite',
		})
		expect(mail.html).toContain('dir="rtl"')
		expect(mail.html).toContain('lang="ar"')
		expect(mail.text).toContain('مرحبًا Sara')
		expect(mail.text).toContain('حضوريًا')
	})

	it('escapes every dynamic value and links nothing', () => {
		const mail = renderApplicantEmail({
			...base,
			kind: 'interview_invite',
			firstName: '<b>Sara</b>',
			organizationName: 'A&B <i>',
			postingTitle: '<script>x</script>',
			interview: { ...base.interview!, details: '"><img src=x>' },
		})
		expect(mail.html).not.toContain('<script>')
		expect(mail.html).not.toContain('<img')
		expect(mail.html).not.toContain('<b>Sara')
		expect(mail.html).not.toMatch(/<a /)
	})

	it('falls back to a safe generic line when an interview has no details to show', () => {
		const mail = renderApplicantEmail({
			...base,
			kind: 'interview_invite',
			interview: undefined,
		})
		expect(mail.subject).toBe('An update on your application')
	})
})
