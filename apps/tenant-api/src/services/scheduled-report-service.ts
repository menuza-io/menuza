import {
	DAILY_SUMMARY_FIGURES,
	DAILY_SUMMARY_PRESET,
	dailyAsOf,
	figureLabels,
	FIGURES,
	figureValue,
	formatFigureEntry,
	changeText,
	getCatalog,
	isReportRunError,
	personalFieldsUsed,
	renderSummaryEmail,
	renderTableEmail,
	reportToRows,
	summaryLines,
	visibleFigures,
	type EmailLocale,
	type FigureId,
	type FigureValue,
	type ReportDefinition,
	type ReportResult,
	type SummaryLine,
} from '@repo/reports'
import {
	type ReportGrants,
	type ReportRunSpec,
	type ReportSendRequest,
	type ReportSendResponse,
} from '@repo/reports/send-contract'
import { shiftDateKey } from '@repo/reports/schedule'
import {
	mintOperatorAnalyticsToken,
	type RestrictedReportSubject,
} from '@repo/reports/token'
import { consentBaseUrl, listUnsubscribeHeaders } from '../lib/email-consent.ts'
import { isReportEmailEnabled } from '../lib/report-email-switch.ts'
import { signReportCsvToken } from '../lib/report-csv-link.ts'
import { getOperatorAnalyticsToken } from '../lib/secrets.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { analyticsRoutes } from '../routes/analytics.ts'

/**
 * Runs and emails a scheduled report (#121), in the organization's own region.
 * The App's hourly job decides what is due and who may receive it; this runs
 * the definition with the SAME engine and route as `POST /analytics/query`
 * (in-process, with a short-lived token carrying exactly the recipient's
 * grants), renders the email and sends it with `sendTenantEmail`. Nothing
 * regional goes back to the App: a status per recipient.
 *
 * - A recipient whose grants do not cover the report is `skipped_no_access`,
 *   whatever the App said (the query route enforces them again).
 * - A definition that reads a personal field is refused before anything runs.
 * - The CSV is a signed link to this node (the sender has no attachments).
 */

type RunOutcome =
	| { ok: true; result: ReportResult }
	| { ok: false; kind: 'no_access' | 'failed'; reason: string }

export async function runReportInRegion(input: {
	orgId: string
	definition: ReportDefinition
	grants: ReportGrants
	timeZone: string
	asOf: Date
}): Promise<RunOutcome> {
	const signingSecret = getOperatorAnalyticsToken()
	if (!signingSecret) {
		return { ok: false, kind: 'failed', reason: 'reports_not_configured' }
	}
	const minted = await mintOperatorAnalyticsToken({
		signingSecret,
		userId: 'scheduled-report',
		orgId: input.orgId,
		role: 'operator',
		subjects: input.grants.subjects as RestrictedReportSubject[],
		scopeIds: input.grants.scopeIds,
		// Fail closed: a recipient with sales subjects but no location list sees none.
		locationIds:
			input.grants.locationIds === undefined ? [] : input.grants.locationIds,
	})
	const response = await analyticsRoutes.request('/query', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${minted.token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			definition: input.definition,
			timeZone: input.timeZone,
			asOf: input.asOf.toISOString(),
		}),
	})
	if (response.status === 403) {
		return { ok: false, kind: 'no_access', reason: 'forbidden_subject' }
	}
	const body = (await response.json().catch(() => null)) as
		| ReportResult
		| { error?: string }
		| null
	if (!response.ok || !body || isReportRunError(body as never)) {
		const code =
			body && typeof (body as { error?: unknown }).error === 'string'
				? (body as { error: string }).error
				: `status_${response.status}`
		return { ok: false, kind: 'failed', reason: code.slice(0, 80) }
	}
	return { ok: true, result: body as ReportResult }
}

type Built =
	| { kind: 'no_access' }
	| { kind: 'failed'; reason: string }
	| {
			kind: 'table'
			title: string
			subtitle: string | null
			rows: string[][]
	  }
	| {
			kind: 'summary'
			title: string
			subtitle: string
			lines: SummaryLine[]
			values: FigureValue[]
			notes: string[]
	  }

function localeDate(dateKey: string, locale: EmailLocale) {
	const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number]
	return new Intl.DateTimeFormat(locale, {
		dateStyle: 'full',
		timeZone: 'UTC',
	}).format(new Date(Date.UTC(y, m - 1, d)))
}

function periodText(result: ReportResult, timeZone: string, locale: EmailLocale) {
	if (!result.period) return null
	const fmt = (iso: string) =>
		new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(
			new Date(iso),
		)
	return result.period.start
		? `${fmt(result.period.start)} – ${fmt(result.period.end)}`
		: null
}

/** What one recipient's email holds: the report, or the daily summary's figures. */
export async function buildForGrants(
	req: ReportRunSpec,
	grants: ReportGrants,
): Promise<Built> {
	const now = new Date(req.now)
	const locale = req.locale as EmailLocale
	if (req.report.kind === 'saved') {
		const run = await runReportInRegion({
			orgId: req.orgId,
			definition: req.report.definition,
			grants,
			timeZone: req.timeZone,
			asOf: now,
		})
		if (!run.ok) {
			return run.kind === 'no_access'
				? { kind: 'no_access' }
				: { kind: 'failed', reason: run.reason }
		}
		return {
			kind: 'table',
			title: req.report.title,
			subtitle: periodText(run.result, req.timeZone, locale),
			rows: reportToRows(req.report.definition, run.result),
		}
	}

	const { shown } = visibleFigures(DAILY_SUMMARY_FIGURES, {
		grants: new Set(grants.subjects),
		modulesOn: new Set(grants.modules),
	})
	const asOf = dailyAsOf(now)
	const values: FigureValue[] = []
	for (const id of shown) {
		const spec = FIGURES[id]
		if (spec.source === 'control-plane') {
			const reviews = req.report.reviews
			if (!reviews) continue
			values.push({
				id,
				format: spec.format,
				entries: [{ currency: null, value: reviews.count }],
				previous: [{ currency: null, value: reviews.previousCount }],
			})
			continue
		}
		const definition = spec.definition(DAILY_SUMMARY_PRESET)
		const [current, previous] = await Promise.all([
			runReportInRegion({
				orgId: req.orgId,
				definition,
				grants,
				timeZone: req.timeZone,
				asOf: asOf.current,
			}),
			runReportInRegion({
				orgId: req.orgId,
				definition,
				grants,
				timeZone: req.timeZone,
				asOf: asOf.previous,
			}),
		])
		if (!current.ok) {
			if (current.kind === 'no_access') continue
			return { kind: 'failed', reason: current.reason }
		}
		values.push(
			figureValue(id, current.result, previous.ok ? previous.result : null),
		)
	}
	if (values.length === 0) return { kind: 'no_access' }
	const yesterday = shiftDateKey(req.runKey, -1)
	return {
		kind: 'summary',
		title: locale === 'ar' ? 'الملخص اليومي' : 'Daily summary',
		subtitle: localeDate(yesterday, locale),
		lines: summaryLines(values, figureLabels(locale), locale),
		values,
		notes: [],
	}
}

/** The CSV of a daily summary: one row per figure and currency. */
function summaryCsvRows(values: readonly FigureValue[], locale: EmailLocale) {
	const labels = figureLabels(locale)
	return [
		['Figure', 'Value', 'Same weekday last week', 'Change'],
		...values.flatMap((value) =>
			(value.entries.length > 0
				? value.entries
				: [{ currency: null, value: 0 }]
			).map((entry) => {
				const before = value.previous.find((p) => p.currency === entry.currency)
				return [
					labels[value.id as FigureId] ?? value.id,
					formatFigureEntry(entry, value.format, locale),
					before ? formatFigureEntry(before, value.format, locale) : '',
					changeText(entry, value.previous, locale) ?? '',
				]
			}),
		),
	]
}

/** The CSV a download link rebuilds: the same rows the email was made from. */
export async function buildCsvRows(
	req: ReportRunSpec,
	grants: ReportGrants,
): Promise<string[][] | { error: 'no_access' | 'failed' }> {
	const built = await buildForGrants(req, grants)
	if (built.kind === 'table') return built.rows
	if (built.kind === 'summary') {
		return summaryCsvRows(built.values, req.locale as EmailLocale)
	}
	return { error: built.kind === 'no_access' ? 'no_access' : 'failed' }
}

function grantsKey(grants: ReportGrants) {
	return JSON.stringify([
		[...grants.subjects].sort(),
		grants.scopeIds && [...grants.scopeIds].sort(),
		grants.locationIds === undefined
			? undefined
			: grants.locationIds && [...grants.locationIds].sort(),
		[...grants.modules].sort(),
	])
}

export class ReportHasPersonalFieldsError extends Error {
	fields: string[]
	constructor(fields: string[]) {
		super('report_has_personal_fields')
		this.fields = fields
	}
}

/**
 * Runs the request for every recipient and emails each one. Throws
 * `ReportHasPersonalFieldsError` (nothing is sent) for a definition that reads a
 * personal field.
 */
export async function sendScheduledReport(
	req: ReportSendRequest,
): Promise<ReportSendResponse> {
	if (req.report.kind === 'saved') {
		const personal = personalFieldsUsed(
			getCatalog('organization'),
			req.report.definition,
		)
		if (personal.length > 0) throw new ReportHasPersonalFieldsError(personal)
	}
	if (!isReportEmailEnabled()) {
		return {
			results: req.recipients.map((r) => ({
				userId: r.userId,
				status: 'dropped' as const,
				reason: 'report_email_disabled',
			})),
		}
	}
	const { recipients: ignoredRecipients, ...runSpec } = req
	const base = consentBaseUrl()
	const locale = req.locale as EmailLocale
	const built = new Map<string, Promise<Built>>()
	const results: ReportSendResponse['results'] = []
	for (const recipient of req.recipients) {
		const key = grantsKey(recipient.grants)
		let promise = built.get(key)
		if (!promise) {
			promise = buildForGrants(runSpec, recipient.grants).catch(
				(): Built => ({ kind: 'failed', reason: 'run_error' }),
			)
			built.set(key, promise)
		}
		const content = await promise
		if (content.kind === 'no_access') {
			results.push({
				userId: recipient.userId,
				status: 'skipped_no_access',
				reason: 'no_access',
			})
			continue
		}
		if (content.kind === 'failed') {
			results.push({
				userId: recipient.userId,
				status: 'failed',
				reason: content.reason,
			})
			continue
		}
		// The CSV link needs this node's trusted public origin; without one the
		// email still goes, with the report in the body and no link.
		let csvUrl: string | null = null
		if (base) {
			const token = signReportCsvToken({
				o: req.orgId,
				exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
				spec: { req: runSpec, grants: recipient.grants },
			})
			if (token) {
				csvUrl = `${base}/reports/csv/${encodeURIComponent(req.orgId)}?t=${encodeURIComponent(token)}`
			}
		}
		const rendered =
			content.kind === 'table'
				? renderTableEmail({
						locale,
						organizationName: req.organizationName,
						title: content.title,
						subtitle: content.subtitle,
						rows: content.rows,
						reportUrl: req.reportUrl,
						csvUrl,
						unsubscribeUrl: recipient.unsubscribeUrl,
					})
				: renderSummaryEmail({
						locale,
						organizationName: req.organizationName,
						title: content.title,
						subtitle: content.subtitle,
						compareLabel:
							locale === 'ar'
								? 'مقارنة بنفس اليوم من الأسبوع الماضي'
								: 'vs same weekday last week',
						lines: content.lines,
						notes: content.notes,
						reportUrl: req.reportUrl,
						csvUrl,
						unsubscribeUrl: recipient.unsubscribeUrl,
					})
		try {
			const sent = await sendTenantEmail({
				to: recipient.email,
				subject: rendered.subject,
				html: rendered.html,
				text: rendered.text,
				orgId: req.orgId,
				capture: { orgId: req.orgId, messageKind: 'report_schedule' },
				extraHeaders: listUnsubscribeHeaders(recipient.unsubscribeUrl),
			})
			results.push(
				sent.status === 'error'
					? { userId: recipient.userId, status: 'failed', reason: 'email_error' }
					: { userId: recipient.userId, status: 'sent' },
			)
		} catch {
			results.push({
				userId: recipient.userId,
				status: 'failed',
				reason: 'email_error',
			})
		}
	}
	return { results }
}
