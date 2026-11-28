import { buildLink } from '@repo/common/links'
import { type RestaurantOrder, type TenantDatabase } from '@repo/tenant-db'
import { type ReservationsContext } from '@repo/reservations'
import { sendSms } from '@repo/sms'

import { errorLogFields } from './error-log.ts'
import { buildOrderLinkUrl } from './order-link.ts'
import { ORDER_SMS_CAP, reserveOrderSmsSlot } from './order-messages-sms-cap.ts'
import { orderProblemCopyFor } from './order-problem-copy.ts'
import { isOrdersEmailEnabled, isOrdersSmsEnabled } from './orders-switches.ts'
import { getNodeRegion } from './region.ts'
import { getReservationsContext } from './reservations-context.ts'
import {
	escapeHtml,
	formatMoney,
	normalizeReservationLocale,
} from './reservations-email.ts'
import { sendTenantEmail } from './tenant-email.ts'

/**
 * Tells the guest how a restaurant answered their order problem report (#191):
 * an email to the address on the order, and a text only when the guest ticked
 * "Text me order updates" on that order, on the US node, within the
 * organization's daily text cap. Transactional only, never marketing consent.
 *
 * Best effort and never throws: the answer is already stored and the order page
 * shows it, so a send that fails is logged by ids and not retried. The log
 * carries no address, number or message text.
 */

export type ProblemAnswerMessage = {
	action: 'refund' | 'credit' | 'reply' | 'close'
	/** Minor units of the refund or credit. */
	amountCents?: number
	/** The credit's code (shown once, in the message and on the order page). */
	creditCode?: string
	creditExpiresAt?: number
	/** What the operator wrote to the guest. */
	message?: string | null
}

export type ProblemNotifyDeps = {
	sendSms: (input: { to: string; message: string }) => Promise<unknown>
	getContext: (orgId: string) => Promise<ReservationsContext | null>
}

const defaultDeps: ProblemNotifyDeps = {
	sendSms: (input) => sendSms(input),
	getContext: (orgId) => getReservationsContext(orgId),
}
let depsOverride: Partial<ProblemNotifyDeps> = {}

/** Tests: replace the text sender. */
export function setProblemNotifyDepsForTest(
	deps: Partial<ProblemNotifyDeps> | null,
) {
	depsOverride = deps ?? {}
}

function nodeRegion(): 'us' | 'ksa' | null {
	try {
		return getNodeRegion()
	} catch {
		return null
	}
}

function fill(text: string, values: Record<string, string>): string {
	return text.replace(/\{(\w+)\}/g, (match, key: string) =>
		key in values ? values[key]! : match,
	)
}

function safeHex(value: string | null | undefined, fallback: string): string {
	return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
		? value
		: fallback
}

export async function notifyGuestOfProblemAnswer(input: {
	orgId: string
	db: TenantDatabase
	order: RestaurantOrder
	answer: ProblemAnswerMessage
	problemId: string
}): Promise<{
	email: 'sent' | 'skipped' | 'failed'
	sms: 'sent' | 'skipped' | 'failed'
}> {
	const result = {
		email: 'skipped' as 'sent' | 'skipped' | 'failed',
		sms: 'skipped' as 'sent' | 'skipped' | 'failed',
	}
	const { orgId, order, answer } = input
	try {
		const context = await (depsOverride.getContext ?? defaultDeps.getContext)(
			orgId,
		)
		if (!context) return result
		const locale = normalizeReservationLocale(
			order.locale,
			normalizeReservationLocale(context.organization.defaultLocale),
		)
		const copy = orderProblemCopyFor(locale)
		const restaurant =
			context.organization.emailTheme.organizationName ||
			context.organization.name
		const money = (cents: number | undefined) =>
			cents === undefined ? '' : formatMoney(cents, order.currency, locale)
		const siteOrigin = context.organization.siteOrigin
		const orderUrl = buildOrderLinkUrl({
			siteOrigin,
			orgId,
			orderId: order.id,
		})
		const creditUrl =
			answer.creditCode && siteOrigin
				? buildLink(
						'coupon',
						{ coupon: answer.creditCode, location: order.locationId },
						{ origin: siteOrigin },
					)
				: null
		const values = {
			number: order.number,
			r: restaurant,
			amount: money(answer.amountCents),
			code: answer.creditCode ?? '',
			date: answer.creditExpiresAt
				? new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : locale, {
						dateStyle: 'medium',
					}).format(new Date(answer.creditExpiresAt))
				: '',
		}
		const lead = fill(
			answer.action === 'refund'
				? copy.refund
				: answer.action === 'credit'
					? copy.credit
					: answer.action === 'reply'
						? copy.reply
						: copy.closed,
			values,
		)

		if (order.contactEmail && isOrdersEmailEnabled()) {
			try {
				const theme = context.organization.emailTheme
				const primary = safeHex(theme.primary, '#111827')
				const primaryText = safeHex(theme.primaryForeground, '#ffffff')
				const text = safeHex(theme.foreground, '#111827')
				const dir = locale === 'ar' ? 'rtl' : 'ltr'
				const button = (url: string | null, label: string) =>
					url
						? `<p style="margin:20px 0"><a href="${escapeHtml(url)}" style="background:${primary};color:${primaryText};padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">${escapeHtml(label)}</a></p>`
						: ''
				const html = `<!doctype html><html lang="${locale}" dir="${dir}"><body style="margin:0;padding:24px;font-family:system-ui,sans-serif;color:${text}"><div style="max-width:520px;margin:0 auto"><h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(copy.heading)}</h1><p style="margin:0 0 12px">${escapeHtml(lead)}</p>${
					answer.creditCode
						? `<p style="margin:0 0 4px">${escapeHtml(copy.creditCode)}</p><p style="font-size:22px;font-weight:700;letter-spacing:1px;margin:0 0 8px">${escapeHtml(answer.creditCode)}</p><p style="margin:0 0 12px">${escapeHtml(fill(copy.creditUntil, values))}</p>${button(creditUrl, copy.useCredit)}`
						: ''
				}${
					answer.message
						? `<p style="margin:16px 0 4px;opacity:.7">${escapeHtml(copy.messageLabel)}</p><blockquote style="margin:0;padding:8px 12px;border-inline-start:3px solid ${primary};white-space:pre-wrap">${escapeHtml(answer.message)}</blockquote>`
						: ''
				}${button(orderUrl, copy.viewOrder)}<p style="font-size:12px;opacity:.7;margin-top:24px">${escapeHtml(copy.footer)}</p></div></body></html>`
				const plain = [
					copy.heading,
					'',
					lead,
					answer.creditCode
						? `${copy.creditCode}: ${answer.creditCode}\n${fill(copy.creditUntil, values)}${creditUrl ? `\n${creditUrl}` : ''}`
						: '',
					answer.message ? `${copy.messageLabel}:\n${answer.message}` : '',
					orderUrl ? `${copy.viewOrder}: ${orderUrl}` : '',
					'',
					copy.footer,
				]
					.filter((part) => part !== '')
					.join('\n')
				const sent = await sendTenantEmail({
					to: order.contactEmail,
					subject: fill(copy.subject, values),
					html,
					text: plain,
					capture: {
						orgId,
						messageKind: 'order_problem_answer',
						messageId: input.problemId,
					},
				})
				result.email = sent.status === 'error' ? 'failed' : 'sent'
			} catch (error) {
				result.email = 'failed'
				console.warn(
					'Order problem answer email not sent',
					orgId,
					input.problemId,
					errorLogFields(error),
				)
			}
		}

		if (
			order.smsUpdatesOptIn &&
			order.contactPhone &&
			nodeRegion() === 'us' &&
			isOrdersSmsEnabled()
		) {
			try {
				const reserved = await reserveOrderSmsSlot(
					input.db,
					{ orgId, max: ORDER_SMS_CAP.max },
					Date.now(),
				)
				if (reserved) {
					const template =
						answer.action === 'refund'
							? copy.sms.refund
							: answer.action === 'credit'
								? copy.sms.credit
								: answer.action === 'reply'
									? copy.sms.reply
									: copy.sms.closed
					const base = fill(template, values)
					const url = answer.action === 'credit' ? creditUrl : orderUrl
					await (depsOverride.sendSms ?? defaultDeps.sendSms)({
						to: order.contactPhone,
						message: url ? `${base} ${url}` : base,
					})
					result.sms = 'sent'
				}
			} catch (error) {
				result.sms = 'failed'
				console.warn(
					'Order problem answer text not sent',
					orgId,
					input.problemId,
					errorLogFields(error),
				)
			}
		}
	} catch (error) {
		console.warn(
			'Order problem answer not sent',
			orgId,
			input.problemId,
			errorLogFields(error),
		)
	}
	return result
}
