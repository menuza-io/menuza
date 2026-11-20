import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm'
import { HIRING_OPEN_STAGES, HIRING_STAGES, toCsv } from '@repo/staffing'
import { formExportAudit, hiringApplications } from '@repo/tenant-db'
import { z } from 'zod'
import { type StaffRouteContext } from '../lib/staff-guard.ts'

/** The most rows one export file holds (#142). */
export const APPLICANT_EXPORT_MAX_ROWS = 10_000

export const applicantExportQuerySchema = z.object({
	postingId: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/)
		.optional(),
	stage: z.enum([...HIRING_STAGES, 'open']).optional(),
})

export type ApplicantExportResult =
	| { ok: true; csv: string; rows: number }
	| { ok: false; status: 413; error: 'export_too_large'; message: string }

const HEADERS = [
	'Posting',
	'First name',
	'Last name',
	'Email',
	'Phone',
	'Stage',
	'Source',
	'Screener score',
	'Flagged answers',
	'Applied at',
]

/**
 * Applicants of one posting, or of every posting, as a formula-safe CSV
 * (#142). Limited to the token's scopes like the pipeline itself. The audit
 * row names the posting and a count, never an applicant.
 */
export async function exportApplicantsCsv(
	ctx: StaffRouteContext,
	query: z.infer<typeof applicantExportQuerySchema>,
): Promise<ApplicantExportResult> {
	const { db, scope } = ctx
	const filters: SQL[] = []
	if (!scope.unrestricted) {
		const scoped = scope.whereAnyOf(
			hiringApplications.scopeId,
			hiringApplications.interestedScopeIds,
		)
		if (scoped) filters.push(scoped)
	}
	if (query.postingId) {
		filters.push(eq(hiringApplications.postingId, query.postingId))
	}
	if (query.stage) {
		filters.push(
			query.stage === 'open'
				? inArray(hiringApplications.stage, [...HIRING_OPEN_STAGES])
				: eq(hiringApplications.stage, query.stage),
		)
	}
	const where = filters.length > 0 ? and(...filters) : undefined
	const [total] = await db
		.select({ value: count() })
		.from(hiringApplications)
		.where(where)
	if ((total?.value ?? 0) > APPLICANT_EXPORT_MAX_ROWS) {
		return {
			ok: false,
			status: 413,
			error: 'export_too_large',
			message: `More than ${APPLICANT_EXPORT_MAX_ROWS} applicants match. Export one posting at a time.`,
		}
	}
	const rows = await db
		.select()
		.from(hiringApplications)
		.where(where)
		.orderBy(desc(hiringApplications.createdAt))
		.limit(APPLICANT_EXPORT_MAX_ROWS)
	const csv = toCsv(
		HEADERS,
		rows.map((row) => [
			row.postingTitle,
			row.firstName,
			row.lastName,
			row.email ?? '',
			row.phone ?? '',
			row.stage,
			row.source,
			row.screenerScore,
			Array.isArray(row.screenerFlags) ? row.screenerFlags.length : 0,
			row.createdAt ? new Date(row.createdAt).toISOString() : '',
		]),
		{ bom: true },
	)
	await db.insert(formExportAudit).values({
		kind: 'applicants',
		targetId: query.postingId ?? '',
		operatorId: ctx.auth.userId,
		rowCount: rows.length,
	})
	return { ok: true, csv, rows: rows.length }
}
