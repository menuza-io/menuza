import { describe, expect, it } from 'vitest'
import { STAFF_OUTBOX_KINDS, type StaffOutboxKind } from '@repo/staffing'
import {
	escapeHtml,
	formatMinutes,
	normalizeStaffLocale,
	renderScheduleEmail,
	renderStaffEmail,
	type ScheduleEmailInput,
	type StaffEmailInput,
} from './staff-email.ts'

const START = Date.UTC(2026, 2, 2, 23, 0, 0) // 17:00 in Chicago

const PAYLOADS: Record<StaffOutboxKind, Record<string, unknown>> = {
	time_card_edited: {
		localDate: '2026-03-02',
		hoursDeltaMinutes: -90,
		action: 'update',
	},
	shift_reminder: { startAt: START, endAt: START + 4 * 3_600_000 },
	missed_clock_out_reminder: { clockInAt: START },
	auto_clock_out_notice: {
		clockInAt: START,
		clockOutAt: START + 8 * 3_600_000,
	},
	schedule_published: {
		publicationId: 'p1',
		scopeId: 'loc-1',
		weekStart: '2026-03-02',
		version: 1,
		mode: 'changed',
		changedShiftIds: [],
		removedShiftIds: [],
	},
}

function input(
	kind: StaffOutboxKind,
	patch: Partial<StaffEmailInput> = {},
): StaffEmailInput {
	return {
		kind,
		level: 'full',
		locale: 'en',
		firstName: 'Rana',
		scopeName: 'Downtown',
		timeZone: 'America/Chicago',
		payload: PAYLOADS[kind],
		...patch,
	}
}

describe('staff email templates', () => {
	it.each(STAFF_OUTBOX_KINDS)(
		'%s renders in both languages and both levels',
		(kind) => {
			for (const locale of ['en', 'ar'] as const) {
				for (const level of ['full', 'minimal'] as const) {
					const mail = renderStaffEmail(input(kind, { locale, level }))
					expect(mail.subject.length).toBeGreaterThan(3)
					expect(mail.subject.length).toBeLessThan(80)
					expect(mail.html).toContain(`lang="${locale}"`)
					expect(mail.html).toContain(
						locale === 'ar' ? 'dir="rtl"' : 'dir="ltr"',
					)
					expect(mail.text.length).toBeGreaterThan(20)
					// Nothing left unreplaced, and no template residue.
					expect(`${mail.subject}${mail.html}${mail.text}`).not.toMatch(
						/\{[a-zA-Z]+\}|undefined|NaN|\[object/,
					)
				}
			}
		},
	)

	it('names the place and the time in the scope time zone at the full level', () => {
		const mail = renderStaffEmail(input('shift_reminder'))
		expect(mail.subject).toMatch(/^Reminder: your shift starts at 5:00\sPM$/)
		expect(mail.text).toContain('Downtown')
		expect(mail.text).toMatch(/9:00\sPM/)
		expect(mail.text).toContain('Hi Rana,')
	})

	it('uses the zone of the scope, not the server', () => {
		const riyadh = renderStaffEmail(
			input('shift_reminder', { timeZone: 'Asia/Riyadh' }),
		)
		expect(riyadh.subject).toMatch(/2:00\sAM/)
	})

	it('says nothing identifying at the minimal level', () => {
		for (const kind of STAFF_OUTBOX_KINDS) {
			for (const locale of ['en', 'ar'] as const) {
				const mail = renderStaffEmail(input(kind, { level: 'minimal', locale }))
				const all = `${mail.subject}\n${mail.text}\n${mail.html}`
				for (const leak of [
					'Rana',
					'Downtown',
					'PM',
					'AM',
					'2026',
					'5:00',
					'90',
				]) {
					expect(all).not.toContain(leak)
				}
			}
		}
	})

	it('falls back to the generic line when a fact it needs is missing', () => {
		const mail = renderStaffEmail(input('shift_reminder', { payload: {} }))
		expect(mail.subject).toBe('An update about your time')
	})

	it('escapes every dynamic value', () => {
		const mail = renderStaffEmail(
			input('missed_clock_out_reminder', {
				firstName: '<img src=x onerror=alert(1)>',
				scopeName: '"><script>alert(2)</script>',
			}),
		)
		expect(mail.html).not.toContain('<img src=x')
		expect(mail.html).not.toContain('<script>')
		expect(mail.html).toContain('&lt;img src=x')
		expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
	})

	it('is plain hex-colored HTML with no scripts, remote images or CSS variables', () => {
		const mail = renderStaffEmail(input('auto_clock_out_notice'))
		expect(mail.html).not.toMatch(
			/oklch|var\(--|<script|<img|<link|@import|url\(/i,
		)
		expect(mail.html).toMatch(/#[0-9a-f]{6}/)
		expect(mail.html.length).toBeLessThan(6_000)
	})

	it('tells a person how their hours changed without any pay figure', () => {
		const mail = renderStaffEmail(input('time_card_edited'))
		expect(mail.text).toContain('-1 h 30 min')
		expect(mail.text).toContain('Mon, Mar 2')
		expect(mail.text).not.toMatch(/\$|USD|rate|pay/i)
	})

	it('formats durations and picks the locale conservatively', () => {
		expect(formatMinutes(90, 'en')).toBe('1 h 30 min')
		expect(formatMinutes(-30, 'en')).toBe('-30 min')
		expect(formatMinutes(120, 'en')).toBe('2 h')
		expect(formatMinutes(45, 'ar')).toBe('45 د')
		expect(normalizeStaffLocale('ar')).toBe('ar')
		expect(normalizeStaffLocale('ar-SA')).toBe('ar')
		expect(normalizeStaffLocale('en')).toBe('en')
		expect(normalizeStaffLocale('fr')).toBe('en')
		expect(normalizeStaffLocale(undefined)).toBe('en')
	})

	it('survives an unknown time zone', () => {
		const mail = renderStaffEmail(
			input('shift_reminder', { timeZone: 'Mars/Olympus' }),
		)
		expect(mail.subject).toMatch(/starts at/)
	})
})

describe('schedule email', () => {
	const MON_9 = Date.UTC(2026, 2, 2, 15, 0, 0) // 9:00 in Chicago
	const base: ScheduleEmailInput = {
		level: 'full',
		locale: 'en',
		firstName: 'Rana',
		scopeName: 'Downtown',
		timeZone: 'America/Chicago',
		weekStart: '2026-03-02',
		version: 1,
		mode: 'everyone',
		shifts: [
			{
				startsAt: MON_9,
				endsAt: MON_9 + 8 * 3_600_000,
				positionName: 'Cook',
				change: 'new',
			},
		],
		removed: [],
		linkUrl: 'https://app.example.com/my-schedule#r=us&t=slk1.o.l.abc',
	}

	it('lists the shifts in the scope zone, with the place, the week and a link', () => {
		const mail = renderScheduleEmail(base)
		expect(mail.subject).toBe('Your schedule is ready')
		expect(mail.text).toContain('Hi Rana,')
		expect(mail.text).toContain('Downtown')
		expect(mail.text).toContain('week of Mon, Mar 2 - Sun, Mar 8')
		expect(mail.text).toMatch(
			/Mon, Mar 2, 9:00\sAM - 5:00\sPM \(Cook\) \[new\]/,
		)
		expect(mail.text).toContain('View my schedule: https://app.example.com/')
		expect(mail.html).toContain(
			'href="https://app.example.com/my-schedule#r=us&amp;t=slk1.o.l.abc"',
		)
	})

	it('says "updated" after the first publication or in changed mode', () => {
		expect(renderScheduleEmail({ ...base, version: 2 }).subject).toBe(
			'Your schedule was updated',
		)
		expect(renderScheduleEmail({ ...base, mode: 'changed' }).subject).toBe(
			'Your schedule was updated',
		)
	})

	it('says nothing identifying at the minimal level but keeps the link', () => {
		for (const locale of ['en', 'ar'] as const) {
			const mail = renderScheduleEmail({ ...base, level: 'minimal', locale })
			const all = `${mail.subject}\n${mail.text}\n${mail.html}`
			for (const leak of [
				'Rana',
				'Downtown',
				'Cook',
				'AM',
				'PM',
				'2026',
				'9:00',
				'Mar',
			]) {
				expect(all).not.toContain(leak)
			}
			expect(mail.text).toContain('https://app.example.com/my-schedule')
		}
	})

	it('renders right to left in Arabic', () => {
		const mail = renderScheduleEmail({
			...base,
			locale: 'ar',
			firstName: 'رنا',
		})
		expect(mail.html).toContain('dir="rtl"')
		expect(mail.subject).toBe('جدولك جاهز')
		expect(mail.text).toContain('مرحبًا رنا')
	})

	it('lists removed shifts and says when there is nothing this week', () => {
		const removed = renderScheduleEmail({
			...base,
			shifts: [],
			removed: [
				{ startsAt: MON_9, endsAt: MON_9 + 4 * 3_600_000, positionName: null },
			],
		})
		expect(removed.text).toContain('You have no shifts this week.')
		expect(removed.text).toContain('No longer on your schedule:')
		expect(removed.text).toMatch(/9:00\sAM - 1:00\sPM/)
	})

	it('has no link rather than a broken one', () => {
		for (const linkUrl of [
			null,
			'javascript:alert(1)',
			'ftp://x',
			'https://a b',
		]) {
			const mail = renderScheduleEmail({ ...base, linkUrl })
			expect(mail.html).not.toContain('href=')
			expect(mail.text).not.toContain('View my schedule')
			expect(mail.text).toContain('check with your manager')
		}
	})

	it('escapes every dynamic value and never includes pay words', () => {
		const mail = renderScheduleEmail({
			...base,
			firstName: '<img src=x onerror=alert(1)>',
			scopeName: '"><script>alert(2)</script>',
			shifts: [{ ...base.shifts[0]!, positionName: '<b>Cook</b>' }],
		})
		expect(mail.html).not.toContain('<img src=x')
		expect(mail.html).not.toContain('<script>')
		expect(mail.html).not.toContain('<b>Cook')
		expect(mail.html).not.toMatch(/var\(--|oklch|<script|<img /)
	})

	it('has a generic fallback in the shared renderer that names no week or place', () => {
		const mail = renderStaffEmail(input('schedule_published'))
		expect(mail.subject).toBe('An update about your schedule')
		expect(`${mail.text}${mail.html}`).not.toMatch(/Downtown|Rana|2026|2000/)
	})
})
