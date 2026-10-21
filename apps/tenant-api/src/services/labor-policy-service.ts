import { and, eq, ne, sql } from 'drizzle-orm'
import {
	applyLaborPolicyPatch,
	BUILTIN_LABOR_POLICY,
	getRulePack,
	type LaborPolicyFields,
	type LaborPolicyPatch,
	type LaborPolicyProblem,
	laborPolicyProblems,
	type LaborPolicyView,
} from '@repo/staffing'
import {
	laborPolicies,
	type LaborPolicyRow,
	staffScopeAssignments,
	staffMembers,
	type TenantDatabase,
	runTenantTransaction,
} from '@repo/tenant-db'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { type ScopeAccess, type StaffAuth } from '../lib/staff-auth.ts'
import { type StaffDb, writeStaffAudit } from './staff-audit.ts'

/** Field-level `{ before, after }` for fields that changed (structural equality). */
function changedFields(
	before: LaborPolicyFields,
	after: LaborPolicyFields,
): Record<string, { before: unknown; after: unknown }> {
	const out: Record<string, { before: unknown; after: unknown }> = {}
	for (const key of Object.keys(after) as Array<keyof LaborPolicyFields>) {
		if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
			out[key] = { before: before[key], after: after[key] }
		}
	}
	return out
}

/** Scope key of the organization default row. */
export const DEFAULT_POLICY_SCOPE = '*'

export type PolicyFailure = {
	ok: false
	status: 400 | 403 | 404 | 409 | 422
	error: string
	message?: string
	extra?: Record<string, unknown>
}
export type PolicyResult<T> = { ok: true; value: T } | PolicyFailure

const ok = <T>(value: T): PolicyResult<T> => ({ ok: true, value })
const fail = (
	status: PolicyFailure['status'],
	error: string,
	extra?: Record<string, unknown>,
): PolicyFailure => ({ ok: false, status, error, ...(extra ? { extra } : {}) })

export type PolicyContext = {
	db: TenantDatabase
	auth: StaffAuth
	scope: ScopeAccess
	ipHash: string | null
}

export function policyRowToFields(row: LaborPolicyRow): LaborPolicyFields {
	return {
		timeTrackingEnabled: row.timeTrackingEnabled,
		timeZone: row.timeZone,
		weekStartsOn: row.weekStartsOn,
		workdayStartMinute: row.workdayStartMinute,
		lateGraceMinutes: row.lateGraceMinutes,
		preventEarlyMinutes: row.preventEarlyMinutes,
		allowUnscheduled: row.allowUnscheduled,
		missedClockOutReminderMinutes: row.missedClockOutReminderMinutes,
		autoClockOutMinutes: row.autoClockOutMinutes,
		noClockInAlertMinutes: row.noClockInAlertMinutes,
		preShiftReminderMinutes: row.preShiftReminderMinutes,
		overtimeAlertMinutes: row.overtimeAlertMinutes,
		rounding: {
			mode: row.roundingMode as LaborPolicyFields['rounding']['mode'],
			incrementMinutes: row.roundingIncrementMinutes,
		},
		dailyOvertime:
			row.dailyOvertimeMinutes === null
				? null
				: {
						thresholdMinutes: row.dailyOvertimeMinutes,
						multiplierBp: row.dailyOvertimeBp,
					},
		dailyDoubleTime:
			row.dailyDoubleTimeMinutes === null
				? null
				: {
						thresholdMinutes: row.dailyDoubleTimeMinutes,
						multiplierBp: row.dailyDoubleTimeBp,
					},
		weeklyOvertime:
			row.weeklyOvertimeMinutes === null
				? null
				: {
						thresholdMinutes: row.weeklyOvertimeMinutes,
						multiplierBp: row.weeklyOvertimeBp,
					},
		holiday: {
			dates: row.holidayDates ?? [],
			multiplierBp: row.holidayMultiplierBp,
		},
		breakRules: row.breakRules ?? { rules: [], autoDeduction: null },
		longShiftMinutes: row.longShiftMinutes,
		geofence: {
			mode: row.geofenceMode as LaborPolicyFields['geofence']['mode'],
			radiusMeters: row.geofenceRadiusMeters,
		},
		requirePhoto: row.requirePhoto,
		timesheetApprovalMode:
			row.timesheetApprovalMode as LaborPolicyFields['timesheetApprovalMode'],
		scheduleVisibility:
			row.scheduleVisibility as LaborPolicyFields['scheduleVisibility'],
		publishLeadHours: row.publishLeadHours,
		timeOffMaxPerDay: row.timeOffMaxPerDay,
		laborTargetBp: row.laborTargetBp,
		aggregateOvertimeAcrossScopes: row.aggregateOvertimeAcrossScopes,
		rulePack: row.rulePack,
		rulePackVersion: row.rulePackVersion,
	}
}

/** Columns for a policy row. A threshold that is off keeps its default multiplier. */
export function policyFieldsToColumns(fields: LaborPolicyFields) {
	return {
		timeTrackingEnabled: fields.timeTrackingEnabled,
		timeZone: fields.timeZone,
		weekStartsOn: fields.weekStartsOn,
		workdayStartMinute: fields.workdayStartMinute,
		lateGraceMinutes: fields.lateGraceMinutes,
		preventEarlyMinutes: fields.preventEarlyMinutes,
		allowUnscheduled: fields.allowUnscheduled,
		missedClockOutReminderMinutes: fields.missedClockOutReminderMinutes,
		autoClockOutMinutes: fields.autoClockOutMinutes,
		noClockInAlertMinutes: fields.noClockInAlertMinutes,
		preShiftReminderMinutes: fields.preShiftReminderMinutes,
		overtimeAlertMinutes: fields.overtimeAlertMinutes,
		roundingMode: fields.rounding.mode,
		roundingIncrementMinutes: fields.rounding.incrementMinutes,
		dailyOvertimeMinutes: fields.dailyOvertime?.thresholdMinutes ?? null,
		dailyOvertimeBp: fields.dailyOvertime?.multiplierBp ?? 15000,
		dailyDoubleTimeMinutes: fields.dailyDoubleTime?.thresholdMinutes ?? null,
		dailyDoubleTimeBp: fields.dailyDoubleTime?.multiplierBp ?? 20000,
		weeklyOvertimeMinutes: fields.weeklyOvertime?.thresholdMinutes ?? null,
		weeklyOvertimeBp: fields.weeklyOvertime?.multiplierBp ?? 15000,
		holidayMultiplierBp: fields.holiday.multiplierBp,
		holidayDates: fields.holiday.dates,
		breakRules: fields.breakRules,
		longShiftMinutes: fields.longShiftMinutes,
		geofenceMode: fields.geofence.mode,
		geofenceRadiusMeters: fields.geofence.radiusMeters,
		requirePhoto: fields.requirePhoto,
		timesheetApprovalMode: fields.timesheetApprovalMode,
		scheduleVisibility: fields.scheduleVisibility,
		publishLeadHours: fields.publishLeadHours,
		timeOffMaxPerDay: fields.timeOffMaxPerDay,
		laborTargetBp: fields.laborTargetBp,
		aggregateOvertimeAcrossScopes: fields.aggregateOvertimeAcrossScopes,
		rulePack: fields.rulePack,
		rulePackVersion: fields.rulePackVersion,
	}
}

function toView(
	row: LaborPolicyRow | null,
	source: LaborPolicyView['source'],
	scopeId: string | null,
	aggregateDecisionRequired: boolean,
): LaborPolicyView {
	const fields = row ? policyRowToFields(row) : BUILTIN_LABOR_POLICY
	return {
		...fields,
		id: row?.id ?? null,
		scopeId,
		source,
		version: row?.version ?? 1,
		updatedAt: row?.updatedAt ?? null,
		aggregateDecisionRequired:
			aggregateDecisionRequired &&
			fields.aggregateOvertimeAcrossScopes === null,
	}
}

async function findPolicyRow(
	db: StaffDb,
	scopeKey: string,
): Promise<LaborPolicyRow | null> {
	const [row] = await db
		.select()
		.from(laborPolicies)
		.where(eq(laborPolicies.scopeKey, scopeKey))
		.limit(1)
	return row ?? null
}

/** Whether people work at more than one scope (optionally including `scopeId`). */
export async function hasMultiScopeStaff(
	db: StaffDb,
	scopeId?: string,
): Promise<boolean> {
	const multi = db
		.select({ staffId: staffScopeAssignments.staffId })
		.from(staffScopeAssignments)
		.innerJoin(staffMembers, eq(staffMembers.id, staffScopeAssignments.staffId))
		.where(
			and(
				eq(staffScopeAssignments.active, true),
				ne(staffMembers.status, 'terminated'),
			),
		)
		.groupBy(staffScopeAssignments.staffId)
		.having(sql`count(*) > 1`)
		.as('multi')
	const [row] = scopeId
		? await db
				.select({ staffId: multi.staffId })
				.from(multi)
				.innerJoin(
					staffScopeAssignments,
					and(
						eq(staffScopeAssignments.staffId, multi.staffId),
						eq(staffScopeAssignments.scopeId, scopeId),
						eq(staffScopeAssignments.active, true),
					),
				)
				.limit(1)
		: await db.select({ staffId: multi.staffId }).from(multi).limit(1)
	return Boolean(row)
}

/**
 * The policy a scope follows: its own row, else the organization default,
 * else the built-in neutral values. Pure read; no audit (policies hold no
 * personal data).
 */
export async function resolvePolicy(
	db: StaffDb,
	scopeId: string,
): Promise<LaborPolicyView> {
	const own = await findPolicyRow(db, scopeId)
	const multi = await hasMultiScopeStaff(db, scopeId)
	if (own) return toView(own, 'scope', scopeId, multi)
	const fallback = await findPolicyRow(db, DEFAULT_POLICY_SCOPE)
	if (fallback) return toView(fallback, 'default', scopeId, multi)
	return toView(null, 'builtin', scopeId, multi)
}

export async function getDefaultPolicy(
	db: StaffDb,
): Promise<LaborPolicyView | null> {
	const row = await findPolicyRow(db, DEFAULT_POLICY_SCOPE)
	if (!row) return null
	return toView(row, 'default', null, await hasMultiScopeStaff(db))
}

export async function listPolicies(
	ctx: PolicyContext,
): Promise<{ default: LaborPolicyView | null; scopes: LaborPolicyView[] }> {
	const rows = await ctx.db
		.select()
		.from(laborPolicies)
		.where(ctx.scope.where(laborPolicies.scopeId))
	const multi = await hasMultiScopeStaff(ctx.db)
	const defaultRow = await findPolicyRow(ctx.db, DEFAULT_POLICY_SCOPE)
	return {
		default: defaultRow ? toView(defaultRow, 'default', null, multi) : null,
		scopes: rows
			.filter((row) => row.scopeId !== null)
			.map((row) => toView(row, 'scope', row.scopeId, multi)),
	}
}

export async function getEffectivePolicy(
	ctx: PolicyContext,
	scopeId: string,
): Promise<PolicyResult<LaborPolicyView>> {
	if (!ctx.scope.allows(scopeId)) return fail(404, 'not_found')
	return ok(await resolvePolicy(ctx.db, scopeId))
}

function problemsFailure(problems: LaborPolicyProblem[]): PolicyFailure {
	return fail(422, 'invalid_policy', { problems })
}

/**
 * Creates or updates one policy row (a scope, or the organization default
 * when `scopeId` is null). A patch merges onto the policy being edited, or
 * onto the default (then the built-in values) when a scope row is created.
 * Existing rows need the version the caller last saw. Every change writes an
 * audit row in the same transaction. Policies carry no personal data, so the
 * audit rows are ordinary.
 */
export async function savePolicy(
	ctx: PolicyContext,
	scopeId: string | null,
	patch: LaborPolicyPatch,
): Promise<PolicyResult<LaborPolicyView>> {
	if (scopeId === null) {
		if (!ctx.scope.unrestricted) return fail(403, 'unrestricted_scope_required')
	} else if (!ctx.scope.allows(scopeId)) {
		return fail(404, 'not_found')
	}
	const scopeKey = scopeId ?? DEFAULT_POLICY_SCOPE

	return retryOnSqliteBusy(() =>
		runTenantTransaction(
			ctx.db,
			async (tx): Promise<PolicyResult<LaborPolicyView>> => {
				const existing = await findPolicyRow(tx, scopeKey)
				if (existing && patch.expectedVersion !== existing.version) {
					return fail(409, 'stale_version', {
						currentVersion: existing.version,
					})
				}
				const seed =
					existing ??
					(scopeId === null
						? null
						: await findPolicyRow(tx, DEFAULT_POLICY_SCOPE))
				const base = seed ? policyRowToFields(seed) : BUILTIN_LABOR_POLICY

				let merged: LaborPolicyFields
				try {
					merged = applyLaborPolicyPatch(base, patch)
				} catch {
					return fail(422, 'invalid_policy')
				}
				const problems = laborPolicyProblems(merged)
				if (problems.length > 0) return problemsFailure(problems)
				if (!getRulePack(merged.rulePack)) {
					return problemsFailure([
						{ path: 'rulePack', code: 'unknown_rule_pack' },
					])
				}
				if (
					merged.aggregateOvertimeAcrossScopes === null &&
					(await hasMultiScopeStaff(tx, scopeId ?? undefined))
				) {
					return fail(422, 'aggregate_overtime_required', {
						problems: [
							{
								path: 'aggregateOvertimeAcrossScopes',
								code: 'required_for_multi_scope_staff',
							},
						],
					})
				}

				const columns = policyFieldsToColumns(merged)
				const now = Date.now()
				let version = 1
				if (existing) {
					version = existing.version + 1
					const updated = await tx
						.update(laborPolicies)
						.set({
							...columns,
							version,
							updatedBy: ctx.auth.userId,
							updatedAt: now,
						})
						.where(
							and(
								eq(laborPolicies.id, existing.id),
								eq(laborPolicies.version, existing.version),
							),
						)
						.returning({ id: laborPolicies.id })
					if (updated.length !== 1) {
						return fail(409, 'stale_version', {
							currentVersion: existing.version,
						})
					}
				} else {
					await tx.insert(laborPolicies).values({
						...columns,
						scopeKey,
						scopeId,
						version,
						updatedBy: ctx.auth.userId,
						createdAt: now,
						updatedAt: now,
					})
				}

				const before = existing ? policyRowToFields(existing) : null
				await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
					action: existing ? 'labor_policy.updated' : 'labor_policy.created',
					entityType: 'labor_policy',
					entityId: scopeKey,
					scopeId,
					changes: {
						version,
						fields: changedFields(before ?? base, merged),
					},
				})

				const row = await findPolicyRow(tx, scopeKey)
				return ok(
					toView(
						row,
						scopeId === null ? 'default' : 'scope',
						scopeId,
						await hasMultiScopeStaff(tx, scopeId ?? undefined),
					),
				)
			},
		),
	)
}
