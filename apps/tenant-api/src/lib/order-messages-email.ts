import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { DEFAULT_PACKAGING_FEE_LABEL } from '@repo/common/packaging-fee'
import { DEFAULT_SERVICE_FEE_LABEL } from '@repo/common/service-fee'
import {
	guestVisibleCancelReason,
	type PricedOrderLine,
} from '@repo/common/restaurant-orders'
import { getSiteLocaleDirection } from '@repo/common/site-locales'
import { type LoyaltyUnitLabel } from '@repo/loyalty'
import { type OrderMessageKind, type RestaurantOrder } from '@repo/tenant-db'
import { orderCopyFor } from './order-messages-copy/index.ts'
import { fillCopy } from './reservations-copy/index.ts'
import {
	escapeHtml,
	formatMoney,
	formatWhen,
	normalizeReservationLocale,
	type ReservationEmailLocale,
	type ReservationEmailTheme,
} from './reservations-email.ts'

/**
 * Guest order messages as plain HTML strings, built the way reservation emails
 * are (`reservations-email.ts`): tenant-api also runs inside a Durable Object,
 * so there is no React here; colors are the hex values of the organization's
 * email theme; the copy exists for every site language and right-to-left
 * languages render `dir="rtl"`. Every dynamic value (menu names, guest
 * instructions, the restaurant's name) is escaped. Transactional only: no
 * marketing content. Subjects carry the order number and the restaurant name,
 * never an address or a phone number.
 */

export type OrderEmailOrder = Pick<
	RestaurantOrder,
	| 'number'
	| 'fulfillment'
	| 'locationName'
	| 'currency'
	| 'subtotalCents'
	| 'taxCents'
	| 'deliveryFeeCents'
	| 'deliveryDiscountCents'
	| 'tipCents'
	| 'serviceFeeCents'
	| 'serviceFeeLabel'
	| 'packagingFeeCents'
	| 'packagingFeeLabel'
	| 'pickupInstructions'
	| 'utensilsRequested'
	| 'totalCents'
	| 'discountCents'
	| 'loyaltyDiscountCents'
	| 'refundedCents'
	| 'refundReversedCents'
	| 'lines'
	| 'scheduledFor'
	| 'pickupDate'
	| 'pickupTime'
	| 'promisedAt'
	| 'promisedUntil'
	| 'isTest'
> & {
	/** Why it was cancelled; only guest-visible reasons are shown. */
	cancelReason?: RestaurantOrder['cancelReason']
}

export type OrderEmailInput = {
	kind: OrderMessageKind
	locale: string
	theme: ReservationEmailTheme | null
	restaurantName: string
	/** The organization's default site language, for menu names. */
	defaultLocale?: string
	order: OrderEmailOrder
	timeZone: string | null
	/** "View your order" (`buildOrderLinkUrl`); omitted when unknown. */
	linkUrl: string | null
	/**
	 * Cancelled: provider refunds of the order still on their way (read from
	 * the refund rows at send time). With them the message names everything
	 * coming back; 0 or absent shows only what was refunded.
	 */
	refundPendingCents?: number
	/** One-time loyalty welcome points unlocked on this order/checkout, if any. */
	welcomeBonus?: { points: number; unitLabel: LoyaltyUnitLabel } | null
	/**
	 * Receipt only (#196): "Track this order in the app" with the stores that
	 * are live. Each link is the site's own counting redirect. Empty or absent
	 * shows nothing.
	 */
	appInvite?: Array<{ store: 'app_store' | 'play_store'; url: string }>
	/**
	 * Receipt only (#263): the review and app codes the owner switched on, as
	 * links with their captions (an email cannot print a scannable code, but a
	 * guest can tap one). Absent or empty shows nothing.
	 */
	receiptCodes?: Array<{ kind: 'review' | 'app'; url: string; caption: string }>
}

export type RenderedOrderEmail = { subject: string; html: string; text: string }

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

function toMs(value: Date | number | null | undefined): number | null {
	if (value === null || value === undefined) return null
	const ms = value instanceof Date ? value.getTime() : value
	return Number.isFinite(ms) ? ms : null
}

/**
 * The time line of a message: a promised time when the restaurant set one
 * (pickup "Ready around", delivery "Arriving from to"), else the time the guest
 * chose (scheduled, or a drop's pickup slot), else "As soon as possible".
 */
export function orderTimeLine(
	order: OrderEmailOrder,
	timeZone: string | null,
	locale: ReservationEmailLocale,
): { label: string; value: string } {
	const labels = orderCopyFor(locale).labels
	const delivery = order.fulfillment === 'delivery'
	const label = delivery ? labels.deliveryTime : labels.pickupTime
	const promisedAt = toMs(order.promisedAt)
	if (promisedAt !== null) {
		const at = formatWhen(promisedAt, timeZone, locale)
		const until = toMs(order.promisedUntil)
		if (!delivery) {
			return { label, value: fillCopy(labels.readyAround, { time: at.time }) }
		}
		if (until !== null && until > promisedAt) {
			const end = formatWhen(until, timeZone, locale)
			return {
				label,
				value: fillCopy(labels.arriving, { from: at.time, to: end.time }),
			}
		}
		return { label, value: fillCopy(labels.arrivingAround, { time: at.time }) }
	}
	const scheduled = toMs(order.scheduledFor)
	if (scheduled !== null) {
		const when = formatWhen(scheduled, timeZone, locale)
		return { label, value: `${when.date}, ${when.time}` }
	}
	if (order.pickupDate && order.pickupTime) {
		// A drop slot is a wall-clock date and time: shown as written.
		const wall = Date.parse(`${order.pickupDate}T${order.pickupTime}:00Z`)
		if (Number.isFinite(wall)) {
			const when = formatWhen(wall, 'UTC', locale)
			return { label, value: `${when.date}, ${when.time}` }
		}
	}
	return { label, value: labels.asap }
}

function lineChoices(
	line: PricedOrderLine,
	locale: string,
	defaultLocale: string,
): string {
	const names = [
		...(line.variantNames ?? []).map((name) =>
			getLocalizedMenuValue(name, locale, defaultLocale),
		),
		...(line.options ?? []).map((option) => {
			const name = getLocalizedMenuValue(
				option.optionName,
				locale,
				defaultLocale,
			)
			return option.quantity > 1 ? `${option.quantity}x ${name}` : name
		}),
	].filter(Boolean)
	return names.join(', ')
}

function orderLines(order: OrderEmailOrder): PricedOrderLine[] {
	return Array.isArray(order.lines) ? (order.lines as PricedOrderLine[]) : []
}

export function renderOrderEmail(input: OrderEmailInput): RenderedOrderEmail {
	const locale = normalizeReservationLocale(input.locale)
	const defaultLocale = input.defaultLocale || 'en'
	const copyset = orderCopyFor(locale)
	const labels = copyset.labels
	const entry = copyset.kinds[input.kind]
	const order = input.order
	const locationName =
		getLocalizedMenuValue(order.locationName, locale, defaultLocale) ||
		order.locationName
	const values = {
		number: order.number,
		r: input.restaurantName,
		location: locationName,
	}
	const delivery = order.fulfillment === 'delivery'
	// A free test order (#119): the confirmation is labelled test in the subject
	// and above the lead, so nobody takes it for a real order.
	const testTag = order.isTest ? `[${labels.testTag}] ` : ''
	const testLead = order.isTest ? `${labels.testLabel} ` : ''
	const copy = {
		subject: `${testTag}${fillCopy(entry.subject, values)}`,
		heading: fillCopy(entry.heading, values),
		lead: `${testLead}${fillCopy(
			delivery && entry.leadDelivery ? entry.leadDelivery : entry.lead,
			values,
		)}`,
	}
	const money = (cents: number) => formatMoney(cents, order.currency, locale)

	const rows: Array<[string, string]> = [
		[labels.order, order.number],
		[labels.location, locationName],
	]
	if (
		input.kind === 'receipt' ||
		input.kind === 'accepted' ||
		input.kind === 'eta_changed'
	) {
		const time = orderTimeLine(order, input.timeZone, locale)
		rows.push([time.label, time.value])
	}
	// Where to go (#251): the text the guest saw at checkout, kept with the
	// order. Plain text, escaped like every other value; line breaks stay.
	const pickupText = order.pickupInstructions?.trim()
	if (
		pickupText &&
		order.fulfillment === 'pickup' &&
		(input.kind === 'receipt' ||
			input.kind === 'accepted' ||
			input.kind === 'ready' ||
			input.kind === 'eta_changed')
	) {
		rows.push([labels.pickupInstructions, pickupText])
	}
	if (
		input.kind === 'receipt' &&
		typeof order.utensilsRequested === 'boolean'
	) {
		rows.push([
			labels.utensils,
			order.utensilsRequested ? labels.utensilsYes : labels.utensilsNo,
		])
	}
	if (input.kind === 'cancelled') {
		// Only the reasons a guest may see; every other one stays internal.
		const reason = guestVisibleCancelReason(order.cancelReason)
		if (reason) {
			rows.push([
				labels.reason,
				reason === 'out_of_stock'
					? labels.reasonOutOfStock
					: labels.reasonKitchenClosed,
			])
		}
		const pending = Math.max(0, input.refundPendingCents ?? 0)
		// What is really back: a refund the provider reversed does not count.
		const back = Math.max(
			0,
			order.refundedCents - (order.refundReversedCents ?? 0),
		)
		if (pending > 0) {
			rows.push([labels.refundPending, money(back + pending)])
		} else if (back > 0) {
			rows.push([labels.refunded, money(back)])
		}
	}

	const showItems = input.kind === 'receipt'
	const lines = showItems ? orderLines(order) : []
	const totals: Array<[string, string]> = []
	if (showItems) {
		totals.push([labels.subtotal, money(order.subtotalCents)])
		if (order.discountCents > 0) {
			totals.push([labels.discount, `-${money(order.discountCents)}`])
		}
		if (order.loyaltyDiscountCents > 0) {
			totals.push([labels.reward, `-${money(order.loyaltyDiscountCents)}`])
		}
		const deliveryFee = order.deliveryFeeCents - order.deliveryDiscountCents
		if (delivery && deliveryFee > 0) {
			totals.push([labels.deliveryFee, money(deliveryFee)])
		}
		if (order.tipCents > 0) totals.push([labels.tip, money(order.tipCents)])
		if (order.serviceFeeCents > 0) {
			// The name the restaurant gave the fee; the default reads in the
			// guest's language.
			const feeLabel =
				order.serviceFeeLabel &&
				order.serviceFeeLabel !== DEFAULT_SERVICE_FEE_LABEL
					? order.serviceFeeLabel
					: labels.serviceFee
			totals.push([feeLabel, money(order.serviceFeeCents)])
		}
		if (order.packagingFeeCents > 0) {
			const feeLabel =
				order.packagingFeeLabel &&
				order.packagingFeeLabel !== DEFAULT_PACKAGING_FEE_LABEL
					? order.packagingFeeLabel
					: labels.packagingFee
			totals.push([feeLabel, money(order.packagingFeeCents)])
		}
		totals.push([labels.tax, money(order.taxCents)])
		totals.push([labels.total, money(order.totalCents)])
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
	const end = dir === 'rtl' ? 'left' : 'right'
	const logo = safeUrl(theme.logoUrl)
	const brandName = theme.organizationName || input.restaurantName
	const linkUrl = safeUrl(input.linkUrl)

	const detailRows = rows
		.map(
			([label, value]) =>
				`<tr><td style="padding:6px 0;color:${muted};font-size:13px;text-align:${align};width:38%;vertical-align:top">${escapeHtml(label)}</td><td style="padding:6px 0;color:${foreground};font-size:15px;text-align:${align};white-space:pre-line" dir="auto">${escapeHtml(value)}</td></tr>`,
		)
		.join('')

	const itemRows = lines
		.map((line) => {
			const name = getLocalizedMenuValue(line.itemName, locale, defaultLocale)
			const choices = lineChoices(line, locale, defaultLocale)
			const choicesHtml = choices
				? `<div style="font-size:12px;color:${muted};margin-top:2px" dir="auto">${escapeHtml(choices)}</div>`
				: ''
			const note = line.instructions?.trim()
			const noteHtml = note
				? `<div style="font-size:12px;color:${muted};font-style:italic;margin-top:2px" dir="auto">“${escapeHtml(note)}”</div>`
				: ''
			return `<tr><td style="padding:8px 0;color:${foreground};font-size:14px;text-align:${align};vertical-align:top;width:32px">${escapeHtml(String(line.quantity))}×</td><td style="padding:8px 0;color:${foreground};font-size:14px;text-align:${align};vertical-align:top"><div dir="auto">${escapeHtml(name)}</div>${choicesHtml}${noteHtml}</td><td style="padding:8px 0;color:${foreground};font-size:14px;text-align:${end};vertical-align:top;white-space:nowrap">${escapeHtml(money(line.totalCents))}</td></tr>`
		})
		.join('')
	const itemsHtml = itemRows
		? `<div style="margin-top:20px;font-size:13px;color:${muted};text-align:${align}">${escapeHtml(labels.items)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${border}">${itemRows}</table>`
		: ''
	const totalsHtml = totals.length
		? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${border};margin-top:4px">${totals
				.map(
					([label, value], index) =>
						`<tr><td style="padding:4px 0;color:${index === totals.length - 1 ? foreground : muted};font-size:${index === totals.length - 1 ? 15 : 13}px;${index === totals.length - 1 ? 'font-weight:700;' : ''}text-align:${align}">${escapeHtml(label)}</td><td style="padding:4px 0;color:${foreground};font-size:${index === totals.length - 1 ? 15 : 13}px;${index === totals.length - 1 ? 'font-weight:700;' : ''}text-align:${end};white-space:nowrap">${escapeHtml(value)}</td></tr>`,
				)
				.join('')}</table>`
		: ''

	const ctaHtml = linkUrl
		? `<div style="margin-top:24px;text-align:${align}"><a href="${escapeHtml(linkUrl)}" style="display:inline-block;padding:12px 22px;background:${primary};color:${primaryForeground};text-decoration:none;border-radius:${radius}px;font-size:15px;font-weight:600">${escapeHtml(labels.viewOrder)}</a></div>`
		: ''
	const inviteLinks =
		input.kind === 'receipt'
			? (input.appInvite ?? []).flatMap((entry) => {
					const url = safeUrl(entry.url)
					return url
						? [
								{
									url,
									label:
										entry.store === 'app_store'
											? labels.storeAppStore
											: labels.storePlayStore,
								},
							]
						: []
				})
			: []
	const inviteHtml = inviteLinks.length
		? `<div style="margin-top:20px;padding-top:16px;border-top:1px solid ${border};text-align:${align}"><div style="font-size:14px;font-weight:600;color:${foreground};margin-bottom:8px">${escapeHtml(labels.trackInApp)}</div>${inviteLinks
				.map(
					(link) =>
						`<a href="${escapeHtml(link.url)}" style="display:inline-block;margin:0 8px 8px 0;padding:8px 14px;border:1px solid ${border};color:${foreground};text-decoration:none;border-radius:${radius}px;font-size:13px">${escapeHtml(link.label)}</a>`,
				)
				.join('')}</div>`
		: ''
	const codeLinks =
		input.kind === 'receipt'
			? (input.receiptCodes ?? []).flatMap((code) => {
					const url = safeUrl(code.url)
					return url && code.caption.trim()
						? [{ url, caption: code.caption.trim() }]
						: []
				})
			: []
	const codesHtml = codeLinks.length
		? `<div style="margin-top:20px;padding-top:16px;border-top:1px solid ${border};text-align:${align}">${codeLinks
				.map(
					(link) =>
						`<p style="margin:0 0 8px;font-size:14px" dir="auto"><a href="${escapeHtml(link.url)}" style="color:${foreground};text-decoration:underline">${escapeHtml(link.caption)}</a></p>`,
				)
				.join('')}</div>`
		: ''
	const welcomeLine =
		input.kind === 'receipt' &&
		input.welcomeBonus &&
		input.welcomeBonus.points > 0
			? fillCopy(labels.welcomeBonusLine, {
					points: new Intl.NumberFormat(locale).format(
						input.welcomeBonus.points,
					),
					unit:
						input.welcomeBonus.unitLabel === 'stars'
							? labels.starsUnit
							: labels.pointsUnit,
				})
			: null
	const welcomeHtml = welcomeLine
		? `<p style="margin:0 0 14px;padding:10px 12px;border:1px solid ${border};border-radius:${Math.max(4, Math.min(8, radius))}px;font-size:14px;font-weight:600;color:${foreground};text-align:${align}" dir="auto">${escapeHtml(welcomeLine)}</p>`
		: ''
	const logoHtml = logo
		? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(brandName)}" style="max-height:48px;max-width:200px;margin-bottom:16px;display:block" />`
		: `<div style="font-size:16px;font-weight:700;color:${foreground};margin-bottom:16px;font-family:${headingFont}">${escapeHtml(brandName)}</div>`

	const html = `<!doctype html>
<html lang="${locale}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(copy.subject)}</title></head>
<body dir="${dir}" style="margin:0;padding:0;background:${background};font-family:${bodyFont}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${dir}" style="background:${background}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" dir="${dir}" style="max-width:560px;background:${card};border:1px solid ${border};border-radius:${radius}px"><tr><td style="padding:28px;text-align:${align}">
${logoHtml}
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:${foreground};font-family:${headingFont}">${escapeHtml(copy.heading)}</h1>
<p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:${foreground}">${escapeHtml(copy.lead)}</p>
${welcomeHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${border}">${detailRows}</table>
${itemsHtml}${totalsHtml}${ctaHtml}${inviteHtml}${codesHtml}
<p style="margin:28px 0 0;font-size:12px;color:${muted}">${escapeHtml(labels.footer)}</p>
</td></tr></table>
</td></tr></table>
</body>
</html>`

	const textLines = [copy.heading, '', copy.lead]
	if (welcomeLine) textLines.push('', welcomeLine)
	textLines.push('')
	for (const [label, value] of rows) textLines.push(`${label}: ${value}`)
	if (lines.length > 0) {
		textLines.push('', `${labels.items}:`)
		for (const line of lines) {
			const name = getLocalizedMenuValue(line.itemName, locale, defaultLocale)
			const choices = lineChoices(line, locale, defaultLocale)
			textLines.push(
				`${line.quantity}x ${name}${choices ? ` (${choices})` : ''}  ${money(line.totalCents)}`,
			)
		}
		textLines.push('')
		for (const [label, value] of totals) textLines.push(`${label}: ${value}`)
	}
	if (linkUrl) textLines.push('', `${labels.viewOrder}: ${linkUrl}`)
	if (inviteLinks.length > 0) {
		textLines.push('', `${labels.trackInApp}:`)
		for (const link of inviteLinks) textLines.push(`${link.label}: ${link.url}`)
	}
	for (const link of codeLinks)
		textLines.push('', `${link.caption}: ${link.url}`)
	textLines.push('', labels.footer)

	return { subject: copy.subject, html, text: textLines.join('\n') }
}

/**
 * The order text (`ready`, or `eta_changed` with its new time), with the link
 * appended. Short: the order number and the restaurant, nothing else.
 */
export function renderOrderSms(input: {
	kind: 'ready' | 'eta_changed' | 'out_for_delivery' | 'delivered'
	locale: string
	restaurantName: string
	order: OrderEmailOrder
	timeZone: string | null
	linkUrl: string | null
}): string {
	const locale = normalizeReservationLocale(input.locale)
	const copyset = orderCopyFor(locale)
	const base = fillCopy(copyset.sms[input.kind], {
		number: input.order.number,
		r: input.restaurantName,
		time:
			input.kind === 'eta_changed'
				? orderTimeLine(input.order, input.timeZone, locale).value
				: '',
	})
	const url = safeUrl(input.linkUrl)
	return url ? `${base} ${url}` : base
}
