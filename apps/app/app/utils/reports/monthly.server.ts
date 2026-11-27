import {
	and,
	db,
	eq,
	MonthlyResultsDelivery,
	Organization,
	User,
	UserOrganization,
} from '@repo/database'
import { sendEmail } from '@repo/email'
import {
	DEFAULT_DELIVERY_COMMISSION_BP,
	figureLabels,
	FIGURES,
	figureValue,
	formatFigureEntry,
	keptByOrderingDirect,
	MONTHLY_FIGURES,
	MONTHLY_PRESET,
	monthlyAsOf,
	previousMonthKey,
	renderSummaryEmail,
	summaryLines,
	visibleFigures,
	type EmailLocale,
	type FigureEntry,
	type FigureId,
	type FigureModule,
	type FigureValue,
	type SummaryLine,
} from '@repo/reports'
import {
	reportFiguresResponseSchema,
	type ReportFiguresRequest,
} from '@repo/reports/figures-contract'
import { localDateKey } from '@repo/reports/schedule'
import { localParts } from '@repo/staffing'
import { resolveDomainAlertRecipients } from '#app/utils/domains/notify.server.ts'
import { readLiveEnv } from '#app/utils/env.server.ts'
import { resolveReportGrantsForRequest } from '#app/utils/staffing/report-grants.server.ts'
import { resolveFigureModules, reviewFigureValue } from './modules.server.ts'
import { postRegionalReports } from './regional-reports.server.ts'
import {
	monthlyResultsEmailEnabled,
	reportUnsubscribeUrl,
} from './report-unsubscribe.server.ts'
import { resolveReportTokenGrantsForMember } from './token-grants.server.ts'
import { defaultReportingTimeZone } from './schedules.server.ts'

/**
 * Monthly results (#221), App side: which figures a viewer sees, the email on
 * the 2nd of each month, and the figures behind the "Kept by ordering direct"
 * estimate. The figures themselves are report definitions (`summary-figures`)
 * run by the region's analytics engine, so the page, the email and the Reports
 * pages cannot disagree; only totals reach this server and the email.
 */

/** The hour (organization reporting time) from which the month's email goes out on the 2nd. */
export const MONTHLY_EMAIL_HOUR = 8

/** At most two modules are named as "Not switched on yet" in one summary. */
export const MAX_OFF_MODULE_LINES = 2

export const MODULE_LABELS: Record<FigureModule, string> = {
	staffing_labor: 'Labor',
	reservations: 'Reservations',
	phone_agent: 'Phone agent',
	marketing: 'Marketing',
	loyalty: 'Loyalty',
}
const MODULE_LABELS_AR: Record<FigureModule, string> = {
	staffing_labor: 'العمالة',
	reservations: 'الحجوزات',
	phone_agent: 'وكيل الهاتف',
	marketing: 'التسويق',
	loyalty: 'الولاء',
}

/** The figures a member sees and the modules to name as off (at most two). */
export function planMonthlyFigures(input: {
	grants: ReadonlySet<string>
	modulesOn: ReadonlySet<FigureModule>
}) {
	const { shown, off } = visibleFigures(MONTHLY_FIGURES, input)
	return {
		shown,
		off: off.slice(0, MAX_OFF_MODULE_LINES),
	}
}

/** The rate and the figures behind "Kept by ordering direct". */
export function keptFor(
	figures: readonly FigureValue[],
	commissionBp: number,
): FigureEntry[] | null {
	const online = figures.find((f) => f.id === 'onlineSales')
	return online ? keptByOrderingDirect(online.entries, commissionBp) : null
}

export type PartialMonth = { since: string } | null

/**
 * The first summary for a new restaurant covers a partial month and says so:
 * the organization was created inside the month.
 */
export function partialMonthFor(month: string, createdAt: Date): PartialMonth {
	const key = `${createdAt.getUTCFullYear()}-${String(createdAt.getUTCMonth() + 1).padStart(2, '0')}`
	return key === month ? { since: createdAt.toISOString().slice(0, 10) } : null
}

function monthLabel(month: string, locale: EmailLocale) {
	const [y, m] = month.split('-').map(Number) as [number, number]
	return new Intl.DateTimeFormat(locale, {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC',
	}).format(new Date(Date.UTC(y, m - 1, 1)))
}

export function monthlyEmailLines(input: {
	figures: readonly FigureValue[]
	commissionBp: number
	locale: EmailLocale
}): SummaryLine[] {
	const labels = figureLabels(input.locale)
	const shown = input.figures.filter((f) => f.id !== 'onlineSales')
	const lines = summaryLines(shown, labels, input.locale)
	const kept = keptFor(input.figures, input.commissionBp)
	if (kept) {
		const rate = `${input.commissionBp / 100}%`
		const estimate = input.locale === 'ar' ? 'تقدير' : 'Estimate'
		lines.push({
			label:
				input.locale === 'ar' ? 'ما وفّره الطلب المباشر' : 'Kept by ordering direct',
			values: (kept.length > 0 ? kept : [{ currency: null, value: 0 }]).map(
				(entry) => formatFigureEntry(entry, 'currency', input.locale),
			),
			changes: kept.map(() => null),
			tag: `${estimate} · ${rate}`,
		})
	}
	return lines
}

type Recipient = {
	userId: string
	email: string
}

/** Owners and admins who have not switched the monthly email off. */
export async function resolveMonthlyRecipients(
	organizationId: string,
): Promise<Recipient[]> {
	const candidates = await resolveDomainAlertRecipients(organizationId)
	const out: Recipient[] = []
	for (const candidate of candidates) {
		if (await monthlyResultsEmailEnabled(candidate.userId, organizationId)) {
			out.push(candidate)
		}
	}
	return out
}

export type RunMonthlyDeps = {
	now?: Date
	post?: typeof postRegionalReports
	sendEmailImpl?: typeof sendEmail
}

export type RunMonthlySummary = {
	organizations: number
	sent: number
	skipped: number
	failed: number
}

/**
 * Sends the monthly results emails that are due (hourly job). On the 2nd of a
 * month, from 08:00 in an organization's reporting time zone, each owner and
 * admin gets one email for the month before, with the lines their own grants
 * allow. Idempotent: `MonthlyResultsDelivery` is unique per person and month.
 */
export async function runMonthlyResultsEmails(
	deps: RunMonthlyDeps = {},
): Promise<RunMonthlySummary> {
	const now = deps.now ?? new Date()
	const post = deps.post ?? postRegionalReports
	const send = deps.sendEmailImpl ?? sendEmail
	const summary: RunMonthlySummary = {
		organizations: 0,
		sent: 0,
		skipped: 0,
		failed: 0,
	}
	const orgs = await db
		.select({
			id: Organization.id,
			name: Organization.name,
			slug: Organization.slug,
			dataRegion: Organization.dataRegion,
			createdAt: Organization.createdAt,
			commissionBp: Organization.deliveryCommissionBp,
		})
		.from(Organization)
		.where(eq(Organization.hasProvisionedDb, true))
	for (const org of orgs) {
		const timeZone = await defaultReportingTimeZone(org.id)
		const local = localParts(now.getTime(), timeZone)
		if (local.day !== 2 || local.hour < MONTHLY_EMAIL_HOUR) continue
		const thisMonth = localDateKey(now, timeZone).slice(0, 7)
		const month = previousMonthKey(thisMonth)
		// An organization that did not exist yet in that month has no summary.
		const monthEnd = new Date(`${thisMonth}-01T00:00:00Z`)
		if (org.createdAt >= monthEnd) continue
		summary.organizations += 1
		const result = await sendOrganizationMonthly({
			org,
			month,
			timeZone,
			post,
			send,
		})
		summary.sent += result.sent
		summary.skipped += result.skipped
		summary.failed += result.failed
	}
	return summary
}

async function sendOrganizationMonthly(input: {
	org: {
		id: string
		name: string
		slug: string
		dataRegion: string
		createdAt: Date
		commissionBp: number
	}
	month: string
	timeZone: string
	post: typeof postRegionalReports
	send: typeof sendEmail
}) {
	const { org, month } = input
	const counts = { sent: 0, skipped: 0, failed: 0 }
	const recipients = await resolveMonthlyRecipients(org.id)
	if (recipients.length === 0) return counts
	// Skip people already sent this month before doing any work for them.
	const already = await db
		.select({ userId: MonthlyResultsDelivery.userId })
		.from(MonthlyResultsDelivery)
		.where(
			and(
				eq(MonthlyResultsDelivery.organizationId, org.id),
				eq(MonthlyResultsDelivery.month, month),
			),
		)
	const done = new Set(already.map((row) => row.userId))
	const pending = recipients.filter((r) => !done.has(r.userId))
	if (pending.length === 0) return counts

	const modules = await resolveFigureModules(org.id)
	const placeholder = new Request('https://job.invalid/')
	type Grants = ReportFiguresRequest['groups'][number]['grants']
	const people: Array<{ recipient: Recipient; grants: Grants }> = []
	for (const recipient of pending) {
		const token = await resolveReportTokenGrantsForMember({
			userId: recipient.userId,
			organizationId: org.id,
		})
		const subjectGrants = await resolveReportGrantsForRequest(
			placeholder,
			recipient.userId,
			org.id,
		)
		const subjects = [
			...token.subjects,
			...(subjectGrants.includes('reviews') ? ['reviews'] : []),
		]
		people.push({
			recipient,
			grants: {
				subjects,
				scopeIds: token.scopeIds,
				...(token.locationIds === undefined ? {} : { locationIds: token.locationIds }),
				modules,
			},
		})
	}

	// One region request per distinct set of grants.
	const groupKey = (grants: Grants) =>
		JSON.stringify([[...grants.subjects].sort(), grants.scopeIds, grants.locationIds, grants.modules])
	const groups = new Map<string, Grants>()
	for (const person of people) groups.set(groupKey(person.grants), person.grants)
	const keys = [...groups.keys()]
	const regionIds = MONTHLY_FIGURES.filter((id) => FIGURES[id].source === 'region')
	const request: ReportFiguresRequest = {
		orgId: org.id,
		month,
		timeZone: input.timeZone,
		groups: keys.map((key, index) => ({
			key: `g${index}`,
			grants: groups.get(key)!,
			figureIds: [...regionIds] as ReportFiguresRequest['groups'][number]['figureIds'],
		})),
	}
	let regional: Map<string, FigureValue[]>
	try {
		const response = await input.post({
			dataRegion: org.dataRegion,
			path: 'figures',
			body: request as unknown as Record<string, unknown>,
		})
		if (!response.ok) throw new Error(`region_${response.status}`)
		const parsed = reportFiguresResponseSchema.parse(await response.json())
		regional = new Map(
			parsed.groups.map((g) => [
				g.key,
				g.figures.map((f) => ({ ...f, id: f.id as FigureId })),
			]),
		)
	} catch {
		counts.failed += pending.length
		return counts
	}

	const locale: EmailLocale = org.dataRegion === 'ksa' ? 'ar' : 'en'
	const base = readLiveEnv('BASE_URL').replace(/\/$/u, '')
	const asOf = monthlyAsOf(month)
	const partial = partialMonthFor(month, org.createdAt)
	for (const person of people) {
		const index = keys.indexOf(groupKey(person.grants))
		const figures = [...(regional.get(`g${index}`) ?? [])]
		const grantSet = new Set(person.grants.subjects)
		const plan = planMonthlyFigures({
			grants: grantSet,
			modulesOn: new Set(modules),
		})
		// Control-plane figures (reviews) are the App's own aggregate.
		for (const id of plan.shown) {
			if (FIGURES[id].source !== 'control-plane') continue
			figures.push(
				await reviewFigureValue({
					organizationId: org.id,
					id: id as 'newReviews' | 'averageRating',
					preset: MONTHLY_PRESET,
					asOf,
					timeZone: input.timeZone,
				}),
			)
		}
		const order = new Map(MONTHLY_FIGURES.map((id, i) => [id, i] as const))
		figures.sort((a, b) => (order.get(a.id as FigureId) ?? 0) - (order.get(b.id as FigureId) ?? 0))
		if (figures.length === 0) {
			counts.skipped += 1
			continue
		}
		const notes = [
			...(partial
				? [
						locale === 'ar'
							? `شهر جزئي: من ${partial.since}.`
							: `Partial month: since ${partial.since}.`,
					]
				: []),
			...plan.off.map(
				(module) =>
					`${(locale === 'ar' ? MODULE_LABELS_AR : MODULE_LABELS)[module]}: ${locale === 'ar' ? 'غير مفعّل بعد' : 'Not switched on yet'}`,
			),
			locale === 'ar'
				? `"ما وفّره الطلب المباشر" تقدير بمعدل عمولة ${org.commissionBp / 100}% لتطبيقات التوصيل، وليس مبلغًا حقيقيًا.`
				: `"Kept by ordering direct" is an estimate at a ${org.commissionBp / 100}% delivery-app commission, not real money.`,
		]
		const rendered = renderSummaryEmail({
			locale,
			organizationName: org.name,
			title: locale === 'ar' ? 'نتائج الشهر' : 'Monthly results',
			subtitle: monthLabel(month, locale),
			compareLabel: locale === 'ar' ? 'مقارنة بالشهر السابق' : 'vs the month before',
			lines: monthlyEmailLines({
				figures,
				commissionBp: org.commissionBp ?? DEFAULT_DELIVERY_COMMISSION_BP,
				locale,
			}),
			notes,
			reportUrl: `${base}/${org.slug}/reports/monthly?month=${month}`,
			unsubscribeUrl: reportUnsubscribeUrl({
				kind: 'monthly',
				organizationId: org.id,
				userId: person.recipient.userId,
			}),
		})
		// Claim the month first so two overlapping runs cannot both send.
		const claimed = await db
			.insert(MonthlyResultsDelivery)
			.values({ organizationId: org.id, userId: person.recipient.userId, month })
			.onConflictDoNothing()
			.returning({ id: MonthlyResultsDelivery.id })
		if (claimed.length === 0) {
			counts.skipped += 1
			continue
		}
		try {
			const sent = await input.send({
				to: person.recipient.email,
				subject: rendered.subject,
				html: rendered.html,
				text: rendered.text,
			})
			if (sent.status === 'error') throw new Error('send_failed')
			counts.sent += 1
		} catch {
			// Give the claim back so the next hourly run tries again.
			await db
				.delete(MonthlyResultsDelivery)
				.where(eq(MonthlyResultsDelivery.id, claimed[0]!.id))
			counts.failed += 1
		}
	}
	return counts
}

