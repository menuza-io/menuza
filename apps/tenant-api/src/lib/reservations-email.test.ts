import { describe, expect, it } from 'vitest'
import {
	buildCalendarUrl,
	escapeHtml,
	formatWhen,
	normalizeReservationLocale,
	renderReservationEmail,
	type ReservationEmailInput,
	type ReservationEmailTheme,
} from './reservations-email.ts'
import {
	TOGGLEABLE_MESSAGE_KINDS,
	type ToggleableMessageKind,
} from './reservations-messaging-settings.ts'

const THEME: ReservationEmailTheme = {
	organizationName: 'Acme Bistro',
	logoUrl: null,
	appUrl: 'https://app.menuza.test',
	background: '#fafafa',
	card: '#f1f2f3',
	foreground: '#101112',
	muted: '#f3f4f6',
	mutedForeground: '#6b7280',
	border: '#d1d2d3',
	primary: '#123abc',
	primaryForeground: '#fefefe',
	accent: '#2563eb',
	accentForeground: '#ffffff',
	radius: 10,
	headingFont: 'Georgia, serif',
	bodyFont: 'Inter, sans-serif',
}

// 2031-06-14 19:30 UTC is 15:30 in New York and 22:30 in Riyadh.
const WHEN = Date.UTC(2031, 5, 14, 19, 30)
const MANAGE = 'https://acme.menuza.test/reserve/manage#t=tok.123'
const STATUS = 'https://acme.menuza.test/reserve/waitlist#t=wl.456'
const BOOK = 'https://acme.menuza.test/reserve'
const CALENDAR = 'https://calendar.google.com/calendar/render?action=TEMPLATE'

function input(
	kind: ToggleableMessageKind,
	patch: Partial<ReservationEmailInput> = {},
): ReservationEmailInput {
	return {
		kind,
		locale: 'en',
		theme: THEME,
		restaurantName: 'Acme Downtown',
		address: '100 Main St, New York',
		phone: '+12125550100',
		firstName: 'Rana',
		whenMs: WHEN,
		timeZone: 'America/New_York',
		partySize: 4,
		manageUrl: MANAGE,
		statusUrl: STATUS,
		bookUrl: BOOK,
		calendarUrl: CALENDAR,
		quotedWaitMin: 25,
		customNote: null,
		...patch,
	}
}

const ATTACK = `<script>alert("x")</script><img src=x onerror=alert(1)> & 'q'`

describe('locale and formatting helpers', () => {
	it('keeps every site language and falls back only for unknown values', () => {
		expect(normalizeReservationLocale('ar')).toBe('ar')
		expect(normalizeReservationLocale('AR-SA')).toBe('ar')
		expect(normalizeReservationLocale('en')).toBe('en')
		expect(normalizeReservationLocale('fr')).toBe('fr')
		expect(normalizeReservationLocale('es_MX')).toBe('es')
		expect(normalizeReservationLocale('de')).toBe('de')
		expect(normalizeReservationLocale('zh-CN')).toBe('zh')
		expect(normalizeReservationLocale('xx')).toBe('en')
		expect(normalizeReservationLocale('xx', 'ar')).toBe('ar')
		expect(normalizeReservationLocale('')).toBe('en')
		expect(normalizeReservationLocale(undefined)).toBe('en')
		expect(normalizeReservationLocale(42)).toBe('en')
	})

	it('escapes the five HTML metacharacters', () => {
		expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
			'&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
		)
	})

	it('formats the time in the location zone and falls back to UTC for a bad zone', () => {
		expect(formatWhen(WHEN, 'America/New_York', 'en').time).toMatch(/3:30\s?PM/)
		expect(formatWhen(WHEN, 'Asia/Riyadh', 'en').time).toMatch(/10:30\s?PM/)
		expect(formatWhen(WHEN, 'Not/AZone', 'en').time).toMatch(/7:30\s?PM/)
		expect(formatWhen(WHEN, null, 'en').time).toMatch(/7:30\s?PM/)
		expect(formatWhen(WHEN, 'UTC', 'en').date).toContain('2031')
	})

	it('keeps Latin digits in Arabic dates and times', () => {
		const when = formatWhen(WHEN, 'UTC', 'ar')
		expect(`${when.date} ${when.time}`).toMatch(/2031/)
		expect(`${when.date} ${when.time}`).not.toMatch(/[\u0660-\u0669]/)
	})

	it('builds a calendar link from facts only', () => {
		const url = new URL(
			buildCalendarUrl({
				title: 'Acme & Sons',
				startMs: WHEN,
				endMs: WHEN + 90 * 60_000,
				location: '100 Main St',
			}),
		)
		expect(url.origin).toBe('https://calendar.google.com')
		expect(url.searchParams.get('action')).toBe('TEMPLATE')
		expect(url.searchParams.get('text')).toBe('Acme & Sons')
		expect(url.searchParams.get('dates')).toBe(
			'20310614T193000Z/20310614T210000Z',
		)
		expect(url.searchParams.get('location')).toBe('100 Main St')
		expect(url.href).not.toMatch(/#t=|token/i)
	})
})

describe('renderReservationEmail: kinds and languages', () => {
	it('covers exactly the 12 toggleable kinds', () => {
		expect(TOGGLEABLE_MESSAGE_KINDS).toHaveLength(12)
	})

	describe.each(TOGGLEABLE_MESSAGE_KINDS)('%s', (kind) => {
		it('renders a distinct English subject, a full document and a text part', () => {
			const mail = renderReservationEmail(input(kind))
			expect(mail.subject).toContain('Acme Downtown')
			expect(mail.html.startsWith('<!doctype html>')).toBe(true)
			expect(mail.html).toContain('<html lang="en" dir="ltr">')
			expect(mail.html).toContain('<title>')
			expect(mail.text.length).toBeGreaterThan(20)
			expect(mail.text).toContain('Acme Downtown')
			expect(mail.html).not.toContain('undefined')
			expect(mail.text).not.toContain('undefined')
		})

		it('renders Arabic right to left with Arabic copy', () => {
			const mail = renderReservationEmail(input(kind, { locale: 'ar' }))
			expect(mail.html).toContain('<html lang="ar" dir="rtl">')
			expect(mail.html).toContain('<body dir="rtl"')
			expect(mail.html).toContain('text-align:right')
			expect(mail.html).not.toContain('text-align:left')
			expect(mail.html).toMatch(/[\u0600-\u06FF]/)
			expect(mail.subject).toMatch(/[\u0600-\u06FF]/)
			expect(mail.subject).toContain('Acme Downtown')
			expect(mail.html).not.toContain('undefined')
		})
	})

	it('gives every kind its own English subject', () => {
		const subjects = TOGGLEABLE_MESSAGE_KINDS.map(
			(kind) => renderReservationEmail(input(kind)).subject,
		)
		expect(new Set(subjects).size).toBe(TOGGLEABLE_MESSAGE_KINDS.length)
	})

	it('renders a non-English, non-Arabic site language in its own words', () => {
		const mail = renderReservationEmail(input('confirmation', { locale: 'fr' }))
		expect(mail.html).toContain('<html lang="fr" dir="ltr">')
		expect(mail.subject).toBe(
			'Votre réservation chez Acme Downtown est confirmée',
		)
	})

	it('falls back to English for a language that is not a site language', () => {
		const mail = renderReservationEmail(input('confirmation', { locale: 'xx' }))
		expect(mail.html).toContain('<html lang="en" dir="ltr">')
		expect(mail.subject).toBe('Your reservation at Acme Downtown is confirmed')
	})

	it('shows the booking facts, in the location time zone', () => {
		const mail = renderReservationEmail(input('confirmation'))
		expect(mail.html).toContain('Rana')
		expect(mail.html).toContain('Party size')
		expect(mail.html).toContain('>4<')
		expect(mail.html).toContain('100 Main St, New York')
		expect(mail.html).toContain('+12125550100')
		expect(mail.html).toMatch(/3:30\s?PM/)
		expect(mail.html).toContain('Saturday, June 14, 2031')
		expect(mail.text).toContain('Party size: 4')
	})

	it('omits rows it has no value for and greets an unnamed guest', () => {
		const mail = renderReservationEmail(
			input('confirmation', {
				address: null,
				phone: null,
				whenMs: null,
				partySize: null,
				firstName: '  ',
			}),
		)
		expect(mail.html).not.toContain('Address')
		expect(mail.html).not.toContain('Phone')
		expect(mail.html).not.toContain('Party size')
		expect(mail.html).not.toContain('>Date<')
		expect(mail.html).toContain('Hi there')
		const ar = renderReservationEmail(
			input('confirmation', { locale: 'ar', firstName: null }),
		)
		expect(ar.html).toContain('ضيفنا')
	})

	it('adds the quoted wait to the waitlist join message in both languages', () => {
		const en = renderReservationEmail(input('waitlist_joined'))
		expect(en.html).toContain('Estimated wait: 25 min.')
		const ar = renderReservationEmail(
			input('waitlist_joined', { locale: 'ar' }),
		)
		expect(ar.html).toContain('25 دقيقة')
		const none = renderReservationEmail(
			input('waitlist_joined', { quotedWaitMin: null }),
		)
		expect(none.html).not.toContain('Estimated wait')
	})
})

describe('renderReservationEmail: links', () => {
	it('puts the manage link, with its token in the URL fragment, on manage kinds', () => {
		for (const kind of [
			'confirmation',
			'modification',
			'reminder',
			'request_received',
			'request_approved',
			'reconfirm_request',
		] as const) {
			const mail = renderReservationEmail(input(kind))
			expect(mail.html, kind).toContain(`href="${MANAGE}"`)
			expect(mail.text, kind).toContain(MANAGE)
			const url = new URL(MANAGE)
			expect(url.hash).toBe('#t=tok.123')
			expect(url.pathname + url.search).not.toContain('tok.123')
		}
	})

	it('sends waitlist kinds to the status link and notify-me to the booking page', () => {
		for (const kind of ['waitlist_joined', 'waitlist_ready'] as const) {
			const mail = renderReservationEmail(input(kind))
			expect(mail.html).toContain(`href="${STATUS}"`)
			expect(mail.html).not.toContain(MANAGE)
		}
		const notify = renderReservationEmail(input('notify_available'))
		expect(notify.html).toContain(`href="${BOOK}"`)
		expect(notify.html).not.toContain(MANAGE)
		expect(notify.html).not.toContain(STATUS)
	})

	it('names the available date and time, restaurant-local, in notify-me email', () => {
		const mail = renderReservationEmail(input('notify_available'))
		expect(mail.text).toContain('opened up on Saturday, June 14, 2031 at 3:30')
		expect(mail.html).toContain('Saturday, June 14, 2031')
		const riyadh = renderReservationEmail(
			input('notify_available', { timeZone: 'Asia/Riyadh' }),
		)
		expect(riyadh.text).toContain('at 10:30')
		const slotLink = `${BOOK}?location=loc&party=4&date=2031-06-14&time=15%3A30`
		const linked = renderReservationEmail(
			input('notify_available', { bookUrl: slotLink }),
		)
		expect(linked.html).toContain(`href="${slotLink.replace(/&/g, '&amp;')}"`)
		const ar = renderReservationEmail(
			input('notify_available', { locale: 'ar' }),
		)
		expect(ar.text).toContain('بتاريخ')
		const undated = renderReservationEmail(
			input('notify_available', { whenMs: null }),
		)
		expect(undated.text).toContain('just opened up')
	})

	it('has no button on the kinds that end the conversation', () => {
		for (const kind of [
			'cancellation_guest',
			'cancellation_restaurant',
			'request_declined',
		] as const) {
			const mail = renderReservationEmail(input(kind))
			expect(mail.html, kind).not.toContain('<a ')
			expect(mail.text, kind).not.toContain('https://')
		}
	})

	it('adds the calendar link only to confirmation, modification, approval and reminder', () => {
		for (const kind of TOGGLEABLE_MESSAGE_KINDS) {
			const mail = renderReservationEmail(input(kind))
			const has = mail.html.includes('Add to calendar')
			const expected = [
				'confirmation',
				'modification',
				'request_approved',
				'reminder',
			].includes(kind)
			expect(has, kind).toBe(expected)
			expect(mail.html.includes(escapeHtml(CALENDAR)), kind).toBe(expected)
		}
		const ar = renderReservationEmail(input('confirmation', { locale: 'ar' }))
		expect(ar.html).toContain('أضف إلى التقويم')
	})

	it('drops links that are not http(s) or do not parse', () => {
		for (const bad of [
			'javascript:alert(1)',
			'data:text/html;base64,AAAA',
			'//evil.test/x',
			'not a url',
			'',
		]) {
			const mail = renderReservationEmail(
				input('confirmation', { manageUrl: bad, calendarUrl: bad }),
			)
			expect(mail.html, bad).not.toContain('<a ')
			expect(mail.html, bad).not.toContain('javascript:')
		}
	})

	it('escapes a link before it goes into an attribute', () => {
		const mail = renderReservationEmail(
			input('confirmation', {
				manageUrl: 'https://acme.test/m?a=1&b="><script>x</script>#t=1',
			}),
		)
		expect(mail.html).not.toContain('<script>')
		expect(mail.html).not.toMatch(/href="[^"]*"[^>]*><script/)
		expect(mail.html).toContain('&amp;b=')
	})
})

describe('renderReservationEmail: escaping', () => {
	it.each(TOGGLEABLE_MESSAGE_KINDS)(
		'%s escapes every dynamic value in HTML',
		(kind) => {
			const mail = renderReservationEmail(
				input(kind, {
					restaurantName: ATTACK,
					firstName: ATTACK,
					address: ATTACK,
					phone: ATTACK,
					customNote: ATTACK,
					theme: { ...THEME, organizationName: ATTACK },
				}),
			)
			expect(mail.html).not.toContain('<script>')
			expect(mail.html).not.toContain('<img src=x')
			expect(mail.html).not.toContain('onerror=alert(1)>')
			expect(mail.html).toContain('&lt;script&gt;')
			expect(mail.html).not.toMatch(/alert\("x"\)/)
			expect(mail.html).toContain('&quot;')
			expect(mail.html).toContain('&#39;q&#39;')
		},
	)

	it('escapes the note, keeps its line breaks and labels it', () => {
		const mail = renderReservationEmail(
			input('confirmation', {
				customNote:
					'  Please <b>park</b> behind the building.\r\nThank you & enjoy  ',
			}),
		)
		expect(mail.html).toContain('A note from the restaurant')
		expect(mail.html).toContain(
			'Please &lt;b&gt;park&lt;/b&gt; behind the building.<br>Thank you &amp; enjoy',
		)
		expect(mail.html).not.toContain('<b>park</b>')
		expect(mail.text).toContain(
			'A note from the restaurant: Please <b>park</b>',
		)
	})

	it('renders the note in Arabic with its Arabic label and rtl direction', () => {
		const mail = renderReservationEmail(
			input('reminder', { locale: 'ar', customNote: 'يرجى الحضور مبكراً' }),
		)
		expect(mail.html).toContain('ملاحظة من المطعم')
		expect(mail.html).toContain('يرجى الحضور مبكراً')
		expect(mail.html).toContain('<html lang="ar" dir="rtl">')
	})

	it('omits the note block for an empty or blank note', () => {
		for (const customNote of [null, undefined, '', '   \n ']) {
			const mail = renderReservationEmail(input('confirmation', { customNote }))
			expect(mail.html).not.toContain('A note from the restaurant')
			expect(mail.text).not.toContain('A note from the restaurant')
		}
	})

	it('puts the escaped title in the head and the raw subject in the subject', () => {
		const mail = renderReservationEmail(
			input('confirmation', { restaurantName: 'Tom & <Jerry>' }),
		)
		expect(mail.subject).toBe('Your reservation at Tom & <Jerry> is confirmed')
		expect(mail.html).toContain(
			'<title>Your reservation at Tom &amp; &lt;Jerry&gt; is confirmed</title>',
		)
	})
})

describe('renderReservationEmail: organization theme', () => {
	it('uses the email theme hex colors, never CSS variables or oklch', () => {
		const mail = renderReservationEmail(input('confirmation'))
		expect(mail.html).toContain('background:#fafafa')
		expect(mail.html).toContain('background:#f1f2f3')
		expect(mail.html).toContain('color:#101112')
		expect(mail.html).toContain('border:1px solid #d1d2d3')
		expect(mail.html).toContain('background:#123abc;color:#fefefe')
		expect(mail.html).toContain('border-radius:10px')
		expect(mail.html).not.toContain('var(--')
		expect(mail.html).not.toContain('oklch')
	})

	it('replaces a color that is not a six digit hex with a safe default', () => {
		const mail = renderReservationEmail(
			input('confirmation', {
				theme: {
					...THEME,
					background: 'oklch(0.5 0.1 200)',
					card: 'var(--card)',
					primary: 'red;background:url(x)',
					primaryForeground: '#fff',
				},
			}),
		)
		expect(mail.html).not.toContain('oklch')
		expect(mail.html).not.toContain('var(--card)')
		expect(mail.html).not.toContain('url(x)')
		expect(mail.html).toContain('background:#ffffff')
		expect(mail.html).toContain('background:#111827;color:#ffffff')
	})

	it('clamps the radius and sanitizes fonts', () => {
		const wide = renderReservationEmail(
			input('confirmation', { theme: { ...THEME, radius: 400 } }),
		)
		expect(wide.html).toContain('border-radius:24px')
		expect(wide.html).not.toContain('border-radius:400px')
		const fonts = renderReservationEmail(
			input('confirmation', {
				theme: {
					...THEME,
					bodyFont: `Inter";}</style><script>alert(1)</script>`,
					headingFont: '',
				},
			}),
		)
		expect(fonts.html).not.toContain('<script>')
		expect(fonts.html).not.toContain('";}')
		expect(fonts.html).toContain('font-family:Arial, sans-serif')
	})

	it('shows the organization name, or its logo when it has an http(s) one', () => {
		const named = renderReservationEmail(input('confirmation'))
		expect(named.html).toContain('>Acme Bistro<')
		expect(named.html).not.toContain('<img')
		const logo = renderReservationEmail(
			input('confirmation', {
				theme: { ...THEME, logoUrl: 'https://cdn.acme.test/logo.png?a=1&b=2' },
			}),
		)
		expect(logo.html).toContain(
			'<img src="https://cdn.acme.test/logo.png?a=1&amp;b=2" alt="Acme Bistro"',
		)
		const bad = renderReservationEmail(
			input('confirmation', {
				theme: { ...THEME, logoUrl: 'javascript:alert(1)' },
			}),
		)
		expect(bad.html).not.toContain('<img')
		expect(bad.html).not.toContain('javascript:')
	})

	it('falls back to the restaurant name when the organization has none', () => {
		const mail = renderReservationEmail(
			input('confirmation', { theme: { ...THEME, organizationName: '' } }),
		)
		expect(mail.html).toMatch(/font-family:[^"]*">Acme Downtown<\/div>/)
	})
})
