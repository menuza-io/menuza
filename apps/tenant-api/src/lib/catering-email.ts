import { getSiteLocaleDirection } from '@repo/common/site-locales'
import {
	escapeHtml,
	formatMoney,
	formatWhen,
	normalizeReservationLocale,
	type ReservationEmailTheme,
} from './reservations-email.ts'

/**
 * Catering emails as plain HTML strings (tenant-api also runs in a Durable
 * Object, so no React): the quote the guest pays, the confirmation once the
 * deposit clears, and the balance link with its reminders (#124, #361).
 * Transactional only. Every dynamic value is escaped. The guest's own link
 * (a capability token) is the only address in the message that carries a
 * secret, and it rides in the URL fragment. English and Arabic are shipped;
 * every other language reads the English copy until it is translated.
 */

export type CateringEmailKind =
	| 'quote'
	| 'quote_updated'
	| 'confirmed'
	| 'balance_link'
	| 'balance_reminder'
	| 'balance_overdue'
	| 'balance_paid'

export type CateringEmailInput = {
	kind: CateringEmailKind
	locale: string
	theme: ReservationEmailTheme | null
	restaurantName: string
	firstName?: string | null
	/** The event time (epoch ms) and the location's zone. */
	eventAtMs?: number | null
	timeZone?: string | null
	guestCount?: number | null
	currency: string
	totalMinor?: number | null
	/** The deposit just taken, or the balance asked for. */
	amountMinor?: number | null
	/** The balance still to pay after a deposit. */
	balanceMinor?: number | null
	/** The due date as a date string already formatted for the guest, or null. */
	dueAtMs?: number | null
	expiresAtMs?: number | null
	/** What the restaurant wrote on the quote (plain text). */
	note?: string | null
	/** The guest's capability link (quote or balance), or null when none applies. */
	actionUrl?: string | null
}

export type RenderedCateringEmail = {
	subject: string
	html: string
	text: string
}

type Copy = {
	subject: Record<CateringEmailKind, string>
	heading: Record<CateringEmailKind, string>
	lead: Record<CateringEmailKind, string>
	cta: Record<CateringEmailKind, string>
	hello: string
	helloNamed: string
	event: string
	guests: string
	total: string
	deposit: string
	amountDue: string
	balance: string
	dueBy: string
	validUntil: string
	note: string
	footer: string
}

const EN: Copy = {
	subject: {
		quote: 'Your catering quote from {r}',
		quote_updated: 'Your catering quote from {r} was updated',
		confirmed: 'Your catering order with {r} is confirmed',
		balance_link: 'Pay the balance of your catering order with {r}',
		balance_reminder:
			'Reminder: the balance of your catering order is due soon',
		balance_overdue: 'The balance of your catering order is overdue',
		balance_paid: 'Your catering order with {r} is paid in full',
	},
	heading: {
		quote: 'Your catering quote',
		quote_updated: 'Your quote was updated',
		confirmed: 'Your order is confirmed',
		balance_link: 'Pay the balance',
		balance_reminder: 'Your balance is due soon',
		balance_overdue: 'Your balance is overdue',
		balance_paid: 'Paid in full',
	},
	lead: {
		quote:
			'{r} sent you a quote. Review it and pay online to confirm your order.',
		quote_updated:
			'{r} changed your quote. Earlier links no longer work: use the button below.',
		confirmed:
			'We received your payment and your catering order is confirmed. Thank you.',
		balance_link:
			'The balance of your catering order is ready to pay online whenever you like.',
		balance_reminder:
			'This is a reminder that the balance of your catering order is due soon.',
		balance_overdue:
			'The balance of your catering order was due and has not been paid yet.',
		balance_paid:
			'We received the balance. Your catering order is paid in full. Thank you.',
	},
	cta: {
		quote: 'View and pay your quote',
		quote_updated: 'View the new quote',
		confirmed: '',
		balance_link: 'Pay the balance',
		balance_reminder: 'Pay the balance',
		balance_overdue: 'Pay the balance',
		balance_paid: '',
	},
	hello: 'Hello,',
	helloNamed: 'Hello {name},',
	event: 'Event',
	guests: 'Guests',
	total: 'Order total',
	deposit: 'Deposit paid',
	amountDue: 'Due now',
	balance: 'Balance',
	dueBy: 'Due by',
	validUntil: 'Valid until',
	note: 'A note from the restaurant',
	footer: 'This message is about your catering order.',
}

const AR: Copy = {
	subject: {
		quote: 'عرض سعر التموين من {r}',
		quote_updated: 'تم تحديث عرض سعر التموين من {r}',
		confirmed: 'تم تأكيد طلب التموين لدى {r}',
		balance_link: 'ادفع الرصيد المتبقي لطلب التموين لدى {r}',
		balance_reminder: 'تذكير: موعد دفع رصيد طلب التموين يقترب',
		balance_overdue: 'تأخر دفع رصيد طلب التموين',
		balance_paid: 'تم دفع طلب التموين لدى {r} بالكامل',
	},
	heading: {
		quote: 'عرض سعر التموين',
		quote_updated: 'تم تحديث عرض السعر',
		confirmed: 'تم تأكيد طلبك',
		balance_link: 'ادفع الرصيد المتبقي',
		balance_reminder: 'موعد دفع الرصيد يقترب',
		balance_overdue: 'تأخر دفع الرصيد',
		balance_paid: 'تم الدفع بالكامل',
	},
	lead: {
		quote: 'أرسل لك {r} عرض سعر. راجعه وادفع عبر الإنترنت لتأكيد طلبك.',
		quote_updated:
			'عدّل {r} عرض السعر. الروابط السابقة لم تعد تعمل: استخدم الزر أدناه.',
		confirmed: 'استلمنا دفعتك وتم تأكيد طلب التموين. شكرًا لك.',
		balance_link: 'رصيد طلب التموين جاهز للدفع عبر الإنترنت في أي وقت.',
		balance_reminder: 'تذكير بأن موعد دفع رصيد طلب التموين يقترب.',
		balance_overdue: 'حان موعد دفع رصيد طلب التموين ولم يُدفع بعد.',
		balance_paid: 'استلمنا الرصيد. تم دفع طلب التموين بالكامل. شكرًا لك.',
	},
	cta: {
		quote: 'عرض السعر والدفع',
		quote_updated: 'عرض السعر الجديد',
		confirmed: '',
		balance_link: 'ادفع الرصيد',
		balance_reminder: 'ادفع الرصيد',
		balance_overdue: 'ادفع الرصيد',
		balance_paid: '',
	},
	hello: 'مرحبًا،',
	helloNamed: 'مرحبًا {name}،',
	event: 'المناسبة',
	guests: 'عدد الضيوف',
	total: 'إجمالي الطلب',
	deposit: 'العربون المدفوع',
	amountDue: 'المستحق الآن',
	balance: 'الرصيد المتبقي',
	dueBy: 'يُدفع قبل',
	validUntil: 'ساري حتى',
	note: 'ملاحظة من المطعم',
	footer: 'هذه الرسالة بخصوص طلب التموين الخاص بك.',
}

function copyFor(locale: string): Copy {
	return locale === 'ar' ? AR : EN
}

function fill(template: string, values: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')
}

function safeColor(value: string | undefined, fallback: string): string {
	return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback
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

export function renderCateringEmail(
	input: CateringEmailInput,
): RenderedCateringEmail {
	const locale = normalizeReservationLocale(input.locale)
	const copy = copyFor(locale)
	const dir = getSiteLocaleDirection(locale)
	const values = { r: input.restaurantName, name: input.firstName ?? '' }
	const money = (minor: number | null | undefined) =>
		typeof minor === 'number' ? formatMoney(minor, input.currency, locale) : ''
	const subject = fill(copy.subject[input.kind], values)
	const heading = fill(copy.heading[input.kind], values)
	const lead = fill(copy.lead[input.kind], values)
	const greeting = input.firstName ? fill(copy.helloNamed, values) : copy.hello

	const rows: Array<[string, string]> = []
	if (input.eventAtMs) {
		const when = formatWhen(input.eventAtMs, input.timeZone, locale)
		rows.push([copy.event, `${when.date}, ${when.time}`])
	}
	if (input.guestCount) rows.push([copy.guests, String(input.guestCount)])
	if (input.totalMinor != null) rows.push([copy.total, money(input.totalMinor)])
	if (input.kind === 'confirmed' && input.amountMinor != null) {
		rows.push([copy.deposit, money(input.amountMinor)])
	}
	if (input.kind === 'quote' || input.kind === 'quote_updated') {
		if (input.amountMinor != null) {
			rows.push([copy.amountDue, money(input.amountMinor)])
		}
		if (input.expiresAtMs) {
			const when = formatWhen(input.expiresAtMs, input.timeZone, locale)
			rows.push([copy.validUntil, when.date])
		}
	}
	if (input.balanceMinor != null && input.balanceMinor > 0) {
		rows.push([copy.balance, money(input.balanceMinor)])
	}
	if (
		input.dueAtMs &&
		(input.kind === 'confirmed' ||
			input.kind === 'balance_link' ||
			input.kind === 'balance_reminder' ||
			input.kind === 'balance_overdue')
	) {
		// The due instant is the end of the due day; show that day.
		const when = formatWhen(input.dueAtMs - 1, input.timeZone, locale)
		rows.push([copy.dueBy, when.date])
	}
	if (
		(input.kind === 'balance_link' ||
			input.kind === 'balance_reminder' ||
			input.kind === 'balance_overdue') &&
		input.amountMinor != null
	) {
		rows.push([copy.amountDue, money(input.amountMinor)])
	}

	const theme = input.theme
	const primary = safeColor(theme?.primary, '#111827')
	const primaryText = safeColor(theme?.primaryForeground, '#ffffff')
	const background = safeColor(theme?.background, '#ffffff')
	const foreground = safeColor(theme?.foreground, '#111827')
	const muted = safeColor(theme?.mutedForeground, '#6b7280')
	const border = safeColor(theme?.border, '#e5e7eb')
	const actionUrl = safeUrl(input.actionUrl)
	const cta = copy.cta[input.kind]

	const rowsHtml = rows
		.map(
			([label, value]) =>
				`<tr><td style="padding:6px 0;color:${muted};font-size:14px">${escapeHtml(label)}</td><td style="padding:6px 0;text-align:end;font-size:14px;color:${foreground}"><bdi>${escapeHtml(value)}</bdi></td></tr>`,
		)
		.join('')
	const noteHtml = input.note?.trim()
		? `<div style="margin-top:16px;padding:12px;border:1px solid ${border};border-radius:8px"><div style="font-size:12px;color:${muted}">${escapeHtml(copy.note)}</div><div style="font-size:14px;white-space:pre-wrap;color:${foreground}">${escapeHtml(input.note.trim())}</div></div>`
		: ''
	const buttonHtml =
		actionUrl && cta
			? `<p style="margin:24px 0"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:${primary};color:${primaryText};text-decoration:none;font-weight:600">${escapeHtml(cta)}</a></p>`
			: ''
	const html = `<!doctype html><html lang="${escapeHtml(locale)}" dir="${dir}"><body style="margin:0;background:${background};font-family:Arial,sans-serif;color:${foreground}"><div style="max-width:560px;margin:0 auto;padding:24px"><div style="font-size:14px;color:${muted}">${escapeHtml(input.restaurantName)}</div><h1 style="font-size:22px;margin:8px 0 16px">${escapeHtml(heading)}</h1><p style="font-size:15px;line-height:1.5">${escapeHtml(greeting)}<br>${escapeHtml(lead)}</p><table style="width:100%;border-collapse:collapse;border-top:1px solid ${border};border-bottom:1px solid ${border};margin-top:16px">${rowsHtml}</table>${noteHtml}${buttonHtml}<p style="font-size:12px;color:${muted}">${escapeHtml(copy.footer)}</p></div></body></html>`

	const text = [
		heading,
		'',
		greeting,
		lead,
		'',
		...rows.map(([label, value]) => `${label}: ${value}`),
		...(input.note?.trim() ? ['', `${copy.note}: ${input.note.trim()}`] : []),
		...(actionUrl && cta ? ['', `${cta}: ${actionUrl}`] : []),
		'',
		copy.footer,
	].join('\n')

	return { subject, html, text }
}
