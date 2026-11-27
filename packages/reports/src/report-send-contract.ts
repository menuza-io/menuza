import { z } from 'zod'
import { reportDefinitionSchema } from './dsl.ts'

/**
 * The wire contract of `POST /internal/reports/send` (#121): the App's job
 * (which knows members, grants and schedules) asks the organization's region
 * (which holds the data) to run a report and email it. Shared so the two
 * cannot drift. Only ids, member emails and aggregate numbers cross; the
 * answer is a status per recipient and nothing regional.
 */

const id = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[\w-]+$/)

export const REPORT_FIGURE_MODULES = [
	'staffing_labor',
	'reservations',
	'phone_agent',
	'marketing',
	'loyalty',
] as const

export const reportGrantsSchema = z.object({
	/** The restricted subjects the recipient's reports token would list, resolved now. */
	subjects: z.array(z.string().min(1).max(64)).max(200),
	scopeIds: z.array(id).max(500).nullable(),
	locationIds: z.array(id).max(500).nullable().optional(),
	/** Modules switched on for the organization (a figure of a module that is off is left out). */
	modules: z.array(z.enum(REPORT_FIGURE_MODULES)).max(10).default([]),
})
export type ReportGrants = z.infer<typeof reportGrantsSchema>

export const reportSendRecipientSchema = z.object({
	userId: id,
	email: z.string().email().max(254),
	grants: reportGrantsSchema,
	/** The one-click unsubscribe link (the App signs it). */
	unsubscribeUrl: z.string().url().max(600),
})

export const reportSendRequestSchema = z.object({
	orgId: id,
	scheduleId: id,
	/** Local date of the run: the idempotency key; a retry reuses it. */
	runKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** The instant the run is for. A retry keeps it, so "yesterday" never moves. */
	now: z.string().datetime(),
	/** The schedule's reporting time zone (a fallback for records with no zone of their own). */
	timeZone: z.string().min(1).max(64),
	locale: z.enum(['en', 'ar']).default('en'),
	organizationName: z.string().max(120),
	/** Where "Open this report" leads (the App page). */
	reportUrl: z.string().url().max(600),
	report: z.discriminatedUnion('kind', [
		z.object({
			kind: z.literal('saved'),
			title: z.string().min(1).max(120),
			definition: reportDefinitionSchema,
		}),
		z.object({
			kind: z.literal('daily_summary'),
			/** The control plane's own aggregate: reviews are not regional data. */
			reviews: z
				.object({
					count: z.number().int().min(0).max(1_000_000),
					previousCount: z.number().int().min(0).max(1_000_000),
				})
				.nullable(),
		}),
	]),
	recipients: z.array(reportSendRecipientSchema).min(1).max(20),
})
export type ReportSendRequest = z.infer<typeof reportSendRequestSchema>

/** A request without its recipients: what a CSV download link rebuilds a report from. */
export const reportRunSpecSchema = reportSendRequestSchema.omit({
	recipients: true,
})
export type ReportRunSpec = z.infer<typeof reportRunSpecSchema>

export const REPORT_SEND_STATUSES = [
	'sent',
	'skipped_no_access',
	'failed',
	/** The region's kill switch is off: dropped, not held. */
	'dropped',
] as const
export type ReportSendStatus = (typeof REPORT_SEND_STATUSES)[number]

export const reportSendResponseSchema = z.object({
	results: z.array(
		z.object({
			userId: z.string(),
			status: z.enum(REPORT_SEND_STATUSES),
			/** A machine reason, never a message with data in it. */
			reason: z.string().max(80).optional(),
		}),
	),
})
export type ReportSendResponse = z.infer<typeof reportSendResponseSchema>

/**
 * `POST /resources/report-link-check` (region to App, internal token): the
 * region asks, before it serves a scheduled report's CSV link, whether that
 * link's recipient may still have it. Ids in, the recipient's grants as they
 * are now out; never a figure. A removed member, a deleted or paused schedule,
 * a recipient who unsubscribed or a flag that is off all answer `active: false`,
 * so a forwarded or old email stops working at once and a demotion shrinks
 * what the link can read.
 */
export const REPORT_LINK_CHECK_PATH = '/resources/report-link-check'

export const reportLinkCheckRequestSchema = z
	.object({ orgId: id, scheduleId: id, userId: id })
	.strict()
export type ReportLinkCheckRequest = z.infer<
	typeof reportLinkCheckRequestSchema
>

export const reportLinkCheckResponseSchema = z.discriminatedUnion('active', [
	z.object({ active: z.literal(false) }),
	z.object({ active: z.literal(true), grants: reportGrantsSchema }),
])
export type ReportLinkCheckResponse = z.infer<
	typeof reportLinkCheckResponseSchema
>
