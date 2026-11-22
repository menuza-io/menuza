import {
	formatGiftCardCode,
	type GiftCardDesignKey,
} from '@repo/common/gift-cards'
import { getSiteLocaleDirection } from '@repo/common/site-locales'
import { fillGiftCardCopy, giftCardCopyFor } from './gift-card-copy/index.ts'
import {
	escapeHtml,
	formatMoney,
	formatWhen,
	normalizeReservationLocale,
	type ReservationEmailTheme,
} from './reservations-email.ts'

/**
 * Gift card emails as plain HTML strings (tenant-api also runs in a Durable
 * Object, so no React): the buyer's receipt and the recipient's card. The
 * design is a header band in the restaurant's own colors with a motif per
 * occasion (or an uploaded image), mirrored for right-to-left languages.
 * Transactional only. Every dynamic value is escaped; the code appears only in
 * the delivery email, and the processing fee is its own line, never part of
 * the card's value.
 */

export type GiftCardEmailKind = 'receipt' | 'delivery'

export type GiftCardEmailInput = {
	kind: GiftCardEmailKind
	locale: string
	theme: ReservationEmailTheme | null
	restaurantName: string
	designKey: GiftCardDesignKey | string | null
	/** A safe https URL of an uploaded design image (design `custom`). */
	designImageUrl?: string | null
	amountMinor: number
	currency: string
	feeMinor?: number
	/** The code, for the delivery email only. */
	code?: string | null
	senderName?: string | null
	recipientName?: string | null
	message?: string | null
	sendToSelf?: boolean
	/** The buyer's receipt: how the card is going out. */
	timing?: 'now' | 'later' | 'held'
	deliverAt?: number | null
	expiresAt?: number | null
	timeZone?: string | null
	balanceUrl?: string | null
	orderUrl?: string | null
	addToAccountUrl?: string | null
}

export type RenderedGiftCardEmail = {
	subject: string
	html: string
	text: string
}

const MOTIF: Record<string, string> = {
	classic: '✦',
	birthday: '🎂',
	holidays: '❄',
	thank_you: '♥',
	eid: '☪',
	ramadan: '🌙',
	national_day: '★',
	custom: '✦',
}

const DEFAULT_THEME = {
	background: '#ffffff',
	card: '#ffffff',
	foreground: '#111827',
	mutedForeground: '#6b7280',
	border: '#e5e7eb',
	primary: '#111827',
	primaryForeground: '#ffffff',
	radius: 8,
	bodyFont: '',
	headingFont: '',
	logoUrl: null as string | null,
	organizationName: '',
}

function safeColor(value: string | undefined, fallback: string): string {
	return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback
}

function safeFont(value: string | undefined): string {
	const cleaned = (value ?? '').replace(/[^A-Za-z0-9 ,'-]/g, '').trim()
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

export function renderGiftCardEmail(
	input: GiftCardEmailInput,
): RenderedGiftCardEmail {
	const locale = normalizeReservationLocale(input.locale)
	const copy = giftCardCopyFor(locale)
	const labels = copy.labels
	const designKey = (input.designKey ?? 'classic') as keyof typeof copy.designs
	const designTitle = copy.designs[designKey] ?? copy.designs.classic
	const values = {
		r: input.restaurantName,
		from: input.senderName?.trim() || input.restaurantName,
		to: input.recipientName?.trim() || '',
	}
	const money = (minor: number) => formatMoney(minor, input.currency, locale)

	let subject: string
	let heading: string
	let lead: string
	if (input.kind === 'receipt') {
		subject = fillGiftCardCopy(copy.receipt.subject, values)
		heading = copy.receipt.heading
		lead =
			input.timing === 'held'
				? copy.receipt.leadHeld
				: input.timing === 'later'
					? copy.receipt.leadLater
					: copy.receipt.lead
	} else if (input.sendToSelf) {
		subject = fillGiftCardCopy(copy.delivery.subjectSelf, values)
		heading = copy.delivery.heading
		lead = fillGiftCardCopy(copy.delivery.leadSelf, values)
	} else {
		subject = fillGiftCardCopy(copy.delivery.subject, values)
		heading = copy.delivery.heading
		lead = fillGiftCardCopy(copy.delivery.lead, values)
	}

	const rows: Array<[string, string]> = [
		[labels.amount, money(input.amountMinor)],
	]
	if (input.kind === 'receipt') {
		if ((input.feeMinor ?? 0) > 0) {
			rows.push([labels.fee, money(input.feeMinor!)])
			rows.push([labels.total, money(input.amountMinor + input.feeMinor!)])
		}
		if (input.recipientName && !input.sendToSelf) {
			rows.push([labels.to, input.recipientName])
		}
		if (input.timing === 'later' && input.deliverAt) {
			const when = formatWhen(input.deliverAt, input.timeZone ?? null, locale)
			rows.push([labels.deliversOn, `${when.date}, ${when.time}`])
		}
	} else {
		if (input.senderName && !input.sendToSelf)
			rows.push([labels.from, input.senderName])
		if (input.expiresAt) {
			const when = formatWhen(input.expiresAt, input.timeZone ?? null, locale)
			rows.push([labels.expires, when.date])
		}
	}

	const theme = { ...DEFAULT_THEME, ...input.theme }
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
	const brandName = theme.organizationName || input.restaurantName
	const image = designKey === 'custom' ? safeUrl(input.designImageUrl) : null

	const detailRows = rows
		.map(
			([label, value]) =>
				`<tr><td style="padding:6px 0;color:${muted};font-size:13px;text-align:${align};width:38%;vertical-align:top">${escapeHtml(label)}</td><td style="padding:6px 0;color:${foreground};font-size:15px;text-align:${align}" dir="auto">${escapeHtml(value)}</td></tr>`,
		)
		.join('')

	const band = image
		? `<img src="${escapeHtml(image)}" alt="" width="504" style="display:block;width:100%;max-width:504px;border-radius:${radius}px" />`
		: `<div dir="${dir}" style="background:${primary};color:${primaryForeground};border-radius:${radius}px;padding:28px 20px;text-align:center"><div style="font-size:34px;line-height:1">${MOTIF[designKey] ?? MOTIF.classic}</div><div style="margin-top:10px;font-size:22px;font-weight:700;font-family:${headingFont}">${escapeHtml(designTitle)}</div><div style="margin-top:6px;font-size:14px;opacity:.9">${escapeHtml(brandName)}</div></div>`

	const messageHtml = input.message?.trim()
		? `<div style="margin-top:16px;padding:14px;border:1px solid ${border};border-radius:${radius}px;text-align:${align}"><div style="font-size:12px;color:${muted}">${escapeHtml(labels.message)}</div><div style="margin-top:4px;font-size:15px;color:${foreground};white-space:pre-wrap" dir="auto">${escapeHtml(input.message.trim())}</div></div>`
		: ''

	const code = input.kind === 'delivery' && input.code ? input.code : null
	const codeHtml = code
		? `<div style="margin-top:18px;text-align:center"><div style="font-size:12px;color:${muted}">${escapeHtml(labels.code)}</div><div style="margin-top:6px;font-size:22px;letter-spacing:2px;font-weight:700;color:${foreground};font-family:'Courier New',monospace" dir="ltr">${escapeHtml(formatGiftCardCode(code))}</div><div style="margin-top:8px;font-size:12px;color:${muted}">${escapeHtml(labels.keepSafe)}</div></div>`
		: ''

	const button = (url: string | null, label: string, filled: boolean) =>
		url
			? `<a href="${escapeHtml(url)}" style="display:inline-block;margin:6px 6px 0 0;padding:11px 20px;border-radius:${radius}px;font-size:14px;font-weight:600;text-decoration:none;${filled ? `background:${primary};color:${primaryForeground}` : `border:1px solid ${primary};color:${primary}`}">${escapeHtml(label)}</a>`
			: ''
	const balanceUrl = safeUrl(input.balanceUrl)
	const orderUrl = safeUrl(input.orderUrl)
	const addUrl = safeUrl(input.addToAccountUrl)
	const ctaHtml =
		input.kind === 'delivery'
			? `<div style="margin-top:20px;text-align:${align}">${button(orderUrl, labels.orderNow, true)}${button(balanceUrl, labels.checkBalance, false)}${button(addUrl, labels.addToAccount, false)}</div>`
			: balanceUrl
				? `<div style="margin-top:20px;text-align:${align}">${button(balanceUrl, labels.checkBalance, false)}</div>`
				: ''
	const logoHtml = logo
		? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(brandName)}" style="max-height:48px;max-width:200px;margin-bottom:16px;display:block" />`
		: ''

	const html = `<!doctype html>
<html lang="${locale}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body dir="${dir}" style="margin:0;padding:0;background:${background};font-family:${bodyFont}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${dir}" style="background:${background}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${dir}" style="max-width:560px;background:${card};border:1px solid ${border};border-radius:${radius}px"><tr><td style="padding:28px;text-align:${align}">
${logoHtml}${band}
<h1 style="margin:20px 0 8px;font-size:21px;line-height:1.3;color:${foreground};font-family:${headingFont}">${escapeHtml(heading)}</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${foreground}">${escapeHtml(lead)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${border}">${detailRows}</table>
${messageHtml}${codeHtml}${ctaHtml}
</td></tr></table>
</td></tr></table>
</body>
</html>`

	const text = [heading, '', lead, '']
	for (const [label, value] of rows) text.push(`${label}: ${value}`)
	if (input.message?.trim())
		text.push('', `${labels.message}: ${input.message.trim()}`)
	if (code)
		text.push(
			'',
			`${labels.code}: ${formatGiftCardCode(code)}`,
			labels.keepSafe,
		)
	if (input.kind === 'delivery') {
		if (orderUrl) text.push('', `${labels.orderNow}: ${orderUrl}`)
		if (balanceUrl) text.push(`${labels.checkBalance}: ${balanceUrl}`)
		if (addUrl) text.push(`${labels.addToAccount}: ${addUrl}`)
	} else if (balanceUrl) {
		text.push('', `${labels.checkBalance}: ${balanceUrl}`)
	}
	return { subject, html, text: text.join('\n') }
}
