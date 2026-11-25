import { buildLink } from '@repo/common/links'
import { type CateringAlertKind } from '@repo/common/catering'
import { sendSms } from '@repo/sms'
import {
	getTenantDb,
	restaurantOrders,
	type CateringQuote,
	type RestaurantOrder,
} from '@repo/tenant-db'
import { and, eq, isNull } from 'drizzle-orm'

import { postCateringNotify } from '../lib/catering-notify.ts'
import {
	renderCateringEmail,
	type CateringEmailKind,
} from '../lib/catering-email.ts'
import { deriveBalanceToken, deriveQuoteToken } from '../lib/catering-tokens.ts'
import { errorLogFields } from '../lib/error-log.ts'
import {
	isOrdersEmailEnabled,
	isOrdersSmsEnabled,
} from '../lib/orders-switches.ts'
import { getNodeRegion } from '../lib/region.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import {
	formatMoney,
	normalizeReservationLocale,
} from '../lib/reservations-email.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { cateringBalanceOwedCents } from './catering-orders.ts'

/**
 * Everything catering says to a guest or to the team (#124, #361): the quote
 * email, the confirmation once the deposit clears, the balance link and its
 * reminders, and the alert posted to the App for the members who chose to be
 * told. The alert carries ids and a count only; the guest's address and phone
 * are read from the row only to send, and never logged.
 */

type SiteFacts = {
	restaurantName: string
	siteOrigin: string | null
	defaultLocale: string
	theme: Parameters<typeof renderCateringEmail>[0]['theme']
	timeZone: (locationId: string) => string | null
}

async function siteFacts(orgId: string): Promise<SiteFacts> {
	const context = await getReservationsContext(orgId).catch(() => null)
	return {
		restaurantName:
			context?.organization.emailTheme.organizationName ||
			context?.organization.name ||
			'',
		siteOrigin: context?.organization.siteOrigin ?? null,
		defaultLocale: context?.organization.defaultLocale ?? 'en',
		theme: context?.organization.emailTheme ?? null,
		timeZone: (locationId) =>
			context?.locations.find((location) => location.id === locationId)
				?.timeZone ?? null,
	}
}

function prefixFor(locale: string, defaultLocale: string): string {
	return locale !== defaultLocale && locale !== 'en' ? `/${locale}` : ''
}

/** The guest's quote link: the capability rides in the URL fragment only. */
export function quoteLinkUrl(
	facts: Pick<SiteFacts, 'siteOrigin' | 'defaultLocale'>,
	orgId: string,
	quote: Pick<CateringQuote, 'id' | 'version' | 'locale'>,
): string | null {
	return buildLink(
		'catering_quote',
		{ quote: deriveQuoteToken(orgId, quote.id, quote.version) },
		{
			origin: facts.siteOrigin,
			localePrefix: prefixFor(quote.locale, facts.defaultLocale),
		},
	)
}

export function balanceLinkUrl(
	facts: Pick<SiteFacts, 'siteOrigin' | 'defaultLocale'>,
	orgId: string,
	order: Pick<RestaurantOrder, 'id' | 'balanceVersion' | 'locale'>,
): string | null {
	return buildLink(
		'catering_balance',
		{ balance: deriveBalanceToken(orgId, order.id, order.balanceVersion) },
		{
			origin: facts.siteOrigin,
			localePrefix: prefixFor(order.locale, facts.defaultLocale),
		},
	)
}

function firstName(name: string | null | undefined): string | null {
	const first = (name ?? '').trim().split(/\s+/)[0]
	return first || null
}

/** Sends the quote (or its updated version) to the guest. False when nothing could be sent. */
export async function sendCateringQuoteEmail(
	orgId: string,
	quote: CateringQuote,
	options: { updated: boolean },
): Promise<boolean> {
	if (!quote.contactEmail || !isOrdersEmailEnabled()) return false
	const facts = await siteFacts(orgId)
	const locale = normalizeReservationLocale(quote.locale)
	const rendered = renderCateringEmail({
		kind: options.updated ? 'quote_updated' : 'quote',
		locale,
		theme: facts.theme,
		restaurantName: facts.restaurantName,
		firstName: firstName(quote.contactName),
		eventAtMs: quote.eventAt,
		timeZone: facts.timeZone(quote.locationId),
		guestCount: quote.guestCount,
		currency: quote.currency,
		totalMinor: quote.totalCents,
		expiresAtMs: quote.expiresAt,
		note: quote.quoteNote,
		actionUrl: quoteLinkUrl(facts, orgId, quote),
	})
	const sent = await sendTenantEmail({
		to: quote.contactEmail,
		subject: rendered.subject,
		html: rendered.html,
		text: rendered.text,
		capture: { orgId, messageKind: 'catering_quote', messageId: quote.id },
	}).catch(() => ({ status: 'error' as const }))
	return sent.status !== 'error'
}

async function sendOrderEmail(
	orgId: string,
	order: RestaurantOrder,
	kind: CateringEmailKind,
	extra: { amountMinor?: number | null; balanceMinor?: number | null },
): Promise<boolean> {
	if (!order.contactEmail || !isOrdersEmailEnabled()) return false
	const facts = await siteFacts(orgId)
	const rendered = renderCateringEmail({
		kind,
		locale: normalizeReservationLocale(order.locale),
		theme: facts.theme,
		restaurantName: facts.restaurantName,
		firstName: firstName(order.contactName),
		eventAtMs: order.cateringEventAt?.getTime() ?? null,
		timeZone: order.locationTimezone ?? facts.timeZone(order.locationId),
		guestCount: order.guestCount,
		currency: order.currency,
		totalMinor: order.totalCents,
		amountMinor: extra.amountMinor ?? null,
		balanceMinor: extra.balanceMinor ?? null,
		dueAtMs: order.balanceDueAt?.getTime() ?? null,
		actionUrl:
			kind === 'confirmed' || kind === 'balance_paid'
				? extra.balanceMinor
					? balanceLinkUrl(facts, orgId, order)
					: null
				: balanceLinkUrl(facts, orgId, order),
	})
	const sent = await sendTenantEmail({
		to: order.contactEmail,
		subject: rendered.subject,
		html: rendered.html,
		text: rendered.text,
		capture: { orgId, messageKind: `catering_${kind}`, messageId: order.id },
	}).catch(() => ({ status: 'error' as const }))
	return sent.status !== 'error'
}

/** A text reminder, only for a guest who asked for texts, on the US node. */
async function sendReminderText(
	orgId: string,
	order: RestaurantOrder,
	kind: 'balance_reminder' | 'balance_overdue',
	amountMinor: number,
): Promise<boolean> {
	if (
		!order.smsUpdatesOptIn ||
		!order.contactPhone ||
		getNodeRegion() !== 'us' ||
		!isOrdersSmsEnabled()
	) {
		return false
	}
	const facts = await siteFacts(orgId)
	const link = balanceLinkUrl(facts, orgId, order)
	const amount = formatMoney(
		amountMinor,
		order.currency,
		normalizeReservationLocale(order.locale),
	)
	const message =
		kind === 'balance_overdue'
			? `${facts.restaurantName}: the ${amount} balance of your catering order is overdue.`
			: `${facts.restaurantName}: the ${amount} balance of your catering order is due soon.`
	try {
		await sendSms({
			to: order.contactPhone,
			message: link ? `${message} ${link}` : message,
		})
		return true
	} catch {
		return false
	}
}

/**
 * The balance link, after a deposit (with the confirmation) or on request.
 * Transactional: no marketing consent applies.
 */
export async function sendBalanceMessage(
	orgId: string,
	order: RestaurantOrder,
	kind: 'balance_link' | 'balance_reminder' | 'balance_overdue',
): Promise<boolean> {
	const owed = cateringBalanceOwedCents(order)
	if (owed <= 0) return false
	const emailed = await sendOrderEmail(orgId, order, kind, {
		amountMinor: owed,
		balanceMinor: owed,
	})
	const texted =
		kind === 'balance_link'
			? false
			: await sendReminderText(orgId, order, kind, owed)
	return emailed || texted
}

async function alert(
	orgId: string,
	kind: CateringAlertKind,
	order: Pick<RestaurantOrder, 'id' | 'locationId'>,
): Promise<'delivered' | 'retry' | 'rejected'> {
	return postCateringNotify({
		orgId,
		kind,
		locationId: order.locationId,
		refId: order.id,
		count: 1,
	})
}

/**
 * The deposit (or the whole total) cleared: tells the guest and the alert
 * members once. Claimed with a compare-and-set on `catering_confirmed_at`, so a
 * replayed payment event, a racing tick and a retry never send twice. Never
 * throws: the payment itself is already recorded.
 */
export async function onCateringOrderPaid(
	orgId: string,
	orderId: string,
): Promise<void> {
	try {
		const db = await getTenantDb(orgId)
		const [order] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, orderId))
			.limit(1)
		if (!order?.isCatering || order.paymentStatus !== 'paid') return
		const claimed = await db
			.update(restaurantOrders)
			.set({ cateringConfirmedAt: new Date() })
			.where(
				and(
					eq(restaurantOrders.id, orderId),
					isNull(restaurantOrders.cateringConfirmedAt),
				),
			)
			.returning({ id: restaurantOrders.id })
		if (claimed.length === 0) return
		const owed = cateringBalanceOwedCents(order)
		const sent = await sendOrderEmail(orgId, order, 'confirmed', {
			amountMinor: order.paidCents ?? order.depositCents,
			balanceMinor: owed,
		})
		if (!sent) {
			// Let a later paid event or the tick try again.
			await db
				.update(restaurantOrders)
				.set({ cateringConfirmedAt: null })
				.where(eq(restaurantOrders.id, orderId))
		}
		await alert(
			orgId,
			order.cateringQuoteId ? 'quote_paid' : 'order_placed',
			order,
		)
	} catch (error) {
		console.error(
			'Catering confirmation failed',
			orgId,
			orderId,
			errorLogFields(error),
		)
	}
}

/** The balance was paid in full: a receipt to the guest, a note to the team. */
export async function onCateringBalancePaid(
	orgId: string,
	orderId: string,
): Promise<void> {
	try {
		const db = await getTenantDb(orgId)
		const [order] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, orderId))
			.limit(1)
		if (!order?.isCatering) return
		await sendOrderEmail(orgId, order, 'balance_paid', {
			amountMinor: order.balancePaidCents,
			balanceMinor: 0,
		})
		await alert(orgId, 'balance_paid', order)
	} catch (error) {
		console.error(
			'Catering balance receipt failed',
			orgId,
			orderId,
			errorLogFields(error),
		)
	}
}

/** A guest's quote request reached the region: tells the alert members (ids and a count). */
export async function onCateringQuoteRequested(
	orgId: string,
	quote: Pick<CateringQuote, 'id' | 'locationId'>,
): Promise<void> {
	await alert(orgId, 'quote_request', {
		id: quote.id,
		locationId: quote.locationId,
	})
}

/** The same alert for the tick (day before an event, a balance overdue). */
export { alert as postCateringAlert }
