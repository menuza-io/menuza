import { z } from 'zod'

/**
 * Contracts for `/internal/staff` on tenant-api: the server-to-server surface
 * the App's control plane uses (authenticated with `INTERNAL_COMMAND_TOKEN`,
 * never reachable with an operator token).
 *
 * Residency rule: everything that crosses the plane boundary here is an opaque
 * id or a count. Requests carry organization, staff and user ids only; the
 * summary answers with numbers only. No name, contact detail, pay figure, PIN
 * or time ever appears in an outbox row, a request or a response. Every schema
 * is `.strict()` so a stray field is a 400 rather than silently carried along.
 */

/** Ids in the control plane and regional database: cuid, uuid or slug-like. */
export const opaqueIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, 'Invalid id')

/** The control-plane events that must reach the regional database. */
export const STAFFING_OUTBOX_KINDS = [
	'link_user',
	'unlink_user',
	'erase_user',
] as const
export type StaffingOutboxKind = (typeof STAFFING_OUTBOX_KINDS)[number]

export const linkUserPayloadSchema = z
	.object({ staffMemberId: opaqueIdSchema, userId: opaqueIdSchema })
	.strict()
export const unlinkUserPayloadSchema = z
	.object({ userId: opaqueIdSchema })
	.strict()
export const eraseUserPayloadSchema = z
	.object({ userId: opaqueIdSchema })
	.strict()

export type LinkUserPayload = z.infer<typeof linkUserPayloadSchema>
export type UnlinkUserPayload = z.infer<typeof unlinkUserPayloadSchema>
export type EraseUserPayload = z.infer<typeof eraseUserPayloadSchema>

/** Outbox payload schema per kind (ids only). */
export const STAFFING_OUTBOX_PAYLOAD_SCHEMAS = {
	link_user: linkUserPayloadSchema,
	unlink_user: unlinkUserPayloadSchema,
	erase_user: eraseUserPayloadSchema,
} as const

/** The path segment each outbox kind posts to under `/internal/staff`. */
export const STAFFING_OUTBOX_PATHS: Record<StaffingOutboxKind, string> = {
	link_user: 'link-user',
	unlink_user: 'unlink-user',
	erase_user: 'erase-user',
}

/** Every internal request names the organization (checked against the node). */
const orgField = { orgId: opaqueIdSchema }

export const internalSummaryRequestSchema = z.object(orgField).strict()
export const internalLinkUserRequestSchema = linkUserPayloadSchema
	.extend(orgField)
	.strict()
export const internalUnlinkUserRequestSchema = unlinkUserPayloadSchema
	.extend(orgField)
	.strict()
export const internalEraseUserRequestSchema = eraseUserPayloadSchema
	.extend(orgField)
	.strict()
export const internalExportUserRequestSchema = eraseUserPayloadSchema
	.extend(orgField)
	.strict()

/**
 * Counts that describe what a region switch would destroy. Numbers only: this
 * response is read by the US control plane, so it may never carry a name, an id
 * of a person, or a figure that could identify one.
 */
export const staffSummarySchema = z
	.object({
		staff: z.number().int().nonnegative(),
		byStatus: z
			.object({
				invited: z.number().int().nonnegative(),
				active: z.number().int().nonnegative(),
				on_leave: z.number().int().nonnegative(),
				terminated: z.number().int().nonnegative(),
			})
			.strict(),
		linkedLogins: z.number().int().nonnegative(),
		scopeAssignments: z.number().int().nonnegative(),
		positions: z.number().int().nonnegative(),
		payRecords: z.number().int().nonnegative(),
		notes: z.number().int().nonnegative(),
		/** Applicants in the hiring pipeline (absent from an older node). */
		applicants: z.number().int().nonnegative().optional(),
		/** Time cards (absent from an older node). */
		timeCards: z.number().int().nonnegative().optional(),
		/** Scheduled shifts (absent from an older node). */
		shifts: z.number().int().nonnegative().optional(),
		auditEntries: z.number().int().nonnegative(),
	})
	.strict()
export type StaffSummary = z.infer<typeof staffSummarySchema>

/** Whether a summary holds any record a region switch would destroy. */
export function summaryHasStaffData(summary: StaffSummary): boolean {
	return (
		summary.staff > 0 ||
		summary.positions > 0 ||
		summary.payRecords > 0 ||
		summary.notes > 0 ||
		(summary.applicants ?? 0) > 0 ||
		(summary.timeCards ?? 0) > 0 ||
		(summary.shifts ?? 0) > 0 ||
		summary.auditEntries > 0
	)
}

/** Query for the operator-side export (`GET /operator/staff/export`). */
export const staffExportQuerySchema = z
	.object({ staffId: opaqueIdSchema.optional() })
	.strict()
export type StaffExportQuery = z.infer<typeof staffExportQuerySchema>

/** Format marker written at the top of every export file. */
export const STAFF_EXPORT_FORMAT = 'staff-export/v1'

/**
 * What every export file is guaranteed to carry. The rest of the file (staff,
 * positions, audit log) is passed through untouched: App code only checks the
 * envelope before offering the file to the person who asked for it.
 */
export const staffExportFileSchema = z
	.object({
		format: z.literal(STAFF_EXPORT_FORMAT),
		exportedAt: z.number(),
		orgId: z.string(),
		region: z.string(),
		includes: z.object({ pay: z.boolean(), private: z.boolean() }),
		staff: z.array(z.record(z.string(), z.unknown())),
	})
	.loose()
export type StaffExportFile = z.infer<typeof staffExportFileSchema>
