import {
	DEFAULT_SITE_LOCALES,
	getSiteLocaleDirection,
	isSiteContentLocale,
	type SiteContentLocale,
} from '@repo/common/site-locales'
import { type ReservationsContext } from '@repo/reservations'
import {
	fillCopy,
	messageCopyFor,
	type KindCopy,
	type PaymentEmailKind,
} from './reservations-copy/index.ts'
import { type ToggleableMessageKind } from './reservations-messaging-settings.ts'

export type { PaymentEmailKind }

/**
 * Guest reservation email as plain HTML strings: tenant-api also runs inside a
 * Durable Object, so there is no React here, and mail clients support neither
 * CSS variables nor `oklch()`, so colors are the hex values of the organization's
 * email theme. The shipped copy exists for every site language
 * (`reservations-copy/`), right-to-left languages render `dir="rtl"`. Every
 * dynamic value is escaped. The manage link
 * carries its capability token in the URL fragment, never the path or query.
 */

export type ReservationEmailLocale = SiteContentLocale
export type ReservationEmailTheme =
	ReservationsContext['organization']['emailTheme']

export type ReservationEmailInput = {
	kind: ToggleableMessageKind | PaymentEmailKind
	locale: string
	theme: ReservationEmailTheme
	restaurantName: string
	address?: string | null
	phone?: string | null
	firstName?: string | null
	/** Start of the booking, or the slot a waitlist or notify-me message is about. */
	whenMs?: number | null
	timeZone?: string | null
	partySize?: number | null
	manageUrl?: string | null
	/** Pay link for a fee the card on file could not cover. */
	payUrl?: string | null
	/** Amount of the payment, refund or fee, in minor units, with its currency. */
	amountMinor?: number | null
	currency?: string | null
	statusUrl?: string | null
	bookUrl?: string | null
	calendarUrl?: string | null
	quotedWaitMin?: number | null
	customNote?: string | null
}

export type RenderedReservationEmail = {
	subject: string
	html: string
	text: string
}

/**
 * A language the shipped copy exists for: any site language, regional tags
 * included (`ar-SA` is `ar`). Anything else gets the platform default; callers
 * that know the organization resolve the guest's language against its enabled
 * languages first (`resolveGuestLocale`).
 */
export function normalizeReservationLocale(
	value: unknown,
	fallback: ReservationEmailLocale = DEFAULT_SITE_LOCALES.defaultLocale,
): ReservationEmailLocale {
	if (typeof value !== 'string') return fallback
	const base = value.trim().toLowerCase().replace(/_/g, '-').split('-')[0]
	return base && isSiteContentLocale(base) ? base : fallback
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

function intlLocale(locale: ReservationEmailLocale): string {
	// Latin digits in Arabic too, so times and party sizes read the same everywhere.
	if (locale === 'ar') return 'ar-u-nu-latn'
	return locale === 'en' ? 'en-US' : locale
}

function safeZone(timeZone: string | null | undefined): string {
	if (!timeZone) return 'UTC'
	try {
		new Intl.DateTimeFormat('en-US', { timeZone })
		return timeZone
	} catch {
		return 'UTC'
	}
}

export function formatWhen(
	whenMs: number,
	timeZone: string | null | undefined,
	locale: ReservationEmailLocale,
): { date: string; time: string } {
	const zone = safeZone(timeZone)
	return {
		date: new Intl.DateTimeFormat(intlLocale(locale), {
			weekday: 'long',
			year: 'numeric',
			month: 'long',
			day: 'numeric',
			timeZone: zone,
		}).format(new Date(whenMs)),
		time: new Intl.DateTimeFormat(intlLocale(locale), {
			hour: 'numeric',
			minute: '2-digit',
			timeZone: zone,
		}).format(new Date(whenMs)),
	}
}

function safeColor(value: string, fallback: string): string {
	return /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback
}

function safeFont(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9 ,'-]/g, '').trim()
	return cleaned ? `${cleaned}, Arial, sans-serif` : 'Arial, sans-serif'
}

function safeUrl(value: string | null | undefined): string | null {
	if (!value) return null
	try {
		const url = new URL(value)
		return url.protocol === 'https:' || url.protocol === 'http:'
			? url.toString()
			: null
	} catch {
		return null
	}
}

/** An amount in minor units with its currency symbol; two decimals, as the providers charge them. */
export function formatMoney(
	amountMinor: number | null | undefined,
	currency: string | null | undefined,
	locale: ReservationEmailLocale,
): string {
	if (typeof amountMinor !== 'number' || !currency) return ''
	try {
		return new Intl.NumberFormat(intlLocale(locale), {
			style: 'currency',
			currency,
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		}).format(amountMinor / 100)
	} catch {
		return `${(amountMinor / 100).toFixed(2)} ${currency}`
	}
}

function formatWait(minutes: number, locale: ReservationEmailLocale): string {
	return `${Math.max(0, Math.round(minutes))} ${messageCopyFor(locale).labels.waitUnit}`
}

/** What the guest can click, by message kind. Language-independent. */
const EMAIL_CTA: Partial<
	Record<
		ToggleableMessageKind | PaymentEmailKind,
		'manage' | 'confirm' | 'status' | 'book' | 'pay'
	>
> = {
	confirmation: 'manage',
	modification: 'manage',
	reminder: 'manage',
	reconfirm_request: 'confirm',
	request_received: 'manage',
	request_approved: 'manage',
	waitlist_joined: 'status',
	waitlist_ready: 'status',
	notify_available: 'book',
	payment_received: 'manage',
	fee_action_required: 'pay',
}

/** Google Calendar template link: carries the booking facts, never a token. */
export function buildCalendarUrl(input: {
	title: string
	startMs: number
	endMs: number
	location?: string | null
}): string {
	const stamp = (ms: number) =>
		new Date(ms)
			.toISOString()
			.replace(/[-:]/g, '')
			.replace(/\.\d{3}/, '')
	const params = new URLSearchParams({
		action: 'TEMPLATE',
		text: input.title,
		dates: `${stamp(input.startMs)}/${stamp(input.endMs)}`,
	})
	if (input.location) params.set('location', input.location)
	return `https://calendar.google.com/calendar/render?${params.toString()}`
}

export function renderReservationEmail(
	input: ReservationEmailInput,
): RenderedReservationEmail {
	const locale = normalizeReservationLocale(input.locale)
	const copyset = messageCopyFor(locale)
	const labels = copyset.labels
	const when =
		typeof input.whenMs === 'number'
			? formatWhen(input.whenMs, input.timeZone, locale)
			: null
	const firstName = input.firstName?.trim() || labels.guestFallback
	const entry: KindCopy = copyset.kinds[input.kind]
	const values = {
		r: input.restaurantName,
		name: firstName,
		date: when?.date ?? '',
		time: when?.time ?? '',
		amount: formatMoney(input.amountMinor, input.currency, locale),
		waitSentence:
			typeof input.quotedWaitMin === 'number'
				? fillCopy(labels.emailWait, {
						wait: formatWait(input.quotedWaitMin, locale),
					})
				: '',
	}
	const copy = {
		subject: fillCopy(entry.subject, values),
		heading: fillCopy(entry.heading, values),
		lead: fillCopy(
			!when && entry.leadNoTime ? entry.leadNoTime : entry.lead,
			values,
		),
		cta: EMAIL_CTA[input.kind],
		ctaLabel: entry.ctaLabel,
	}

	const rows: Array<[string, string]> = [
		[labels.restaurant, input.restaurantName],
	]
	if (when) {
		rows.push([labels.date, when.date], [labels.time, when.time])
	}
	if (input.partySize) rows.push([labels.party, String(input.partySize)])
	if (input.address) rows.push([labels.address, input.address])
	if (input.phone) rows.push([labels.phone, input.phone])

	const ctaUrl = safeUrl(
		copy.cta === 'status'
			? input.statusUrl
			: copy.cta === 'book'
				? input.bookUrl
				: copy.cta === 'pay'
					? input.payUrl
					: input.manageUrl,
	)
	const calendarUrl =
		input.kind === 'confirmation' ||
		input.kind === 'modification' ||
		input.kind === 'request_approved' ||
		input.kind === 'reminder'
			? safeUrl(input.calendarUrl)
			: null

	const theme = input.theme
	const background = safeColor(theme.background, '#ffffff')
	const card = safeColor(theme.card, '#ffffff')
	const foreground = safeColor(theme.foreground, '#111827')
	const muted = safeColor(theme.mutedForeground, '#6b7280')
	const border = safeColor(theme.border, '#e5e7eb')
	const primary = safeColor(theme.primary, '#111827')
	const primaryForeground = safeColor(theme.primaryForeground, '#ffffff')
	const radius = Math.max(0, Math.min(24, Math.round(theme.radius || 8)))
	const bodyFont = safeFont(theme.bodyFont)
	const headingFont = safeFont(theme.headingFont)
	const dir = getSiteLocaleDirection(locale)
	const align = dir === 'rtl' ? 'right' : 'left'
	const logo = safeUrl(theme.logoUrl)

	const detailRows = rows
		.map(
			([label, value]) =>
				`<tr><td style="padding:6px 0;color:${muted};font-size:13px;text-align:${align};width:38%;vertical-align:top">${escapeHtml(label)}</td><td style="padding:6px 0;color:${foreground};font-size:15px;text-align:${align}" dir="auto">${escapeHtml(value)}</td></tr>`,
		)
		.join('')

	const note = input.customNote?.trim()
	const noteHtml = note
		? `<div style="margin-top:20px;padding:12px 14px;border:1px solid ${border};border-radius:${radius}px;text-align:${align}"><div style="font-size:12px;color:${muted};margin-bottom:4px">${escapeHtml(labels.note)}</div><div style="font-size:14px;color:${foreground}" dir="auto">${escapeHtml(note).replace(/\r?\n/g, '<br>')}</div></div>`
		: ''

	const ctaHtml =
		ctaUrl && copy.ctaLabel
			? `<div style="margin-top:24px;text-align:${align}"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:12px 22px;background:${primary};color:${primaryForeground};text-decoration:none;border-radius:${radius}px;font-size:15px;font-weight:600">${escapeHtml(copy.ctaLabel)}</a></div>`
			: ''
	const calendarHtml = calendarUrl
		? `<div style="margin-top:14px;text-align:${align}"><a href="${escapeHtml(calendarUrl)}" style="color:${primary};font-size:14px">${escapeHtml(labels.calendar)}</a></div>`
		: ''
	const logoHtml = logo
		? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(theme.organizationName || input.restaurantName)}" style="max-height:48px;max-width:200px;margin-bottom:16px;display:block" />`
		: `<div style="font-size:16px;font-weight:700;color:${foreground};margin-bottom:16px;font-family:${headingFont}">${escapeHtml(theme.organizationName || input.restaurantName)}</div>`

	const html = `<!doctype html>
<html lang="${locale}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(copy.subject)}</title></head>
<body dir="${dir}" style="margin:0;padding:0;background:${background};font-family:${bodyFont}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${dir}" style="background:${background}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${dir}" style="max-width:560px;background:${card};border:1px solid ${border};border-radius:${radius}px"><tr><td style="padding:28px;text-align:${align}">
${logoHtml}
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${foreground};font-family:${headingFont}">${escapeHtml(copy.heading)}</h1>
<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:${foreground}">${escapeHtml(copy.lead)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${border}">${detailRows}</table>
${noteHtml}${ctaHtml}${calendarHtml}
<p style="margin:28px 0 0;font-size:12px;color:${muted}">${escapeHtml(labels.footer)}</p>
</td></tr></table>
</td></tr></table>
</body>
</html>`

	const textLines = [copy.heading, '', copy.lead, '']
	for (const [label, value] of rows) textLines.push(`${label}: ${value}`)
	if (note) textLines.push('', `${labels.note}: ${note}`)
	if (ctaUrl && copy.ctaLabel) textLines.push('', `${copy.ctaLabel}: ${ctaUrl}`)
	if (calendarUrl) textLines.push(`${labels.calendar}: ${calendarUrl}`)

	return { subject: copy.subject, html, text: textLines.join('\n') }
}
