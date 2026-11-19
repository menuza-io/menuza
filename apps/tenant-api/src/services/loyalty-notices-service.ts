import { type LoyaltyUnitLabel } from '@repo/loyalty'
import { sendSms } from '@repo/sms'
import {
	customers,
	customerSubscriptions,
	getTenantDb,
	loyaltyMembers,
	loyaltyNotices,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, isNotNull } from 'drizzle-orm'
import { getNodeRegion } from '../lib/region.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import {
	escapeHtml,
	formatWhen,
	normalizeReservationLocale,
	type ReservationEmailLocale,
} from '../lib/reservations-email.ts'
import { canSendTenantEmail, sendTenantEmail } from '../lib/tenant-email.ts'

export type LoyaltyNoticeKind =
	'tier_downgrade_warning' | 'expiry_30d' | 'expiry_7d' | 'expiry_enabled'

export type LoyaltyNoticePayload = {
	kind: LoyaltyNoticeKind
	memberId: string
	dedupeKey: string
	programName: string
	unitLabel: LoyaltyUnitLabel
	currentTierName?: string
	pendingTierName?: string | null
	actionDate?: number
	pointsNeeded?: number
	expiringPoints?: number
	expiresAt?: number
	months?: number
	now: number
}

export type LoyaltyNoticeDelivery = {
	orgId: string
	memberId: string
	kind: LoyaltyNoticeKind
	channel: 'email' | 'sms'
	to: string
	subject: string | null
	text: string
	html: string | null
}

type NoticeTransport = (delivery: LoyaltyNoticeDelivery) => Promise<void> | void

let customTransport: NoticeTransport | null = null

export function setLoyaltyNoticeTransportForTest(
	transport: NoticeTransport | null,
): void {
	customTransport = transport
}

function unitWord(unitLabel: LoyaltyUnitLabel, locale: string): string {
	if (locale === 'ar') return unitLabel === 'stars' ? 'نجمة' : 'نقطة'
	return unitLabel === 'stars' ? 'stars' : 'points'
}

function renderNoticeMessage(
	input: LoyaltyNoticePayload,
	locale: ReservationEmailLocale,
	restaurantName: string,
	timeZone: string,
): { subject: string; text: string; html: string; sms: string } {
	const ar = locale === 'ar'
	const dir = ar ? 'rtl' : 'ltr'
	const unit = unitWord(input.unitLabel, locale)
	const fmt = new Intl.NumberFormat(locale)

	let subject = ''
	let headline = ''
	let body = ''
	let sms = ''

	if (input.kind === 'tier_downgrade_warning') {
		const dateText = input.actionDate
			? formatWhen(input.actionDate, timeZone, locale).date
			: ''
		const tier = input.currentTierName ?? ''
		const nextTier = input.pendingTierName ?? null
		const needed = input.pointsNeeded ?? 0
		if (ar) {
			subject = `${input.programName}: تنبيه بخصوص مستوى ${tier}`
			headline = `حافظ على مستوى ${tier}`
			body = nextTier
				? `سيتغير مستواك من ${tier} إلى ${nextTier} في ${dateText} ما لم تجمع ${fmt.format(needed)} ${unit} مؤهلة قبل ذلك.`
				: `سينتهي مستوى ${tier} في ${dateText} ما لم تجمع ${fmt.format(needed)} ${unit} مؤهلة قبل ذلك.`
			sms = `${restaurantName}: تذكير بمستوى ${tier} قبل ${dateText}.`
		} else {
			subject = `${input.programName}: Keep your ${tier} tier`
			headline = `Your ${tier} tier review is coming up`
			body = nextTier
				? `Your ${tier} tier will move to ${nextTier} on ${dateText} unless you earn ${fmt.format(needed)} more qualifying ${unit}.`
				: `Your ${tier} tier benefits will end on ${dateText} unless you earn ${fmt.format(needed)} more qualifying ${unit}.`
			sms = `${restaurantName}: Keep your ${tier} tier before ${dateText}.`
		}
	} else if (input.kind === 'expiry_enabled') {
		const months = input.months ?? 12
		const pts = fmt.format(input.expiringPoints ?? 0)
		const dateText = input.expiresAt
			? formatWhen(input.expiresAt, timeZone, locale).date
			: ''
		if (ar) {
			subject = `${input.programName}: تحديث مدة صلاحية النقاط`
			headline = `قاعدة جديدة لصلاحية النقاط (${months} شهرًا)`
			body = `رصيدك الحالي (${pts} ${unit}) سيظل صالحًا بالكامل حتى ${dateText}.`
			sms = `${restaurantName}: رصيدك (${pts} ${unit}) صالح حتى ${dateText}.`
		} else {
			subject = `${input.programName}: Points expiry update`
			headline = `Points now expire after ${months} months`
			body = `Your existing ${pts} ${unit} remain valid for a full period until ${dateText}.`
			sms = `${restaurantName}: Your ${pts} ${unit} remain valid until ${dateText}.`
		}
	} else {
		const pts = fmt.format(input.expiringPoints ?? 0)
		const dateText = input.expiresAt
			? formatWhen(input.expiresAt, timeZone, locale).date
			: ''
		const soon = input.kind === 'expiry_7d'
		if (ar) {
			subject = `${input.programName}: ${pts} ${unit} ستنتهي قريبًا`
			headline = soon
				? `تنتهي صلاحية النقاط خلال أسبوع`
				: `تذكير بصلاحية النقاط`
			body = `لديك ${pts} ${unit} ستنتهي صلاحيتها في ${dateText} إذا لم تُستخدم.`
			sms = `${restaurantName}: ${pts} ${unit} تنتهي في ${dateText}.`
		} else {
			subject = `${input.programName}: ${pts} ${unit} expiring ${soon ? 'soon' : 'in 30 days'}`
			headline = soon
				? `${pts} ${unit} expire within 7 days`
				: `${pts} ${unit} expire soon`
			body = `You have ${pts} ${unit} scheduled to expire on ${dateText}.`
			sms = `${restaurantName}: ${pts} ${unit} expire on ${dateText}.`
		}
	}

	const text = `${headline}\n\n${body}\n\n${restaurantName}`
	const html = `<!doctype html><html lang="${locale}" dir="${dir}"><body dir="${dir}" style="font-family:sans-serif;padding:20px;color:#111827"><h2 style="margin:0 0 12px">${escapeHtml(headline)}</h2><p style="margin:0 0 16px;line-height:1.5">${escapeHtml(body)}</p><p style="margin:0;color:#6b7280;font-size:13px">${escapeHtml(restaurantName)}</p></body></html>`
	return { subject, text, html, sms }
}

/**
 * Dispatches one transactional loyalty notice outside write transactions,
 * deduplicated per `(memberId, kind, dedupeKey)` and respecting channel unsubscribes.
 */
export async function dispatchLoyaltyNotice(
	orgId: string,
	input: LoyaltyNoticePayload,
	options: { db?: TenantDatabase; timeZone?: string } = {},
): Promise<{ sent: boolean; channel: 'email' | 'sms' | 'none' }> {
	const db = options.db ?? (await getTenantDb(orgId))
	const existing = await db
		.select({ id: loyaltyNotices.id })
		.from(loyaltyNotices)
		.where(
			and(
				eq(loyaltyNotices.memberId, input.memberId),
				eq(loyaltyNotices.kind, input.kind),
				eq(loyaltyNotices.dedupeKey, input.dedupeKey),
			),
		)
		.get()
	if (existing) {
		return { sent: false, channel: 'none' }
	}

	const row = await db
		.select({
			status: loyaltyMembers.status,
			customerId: loyaltyMembers.customerId,
			email: customers.email,
			phone: customers.phone,
			phoneVerified: customers.phoneVerified,
		})
		.from(loyaltyMembers)
		.leftJoin(customers, eq(customers.id, loyaltyMembers.customerId))
		.where(eq(loyaltyMembers.id, input.memberId))
		.get()
	if (!row || row.status !== 'active' || !row.customerId) {
		return { sent: false, channel: 'none' }
	}

	const suppressed = await db
		.select({ channel: customerSubscriptions.channel })
		.from(customerSubscriptions)
		.where(
			and(
				eq(customerSubscriptions.customerId, row.customerId),
				isNotNull(customerSubscriptions.unsubscribedAt),
			),
		)
		.all()
	const blockedChannels = new Set<string>(suppressed.map((s) => s.channel))

	let restaurantName = input.programName
	let locale: ReservationEmailLocale = 'en'
	let timeZone = options.timeZone ?? 'UTC'
	try {
		const ctx = await getReservationsContext(orgId)
		if (ctx) {
			restaurantName =
				ctx.organization.emailTheme?.organizationName ||
				ctx.organization.name ||
				restaurantName
			locale = normalizeReservationLocale(ctx.organization.defaultLocale)
			if (!options.timeZone && ctx.locations[0]?.timeZone) {
				timeZone = ctx.locations[0].timeZone
			}
		}
	} catch {
		// Isolated service tests may run without published organization context.
	}

	const copy = renderNoticeMessage(input, locale, restaurantName, timeZone)
	let usedChannel: 'email' | 'sms' | 'none' = 'none'

	const canEmail =
		Boolean(row.email) &&
		!blockedChannels.has('email') &&
		(customTransport !== null || canSendTenantEmail())
	const canSms =
		Boolean(row.phoneVerified && row.phone) &&
		!blockedChannels.has('sms') &&
		(customTransport !== null || getNodeRegion() === 'us')

	if (canEmail && row.email) {
		try {
			if (customTransport) {
				await customTransport({
					orgId,
					memberId: input.memberId,
					kind: input.kind,
					channel: 'email',
					to: row.email,
					subject: copy.subject,
					text: copy.text,
					html: copy.html,
				})
				usedChannel = 'email'
			} else {
				const res = await sendTenantEmail({
					to: row.email,
					subject: copy.subject,
					html: copy.html,
					text: copy.text,
					capture: {
						orgId,
						messageKind: `loyalty_${input.kind}`,
					},
				})
				if (res.status === 'success') {
					usedChannel = 'email'
				}
			}
		} catch {
			usedChannel = 'none'
		}
	}

	if (usedChannel === 'none' && canSms && row.phone) {
		try {
			if (customTransport) {
				await customTransport({
					orgId,
					memberId: input.memberId,
					kind: input.kind,
					channel: 'sms',
					to: row.phone,
					subject: null,
					text: copy.sms,
					html: null,
				})
				usedChannel = 'sms'
			} else {
				await sendSms({ to: row.phone, message: copy.sms })
				usedChannel = 'sms'
			}
		} catch {
			usedChannel = 'none'
		}
	}

	const storedPayload: Record<string, unknown> = {
		...(input.expiringPoints !== undefined
			? { expiringPoints: input.expiringPoints }
			: {}),
		...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
		...(input.currentTierName
			? { currentTierName: input.currentTierName }
			: {}),
		...(input.pendingTierName !== undefined
			? { pendingTierName: input.pendingTierName }
			: {}),
	}

	await db
		.insert(loyaltyNotices)
		.values({
			memberId: input.memberId,
			kind: input.kind,
			dedupeKey: input.dedupeKey,
			channel: usedChannel,
			payload: storedPayload,
			sentAt: input.now,
		})
		.onConflictDoNothing({
			target: [
				loyaltyNotices.memberId,
				loyaltyNotices.kind,
				loyaltyNotices.dedupeKey,
			],
		})

	return { sent: usedChannel !== 'none', channel: usedChannel }
}
