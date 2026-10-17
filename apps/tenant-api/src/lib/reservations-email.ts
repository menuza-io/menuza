import { type ReservationsContext } from '@repo/reservations'
import { type ToggleableMessageKind } from './reservations-messaging-settings.ts'

/**
 * Guest reservation email as plain HTML strings: tenant-api also runs inside a
 * Durable Object, so there is no React here, and mail clients support neither
 * CSS variables nor `oklch()`, so colors are the hex values of the organization's
 * email theme. English and Arabic only (Arabic renders `dir="rtl"`); any other
 * guest locale gets English. Every dynamic value is escaped. The manage link
 * carries its capability token in the URL fragment, never the path or query.
 */

export type ReservationEmailLocale = 'en' | 'ar'
export type ReservationEmailTheme =
	ReservationsContext['organization']['emailTheme']

export type ReservationEmailInput = {
	kind: ToggleableMessageKind
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

export function normalizeReservationLocale(
	value: unknown,
): ReservationEmailLocale {
	return typeof value === 'string' && value.toLowerCase().startsWith('ar')
		? 'ar'
		: 'en'
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
	// Latin digits in Arabic too, so times and party sizes read the same in both.
	return locale === 'ar' ? 'ar-u-nu-latn' : 'en-US'
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

type Vars = {
	r: string
	name: string
	date: string
	time: string
	party: string
	wait: string
}

type Copy = {
	subject: string
	heading: string
	lead: string
	cta?: 'manage' | 'confirm' | 'status' | 'book'
	ctaLabel?: string
	footer?: string
}

type Dict = Record<ToggleableMessageKind, (v: Vars) => Copy>

const EN: Dict = {
	confirmation: (v) => ({
		subject: `Your reservation at ${v.r} is confirmed`,
		heading: 'Reservation confirmed',
		lead: `Hi ${v.name}, your table at ${v.r} is booked.`,
		cta: 'manage',
		ctaLabel: 'Manage reservation',
	}),
	modification: (v) => ({
		subject: `Your reservation at ${v.r} was updated`,
		heading: 'Reservation updated',
		lead: `Hi ${v.name}, your reservation at ${v.r} now looks like this.`,
		cta: 'manage',
		ctaLabel: 'Manage reservation',
	}),
	cancellation_guest: (v) => ({
		subject: `Your reservation at ${v.r} was cancelled`,
		heading: 'Reservation cancelled',
		lead: `Hi ${v.name}, as you asked, we cancelled your reservation at ${v.r}.`,
	}),
	cancellation_restaurant: (v) => ({
		subject: `We had to cancel your reservation at ${v.r}`,
		heading: 'We had to cancel your reservation',
		lead: `Hi ${v.name}, we are sorry: ${v.r} had to cancel your reservation. Please contact the restaurant to find another time.`,
	}),
	reminder: (v) => ({
		subject: `Reminder: your reservation at ${v.r}`,
		heading: 'See you soon',
		lead: `Hi ${v.name}, this is a reminder of your reservation at ${v.r}.`,
		cta: 'manage',
		ctaLabel: 'Manage reservation',
	}),
	reconfirm_request: (v) => ({
		subject: `Please confirm your reservation at ${v.r}`,
		heading: 'Please confirm your reservation',
		lead: `Hi ${v.name}, please let ${v.r} know you are still coming.`,
		cta: 'confirm',
		ctaLabel: 'Confirm reservation',
	}),
	request_received: (v) => ({
		subject: `We received your request at ${v.r}`,
		heading: 'Request received',
		lead: `Hi ${v.name}, ${v.r} received your request and will reply soon. Your table is not confirmed yet.`,
		cta: 'manage',
		ctaLabel: 'View your request',
	}),
	request_approved: (v) => ({
		subject: `Your request at ${v.r} was approved`,
		heading: 'Request approved',
		lead: `Hi ${v.name}, good news: ${v.r} approved your request.`,
		cta: 'manage',
		ctaLabel: 'Manage reservation',
	}),
	request_declined: (v) => ({
		subject: `We could not accept your request at ${v.r}`,
		heading: 'Request not accepted',
		lead: `Hi ${v.name}, we are sorry: ${v.r} could not accept your request. Please contact the restaurant or try another time.`,
	}),
	waitlist_joined: (v) => ({
		subject: `You are on the waitlist at ${v.r}`,
		heading: 'You are on the waitlist',
		lead: `Hi ${v.name}, you joined the waitlist at ${v.r}.${v.wait ? ` Estimated wait: ${v.wait}.` : ''}`,
		cta: 'status',
		ctaLabel: 'Check your place in line',
	}),
	waitlist_ready: (v) => ({
		subject: `Your table at ${v.r} is ready`,
		heading: 'Your table is ready',
		lead: `Hi ${v.name}, your table at ${v.r} is ready. Please let the host know you are on your way.`,
		cta: 'status',
		ctaLabel: 'Open your waitlist status',
	}),
	notify_available: (v) => ({
		subject: `A table opened up at ${v.r}`,
		heading: 'A table is available',
		lead: `A table you asked about at ${v.r} just opened up. Book it before it goes.`,
		cta: 'book',
		ctaLabel: 'Book now',
	}),
}

const AR: Dict = {
	confirmation: (v) => ({
		subject: `تم تأكيد حجزك في ${v.r}`,
		heading: 'تم تأكيد الحجز',
		lead: `مرحباً ${v.name}، تم حجز طاولتك في ${v.r}.`,
		cta: 'manage',
		ctaLabel: 'إدارة الحجز',
	}),
	modification: (v) => ({
		subject: `تم تعديل حجزك في ${v.r}`,
		heading: 'تم تعديل الحجز',
		lead: `مرحباً ${v.name}، هذه هي تفاصيل حجزك المحدّثة في ${v.r}.`,
		cta: 'manage',
		ctaLabel: 'إدارة الحجز',
	}),
	cancellation_guest: (v) => ({
		subject: `تم إلغاء حجزك في ${v.r}`,
		heading: 'تم إلغاء الحجز',
		lead: `مرحباً ${v.name}، تم إلغاء حجزك في ${v.r} بناءً على طلبك.`,
	}),
	cancellation_restaurant: (v) => ({
		subject: `اضطررنا إلى إلغاء حجزك في ${v.r}`,
		heading: 'اضطررنا إلى إلغاء حجزك',
		lead: `مرحباً ${v.name}، نعتذر: اضطر ${v.r} إلى إلغاء حجزك. يرجى التواصل مع المطعم لاختيار موعد آخر.`,
	}),
	reminder: (v) => ({
		subject: `تذكير بحجزك في ${v.r}`,
		heading: 'نراك قريباً',
		lead: `مرحباً ${v.name}، هذا تذكير بحجزك في ${v.r}.`,
		cta: 'manage',
		ctaLabel: 'إدارة الحجز',
	}),
	reconfirm_request: (v) => ({
		subject: `يرجى تأكيد حجزك في ${v.r}`,
		heading: 'يرجى تأكيد حجزك',
		lead: `مرحباً ${v.name}، يرجى إبلاغ ${v.r} بأنك ما زلت قادماً.`,
		cta: 'confirm',
		ctaLabel: 'تأكيد الحجز',
	}),
	request_received: (v) => ({
		subject: `استلمنا طلبك في ${v.r}`,
		heading: 'تم استلام الطلب',
		lead: `مرحباً ${v.name}، استلم ${v.r} طلبك وسيرد عليك قريباً. لم يتم تأكيد الطاولة بعد.`,
		cta: 'manage',
		ctaLabel: 'عرض طلبك',
	}),
	request_approved: (v) => ({
		subject: `تمت الموافقة على طلبك في ${v.r}`,
		heading: 'تمت الموافقة على الطلب',
		lead: `مرحباً ${v.name}، خبر سار: وافق ${v.r} على طلبك.`,
		cta: 'manage',
		ctaLabel: 'إدارة الحجز',
	}),
	request_declined: (v) => ({
		subject: `تعذّر قبول طلبك في ${v.r}`,
		heading: 'لم يتم قبول الطلب',
		lead: `مرحباً ${v.name}، نعتذر: تعذّر على ${v.r} قبول طلبك. يرجى التواصل مع المطعم أو تجربة موعد آخر.`,
	}),
	waitlist_joined: (v) => ({
		subject: `أنت في قائمة الانتظار في ${v.r}`,
		heading: 'أنت في قائمة الانتظار',
		lead: `مرحباً ${v.name}، انضممت إلى قائمة الانتظار في ${v.r}.${v.wait ? ` مدة الانتظار المتوقعة: ${v.wait}.` : ''}`,
		cta: 'status',
		ctaLabel: 'تحقق من ترتيبك',
	}),
	waitlist_ready: (v) => ({
		subject: `طاولتك في ${v.r} جاهزة`,
		heading: 'طاولتك جاهزة',
		lead: `مرحباً ${v.name}، طاولتك في ${v.r} جاهزة. يرجى إبلاغ المضيف بأنك في الطريق.`,
		cta: 'status',
		ctaLabel: 'فتح حالة الانتظار',
	}),
	notify_available: (v) => ({
		subject: `توفرت طاولة في ${v.r}`,
		heading: 'توفرت طاولة',
		lead: `توفرت طاولة سألت عنها في ${v.r}. احجزها قبل أن تنفد.`,
		cta: 'book',
		ctaLabel: 'احجز الآن',
	}),
}

const LABELS = {
	en: {
		restaurant: 'Restaurant',
		date: 'Date',
		time: 'Time',
		party: 'Party size',
		address: 'Address',
		phone: 'Phone',
		calendar: 'Add to calendar',
		note: 'A note from the restaurant',
		minutes: 'min',
		footer: 'This is a service message about your reservation.',
	},
	ar: {
		restaurant: 'المطعم',
		date: 'التاريخ',
		time: 'الوقت',
		party: 'عدد الأشخاص',
		address: 'العنوان',
		phone: 'الهاتف',
		calendar: 'أضف إلى التقويم',
		note: 'ملاحظة من المطعم',
		minutes: 'دقيقة',
		footer: 'هذه رسالة خدمة بخصوص حجزك.',
	},
} as const

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

function formatWait(minutes: number, locale: ReservationEmailLocale): string {
	return `${Math.max(0, Math.round(minutes))} ${LABELS[locale].minutes}`
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
	const labels = LABELS[locale]
	const when =
		typeof input.whenMs === 'number'
			? formatWhen(input.whenMs, input.timeZone, locale)
			: null
	const firstName =
		input.firstName?.trim() || (locale === 'ar' ? 'ضيفنا' : 'there')
	const vars: Vars = {
		r: input.restaurantName,
		name: firstName,
		date: when?.date ?? '',
		time: when?.time ?? '',
		party: input.partySize ? String(input.partySize) : '',
		wait:
			typeof input.quotedWaitMin === 'number'
				? formatWait(input.quotedWaitMin, locale)
				: '',
	}
	const copy = (locale === 'ar' ? AR : EN)[input.kind](vars)

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
	const dir = locale === 'ar' ? 'rtl' : 'ltr'
	const align = locale === 'ar' ? 'right' : 'left'
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
