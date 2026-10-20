import {
	and,
	asc,
	count,
	desc,
	eq,
	inArray,
	isNull,
	lt,
	or,
	type SQL,
	sql,
} from 'drizzle-orm'
import {
	addDays,
	checkPin,
	generatePin,
	normalizePinDigits,
	pinLookupMessage,
	type StaffAssignmentInput,
	type StaffCreateInput,
	type StaffJobCreate,
	type StaffListQuery,
	type StaffPositionCreate,
	type StaffPositionUpdate,
	type StaffPrivateUpdate,
	type StaffRateChange,
	type StaffRehireInput,
	type StaffTerminateInput,
	type StaffUpdateInput,
	type StaffAssignmentUpdate,
	type StaffingSettingsUpdate,
	PIN_DEFAULT_LENGTH,
} from '@repo/staffing'
import {
	staffAuditLog,
	staffJobs,
	staffScopeAssignments,
	staffMembers,
	staffNotes,
	staffPositions,
	staffPrivate,
	staffingSettings,
	type StaffJob,
	type StaffScopeAssignment,
	type StaffMember,
	type StaffPosition,
	type TenantDatabase,
	runTenantTransaction,
} from '@repo/tenant-db'
import { getNodeRegion } from '../lib/region.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { hmacHash } from '../lib/secrets.ts'
import {
	hasGrant,
	type ScopeAccess,
	type StaffAuth,
} from '../lib/staff-auth.ts'
import {
	LINK_SYSTEM_ACTOR,
	revokeScheduleLink,
} from './schedule-link-service.ts'
import {
	diffFields,
	readableSensitivities,
	type StaffDb,
	writeStaffAudit,
} from './staff-audit.ts'
import { inJsonList } from '../lib/chunked-in.ts'
import { insertRowsInChunks } from '../lib/chunked-in.ts'

// ---------------------------------------------------------------------------
// Result plumbing
// ---------------------------------------------------------------------------

export type Failure = {
	ok: false
	status: 400 | 403 | 404 | 409 | 422
	error: string
	message?: string
}
export type Result<T> = { ok: true; value: T } | Failure

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = (
	status: Failure['status'],
	error: string,
	message?: string,
): Failure => ({ ok: false, status, error, ...(message ? { message } : {}) })

/** Marks a staff row whose person was erased (see `eraseLinkedUser`). */
export const ERASED_TERMINATION_REASON = 'erased'

export type StaffContext = {
	db: TenantDatabase
	auth: StaffAuth
	scope: ScopeAccess
	ipHash: string | null
}

function isUniqueViolation(error: unknown, hints: string[] = []): boolean {
	const messages: string[] = []
	for (
		let e = error;
		e instanceof Error;
		e = (e as { cause?: unknown }).cause
	) {
		messages.push(e.message)
	}
	// Drizzle wraps driver errors in a message that quotes the whole SQL
	// statement (every column name), so only the root cause is inspected.
	const text = messages.at(-1) ?? ''
	if (!/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(text)) {
		return false
	}
	return hints.length === 0 || hints.some((hint) => text.includes(hint))
}

/** Runs a write transaction, retrying SQLITE_BUSY. */
function write<T>(
	db: TenantDatabase,
	fn: (
		tx: Parameters<Parameters<TenantDatabase['transaction']>[0]>[0],
	) => Promise<T>,
): Promise<T> {
	return retryOnSqliteBusy(() => runTenantTransaction(db, fn))
}

// ---------------------------------------------------------------------------
// Serializers. These are the only way rows leave this module, so a column
// added to a table later never reaches a response by accident.
// ---------------------------------------------------------------------------

/**
 * The wire shape of a person. When a scope limit is given, a primary
 * scope outside it is withheld: a manager who sees only part of someone's
 * assignments must not learn the others from this field.
 */
export function serializeStaff(
	row: StaffMember,
	scope?: Pick<ScopeAccess, 'allows'>,
) {
	return {
		id: row.id,
		status: row.status,
		workerType: row.workerType,
		firstName: row.firstName,
		lastName: row.lastName,
		firstNameAr: row.firstNameAr,
		lastNameAr: row.lastNameAr,
		email: row.email,
		phone: row.phone,
		userId: row.userId,
		employeeNumber: row.employeeNumber,
		locale: row.locale,
		hiredDate: row.hiredDate,
		terminatedAt: row.terminatedAt,
		terminationReason: row.terminationReason,
		eligibleForRehire: row.eligibleForRehire,
		primaryScopeId:
			row.primaryScopeId && scope && !scope.allows(row.primaryScopeId)
				? null
				: row.primaryScopeId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

/** `pin_lookup` and failure counters never leave the node; `hasPin` says enough. */
export function serializeAssignment(row: StaffScopeAssignment) {
	return {
		id: row.id,
		staffId: row.staffId,
		scopeId: row.scopeId,
		isPrimary: row.isPrimary,
		showInSchedule: row.showInSchedule,
		eligibleOpenShifts: row.eligibleOpenShifts,
		includeInClockErrors: row.includeInClockErrors,
		canWaiveBreaks: row.canWaiveBreaks,
		active: row.active,
		hasPin: row.pinLookup !== null,
		pinSetAt: row.pinSetAt,
	}
}

export function serializeJob(row: StaffJob, includePay: boolean) {
	return {
		id: row.id,
		staffId: row.staffId,
		scopeId: row.scopeId,
		positionId: row.positionId,
		isPrimary: row.isPrimary,
		effectiveFrom: row.effectiveFrom,
		effectiveTo: row.effectiveTo,
		...(includePay
			? {
					payType: row.payType,
					rateMinor: row.rateMinor,
					annualSalaryMinor: row.annualSalaryMinor,
					currency: row.currency,
					overtimeExempt: row.overtimeExempt,
					tipEligible: row.tipEligible,
					changeReason: row.changeReason,
					createdAt: row.createdAt,
				}
			: {}),
	}
}

export function serializePosition(row: StaffPosition, includePay: boolean) {
	return {
		id: row.id,
		name: row.name,
		nameAr: row.nameAr,
		area: row.area,
		colorKey: row.colorKey,
		tipEligible: row.tipEligible,
		archivedAt: row.archivedAt,
		createdAt: row.createdAt,
		...(includePay
			? { defaultRateMinor: row.defaultRateMinor, currency: row.currency }
			: {}),
	}
}

function canSeePay(auth: StaffAuth) {
	return hasGrant(auth, 'read:staff_pay:any')
}
function canSeePrivate(auth: StaffAuth) {
	return hasGrant(auth, 'read:staff_private:any')
}

function restricted(auth: StaffAuth) {
	return { pay: !canSeePay(auth), private: !canSeePrivate(auth) }
}

// ---------------------------------------------------------------------------
// Loading and visibility
// ---------------------------------------------------------------------------

async function assignmentsFor(db: StaffDb, staffId: string) {
	return db
		.select()
		.from(staffScopeAssignments)
		.where(eq(staffScopeAssignments.staffId, staffId))
		.orderBy(asc(staffScopeAssignments.createdAt))
}

type Access = {
	staff: StaffMember
	/** Every assignment row, regardless of scope. Internal use only. */
	allAssignments: StaffScopeAssignment[]
	/** True when the scope covers every scope the person is assigned to. */
	coversAll: boolean
}

/**
 * Loads a staff member the token is allowed to see. Outside the scope limit
 * (or unknown) is the same 404, so a scoped manager cannot probe other
 * scopes' rosters. Unrestricted tokens see everyone, including people with
 * no assignment yet.
 */
async function loadVisible(
	db: StaffDb,
	scope: ScopeAccess,
	staffId: string,
): Promise<Result<Access>> {
	const [staff] = await db
		.select()
		.from(staffMembers)
		.where(eq(staffMembers.id, staffId))
		.limit(1)
	if (!staff) return fail(404, 'Staff member not found')
	const allAssignments = await assignmentsFor(db, staffId)
	const scopeIds = allAssignments.map((a) => a.scopeId)
	if (!scope.unrestricted && !scope.allowsAny(scopeIds)) {
		return fail(404, 'Staff member not found')
	}
	return ok({ staff, allAssignments, coversAll: scope.allowsAll(scopeIds) })
}

async function jobsFor(db: StaffDb, staffId: string) {
	return db
		.select()
		.from(staffJobs)
		.where(eq(staffJobs.staffId, staffId))
		.orderBy(desc(staffJobs.effectiveFrom), desc(staffJobs.createdAt))
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(db: StaffDb) {
	await db
		.insert(staffingSettings)
		.values({
			id: 'org',
			// KSA defaults to the minimal staff-facing content level.
			contactLevel: getNodeRegion() === 'ksa' ? 'minimal' : 'full',
		})
		.onConflictDoNothing()
	const [row] = await db
		.select()
		.from(staffingSettings)
		.where(eq(staffingSettings.id, 'org'))
		.limit(1)
	return row!
}

export function serializeSettings(row: typeof staffingSettings.$inferSelect) {
	return {
		pinLength: row.pinLength,
		payPeriod: row.payPeriod,
		contactLevel: row.contactLevel,
		retentionDaysPunchCoordinates: row.retentionDaysPunchCoordinates,
		retentionDaysDeclinedApplicants: row.retentionDaysDeclinedApplicants,
		updatedAt: row.updatedAt,
	}
}

export async function updateSettings(
	ctx: StaffContext,
	patch: StaffingSettingsUpdate,
): Promise<Result<{ settings: ReturnType<typeof serializeSettings> }>> {
	if (!ctx.scope.unrestricted) {
		return fail(403, 'unrestricted_scope_required')
	}
	const updated = await write(ctx.db, async (tx) => {
		const before = await getSettings(tx)
		const changes = diffFields(before, patch)
		if (Object.keys(changes).length === 0) return before
		await tx
			.update(staffingSettings)
			.set({ ...patch, updatedBy: ctx.auth.userId, updatedAt: Date.now() })
			.where(eq(staffingSettings.id, 'org'))
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'staff.settings.updated',
			entityType: 'settings',
			entityId: 'org',
			changes,
		})
		return getSettings(tx)
	})
	return ok({ settings: serializeSettings(updated) })
}

// ---------------------------------------------------------------------------
// Listing and detail
// ---------------------------------------------------------------------------

function likePattern(q: string) {
	return `%${q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`
}

/**
 * Each person's current rate for the roster's pay column: the primary job in
 * effect today (UTC date), else the first one. A job without its own rate uses
 * the position default. The read is audited once for the page, before any
 * value is returned.
 */
async function currentRates(ctx: StaffContext, staffIds: string[]) {
	const today = utcToday(Date.now())
	const jobs = await ctx.db
		.select({
			staffId: staffJobs.staffId,
			scopeId: staffJobs.scopeId,
			isPrimary: staffJobs.isPrimary,
			payType: staffJobs.payType,
			rateMinor: staffJobs.rateMinor,
			annualSalaryMinor: staffJobs.annualSalaryMinor,
			currency: staffJobs.currency,
			defaultRateMinor: staffPositions.defaultRateMinor,
		})
		.from(staffJobs)
		.innerJoin(staffPositions, eq(staffPositions.id, staffJobs.positionId))
		.where(
			and(
				inJsonList(staffJobs.staffId, staffIds),
				sql`${staffJobs.effectiveFrom} <= ${today}`,
				or(
					isNull(staffJobs.effectiveTo),
					sql`${staffJobs.effectiveTo} >= ${today}`,
				),
			),
		)
		.orderBy(desc(staffJobs.isPrimary), asc(staffJobs.effectiveFrom))
	const visible = ctx.scope.filter(jobs)
	const byStaff = new Map<
		string,
		{
			payType: string
			rateMinor: number | null
			annualSalaryMinor: number | null
			currency: string
		}
	>()
	for (const job of visible) {
		if (byStaff.has(job.staffId)) continue
		byStaff.set(job.staffId, {
			payType: job.payType,
			rateMinor: job.rateMinor ?? job.defaultRateMinor,
			annualSalaryMinor: job.annualSalaryMinor,
			currency: job.currency,
		})
	}
	await writeStaffAudit(ctx.db, ctx.auth, ctx.ipHash, {
		action: 'staff.pay.read',
		entityType: 'staff',
		sensitivity: 'pay',
		changes: { staff: staffIds.length, via: 'list' },
	})
	return byStaff
}

export async function listStaff(ctx: StaffContext, query: StaffListQuery) {
	const { db, scope } = ctx
	const conditions: SQL[] = []

	if (query.status) conditions.push(eq(staffMembers.status, query.status))
	else conditions.push(sql`${staffMembers.status} <> 'terminated'`)

	if (query.q) {
		const pattern = likePattern(query.q)
		const matches = [
			sql`lower(${staffMembers.firstName} || ' ' || ${staffMembers.lastName}) like ${pattern} escape '\\'`,
			sql`(coalesce(${staffMembers.firstNameAr}, '') || ' ' || coalesce(${staffMembers.lastNameAr}, '')) like ${pattern} escape '\\'`,
			sql`lower(coalesce(${staffMembers.email}, '')) like ${pattern} escape '\\'`,
			sql`coalesce(${staffMembers.phone}, '') like ${pattern} escape '\\'`,
			sql`lower(coalesce(${staffMembers.employeeNumber}, '')) like ${pattern} escape '\\'`,
		]
		conditions.push(or(...matches)!)
	}

	if (query.scopeId) {
		if (!scope.allows(query.scopeId)) {
			return { staff: [], total: 0, limit: query.limit, offset: query.offset }
		}
		conditions.push(
			sql`exists (select 1 from ${staffScopeAssignments} where ${staffScopeAssignments.staffId} = ${staffMembers.id} and ${staffScopeAssignments.scopeId} = ${query.scopeId} and ${staffScopeAssignments.active} = 1)`,
		)
	}

	if (query.positionId) {
		const inScope = scope.where(staffJobs.scopeId)
		conditions.push(
			sql`exists (select 1 from ${staffJobs} where ${staffJobs.staffId} = ${staffMembers.id} and ${staffJobs.positionId} = ${query.positionId} and ${staffJobs.effectiveTo} is null${inScope ? sql` and ${inScope}` : sql``})`,
		)
	}

	if (!scope.unrestricted) {
		const inScope = scope.where(staffScopeAssignments.scopeId)!
		conditions.push(
			sql`exists (select 1 from ${staffScopeAssignments} where ${staffScopeAssignments.staffId} = ${staffMembers.id} and ${inScope})`,
		)
	}

	const where = conditions.length ? and(...conditions) : undefined
	const [totalRow] = await db
		.select({ value: count() })
		.from(staffMembers)
		.where(where)
	const rows = await db
		.select()
		.from(staffMembers)
		.where(where)
		.orderBy(
			asc(staffMembers.lastName),
			asc(staffMembers.firstName),
			asc(staffMembers.id),
		)
		.limit(query.limit)
		.offset(query.offset)

	const ids = rows.map((row) => row.id)
	const assignments = ids.length
		? await db
				.select()
				.from(staffScopeAssignments)
				.where(inJsonList(staffScopeAssignments.staffId, ids))
		: []
	const openJobs = ids.length
		? await db
				.select({
					staffId: staffJobs.staffId,
					scopeId: staffJobs.scopeId,
					positionId: staffJobs.positionId,
				})
				.from(staffJobs)
				.where(
					and(
						inJsonList(staffJobs.staffId, ids),
						isNull(staffJobs.effectiveTo),
					),
				)
		: []

	const rates =
		query.include === 'pay' && canSeePay(ctx.auth) && ids.length > 0
			? await currentRates(ctx, ids)
			: null

	return {
		staff: rows.map((row) => ({
			...serializeStaff(row, scope),
			assignments: scope
				.filter(assignments.filter((a) => a.staffId === row.id))
				.map(serializeAssignment),
			positionIds: [
				...new Set(
					scope
						.filter(openJobs.filter((job) => job.staffId === row.id))
						.map((job) => job.positionId),
				),
			],
			...(rates ? { currentRate: rates.get(row.id) ?? null } : {}),
		})),
		total: totalRow?.value ?? rows.length,
		limit: query.limit,
		offset: query.offset,
	}
}

export async function getStaffDetail(
	ctx: StaffContext,
	staffId: string,
	include: { pay: boolean; private: boolean },
): Promise<Result<Record<string, unknown>>> {
	const { db, auth, scope } = ctx
	const access = await loadVisible(db, scope, staffId)
	if (!access.ok) return access
	const { staff, allAssignments } = access.value
	const jobs = scope.filter(await jobsFor(db, staffId))

	const wantPay = include.pay && canSeePay(auth)
	const wantPrivate = include.private && canSeePrivate(auth)

	let privateData: Record<string, unknown> | null | undefined
	if (wantPrivate) {
		const [row] = await db
			.select()
			.from(staffPrivate)
			.where(eq(staffPrivate.staffId, staffId))
			.limit(1)
		privateData = row ? serializePrivate(row) : emptyPrivate()
	}

	// Reads of pay and private data are audited before anything is returned; if
	// the audit write fails the request fails and nothing is disclosed.
	if (wantPay) {
		await writeStaffAudit(db, auth, ctx.ipHash, {
			action: 'staff.pay.read',
			entityType: 'staff',
			entityId: staffId,
			staffId,
			sensitivity: 'pay',
			changes: { jobs: jobs.length },
		})
	}
	if (wantPrivate) {
		await writeStaffAudit(db, auth, ctx.ipHash, {
			action: 'staff.private.read',
			entityType: 'staff',
			entityId: staffId,
			staffId,
			sensitivity: 'private',
		})
	}

	return ok({
		staff: serializeStaff(staff, scope),
		assignments: scope.filter(allAssignments).map(serializeAssignment),
		jobs: jobs.map((job) => serializeJob(job, wantPay)),
		...(privateData !== undefined ? { private: privateData } : {}),
		restricted: restricted(auth),
	})
}

// ---------------------------------------------------------------------------
// Create, import, update
// ---------------------------------------------------------------------------

function validateNewAssignments(
	scope: ScopeAccess,
	assignments: StaffAssignmentInput[],
): Failure | null {
	if (!scope.unrestricted && assignments.length === 0) {
		return fail(
			403,
			'scope_out_of_scope',
			'A scope-limited token must assign the new person to a workplace',
		)
	}
	const ids = assignments.map((a) => a.scopeId)
	if (new Set(ids).size !== ids.length) {
		return fail(422, 'duplicate_assignment', 'Each workplace can appear once')
	}
	if (assignments.filter((a) => a.isPrimary).length > 1) {
		return fail(
			422,
			'multiple_primary',
			'Only one primary workplace is allowed',
		)
	}
	if (!scope.allowsAll(ids)) return fail(403, 'scope_out_of_scope')
	return null
}

type CreateOptions = { userId?: string; source: 'manual' | 'import' | 'bulk' }

export type CreateOutcome = {
	created: boolean
	staff: ReturnType<typeof serializeStaff>
	assignments: ReturnType<typeof serializeAssignment>[]
}

async function existingByUserId(
	db: StaffDb,
	scope: ScopeAccess,
	userId: string,
): Promise<CreateOutcome | null> {
	const [existing] = await db
		.select()
		.from(staffMembers)
		.where(eq(staffMembers.userId, userId))
		.limit(1)
	if (!existing) return null
	const assignments = await assignmentsFor(db, existing.id)
	return {
		created: false,
		staff: serializeStaff(existing, scope),
		assignments: scope.filter(assignments).map(serializeAssignment),
	}
}

export async function createStaff(
	ctx: StaffContext,
	input: StaffCreateInput,
	options: CreateOptions,
): Promise<Result<CreateOutcome>> {
	const { db, auth, scope } = ctx
	if (options.userId) {
		const existing = await existingByUserId(db, scope, options.userId)
		if (existing) return ok(existing)
	}
	const invalid = validateNewAssignments(scope, input.assignments)
	if (invalid) return invalid

	const primaryScopeId =
		input.assignments.find((a) => a.isPrimary)?.scopeId ??
		input.assignments[0]?.scopeId ??
		null

	try {
		const outcome = await write(db, async (tx) => {
			const [staff] = await tx
				.insert(staffMembers)
				.values({
					workerType: input.workerType,
					firstName: input.firstName,
					lastName: input.lastName,
					firstNameAr: input.firstNameAr || null,
					lastNameAr: input.lastNameAr || null,
					email: input.email ?? null,
					phone: input.phone ?? null,
					userId: options.userId ?? null,
					employeeNumber: input.employeeNumber || null,
					locale: input.locale,
					hiredDate: input.hiredDate ?? null,
					primaryScopeId,
					createdBy: auth.userId,
				})
				.returning()
			const assignments = input.assignments.length
				? await insertRowsInChunks(
						staffScopeAssignments,
						input.assignments.map((a) => ({
							staffId: staff!.id,
							scopeId: a.scopeId,
							isPrimary: a.scopeId === primaryScopeId,
							showInSchedule: a.showInSchedule,
							eligibleOpenShifts: a.eligibleOpenShifts,
							includeInClockErrors: a.includeInClockErrors,
							canWaiveBreaks: a.canWaiveBreaks,
						})),
						(part) => tx.insert(staffScopeAssignments).values(part).returning(),
					)
				: []
			await writeStaffAudit(tx, auth, ctx.ipHash, {
				action: 'staff.created',
				entityType: 'staff',
				entityId: staff!.id,
				staffId: staff!.id,
				scopeId: primaryScopeId,
				changes: {
					source: options.source,
					linkedToLogin: options.userId !== undefined,
					scopes: input.assignments.map((a) => a.scopeId),
				},
			})
			return {
				created: true,
				staff: serializeStaff(staff!, scope),
				assignments: assignments.map(serializeAssignment),
			}
		})
		return ok(outcome)
	} catch (error) {
		if (options.userId && isUniqueViolation(error, ['user_id'])) {
			// A concurrent import of the same member won the race: return its row.
			const existing = await existingByUserId(db, scope, options.userId)
			if (existing) return ok(existing)
		}
		if (isUniqueViolation(error, ['employee_number'])) {
			return fail(409, 'employee_number_taken')
		}
		throw error
	}
}

export async function updateStaff(
	ctx: StaffContext,
	staffId: string,
	patch: StaffUpdateInput,
): Promise<Result<{ staff: ReturnType<typeof serializeStaff> }>> {
	const { db, auth, scope } = ctx
	try {
		return await write(db, async (tx) => {
			const access = await loadVisible(tx, scope, staffId)
			if (!access.ok) return access
			const { staff, allAssignments, coversAll } = access.value

			// Name, contact, status and payroll id belong to the person, not to one
			// scope. A scoped manager may only re-point the primary scope of
			// someone who also works elsewhere, the same rule as terminate.
			const touchesPerson = Object.keys(patch).some(
				(key) => key !== 'primaryScopeId',
			)
			if (touchesPerson && !coversAll) {
				return fail(403, 'scope_out_of_scope')
			}

			if (patch.status && staff.status === 'terminated') {
				return fail(
					409,
					'staff_terminated',
					'Use rehire to bring a terminated person back',
				)
			}

			const { primaryScopeId, ...fields } = patch
			const next: Partial<StaffMember> = {}
			for (const [key, value] of Object.entries(fields)) {
				if (value === undefined) continue
				;(next as Record<string, unknown>)[key] =
					typeof value === 'string' && value === '' ? null : value
			}
			// API `hiredDate`, `firstNameAr` and so on map one-to-one to columns.
			const changes = diffFields(
				staff as unknown as Record<string, unknown>,
				next as Record<string, unknown>,
			)

			if (primaryScopeId !== undefined) {
				if (primaryScopeId === null && !coversAll) {
					// Clearing the primary would also unset one held at a scope
					// outside the token.
					return fail(403, 'scope_out_of_scope')
				}
				if (primaryScopeId !== null) {
					// Scope first: answering "not assigned" for a scope outside the
					// token would reveal whether the person works there.
					if (!scope.allows(primaryScopeId)) {
						return fail(403, 'scope_out_of_scope')
					}
					const target = allAssignments.find(
						(a) => a.scopeId === primaryScopeId && a.active,
					)
					if (!target) {
						return fail(
							422,
							'not_assigned_to_scope',
							'Assign the person to the workplace first',
						)
					}
				}
				if (staff.primaryScopeId !== primaryScopeId) {
					changes.primaryScopeId = {
						before: staff.primaryScopeId,
						after: primaryScopeId,
					}
					next.primaryScopeId = primaryScopeId
					await setPrimaryAssignment(tx, staffId, primaryScopeId)
				}
			}

			if (Object.keys(changes).length === 0) {
				return ok({ staff: serializeStaff(staff, scope) })
			}
			const [updated] = await tx
				.update(staffMembers)
				.set({ ...next, updatedAt: Date.now() })
				.where(eq(staffMembers.id, staffId))
				.returning()
			await writeStaffAudit(tx, auth, ctx.ipHash, {
				action: 'staff.updated',
				entityType: 'staff',
				entityId: staffId,
				staffId,
				changes,
			})
			return ok({ staff: serializeStaff(updated!, scope) })
		})
	} catch (error) {
		if (isUniqueViolation(error, ['employee_number'])) {
			return fail(409, 'employee_number_taken')
		}
		throw error
	}
}

/** Makes `scopeId` the one primary assignment (or clears it for `null`). */
async function setPrimaryAssignment(
	tx: StaffDb,
	staffId: string,
	scopeId: string | null,
) {
	await tx
		.update(staffScopeAssignments)
		.set({ isPrimary: false, updatedAt: Date.now() })
		.where(
			and(
				eq(staffScopeAssignments.staffId, staffId),
				eq(staffScopeAssignments.isPrimary, true),
			),
		)
	if (scopeId) {
		await tx
			.update(staffScopeAssignments)
			.set({ isPrimary: true, updatedAt: Date.now() })
			.where(
				and(
					eq(staffScopeAssignments.staffId, staffId),
					eq(staffScopeAssignments.scopeId, scopeId),
				),
			)
	}
	await tx
		.update(staffMembers)
		.set({ primaryScopeId: scopeId, updatedAt: Date.now() })
		.where(eq(staffMembers.id, staffId))
}

// ---------------------------------------------------------------------------
// Private fields
// ---------------------------------------------------------------------------

const PRIVATE_FIELDS = [
	'dateOfBirth',
	'addressLine1',
	'addressLine2',
	'city',
	'region',
	'postalCode',
	'country',
	'emergencyContactName',
	'emergencyContactPhone',
	'emergencyContactRelation',
] as const

function emptyPrivate() {
	return Object.fromEntries(PRIVATE_FIELDS.map((field) => [field, null]))
}

function serializePrivate(row: typeof staffPrivate.$inferSelect) {
	return {
		...Object.fromEntries(PRIVATE_FIELDS.map((field) => [field, row[field]])),
		updatedAt: row.updatedAt,
	}
}

export async function updatePrivate(
	ctx: StaffContext,
	staffId: string,
	patch: StaffPrivateUpdate,
): Promise<Result<{ private: Record<string, unknown> }>> {
	const { db, auth, scope } = ctx
	return write(db, async (tx) => {
		const access = await loadVisible(tx, scope, staffId)
		if (!access.ok) return access
		// Date of birth, address and emergency contact belong to the person, not
		// to one scope, so (like name, contact and termination) a scoped
		// manager may edit them only when every scope the person works at is
		// theirs. Reading them stays available wherever the person is visible.
		if (!access.value.coversAll) return fail(403, 'scope_out_of_scope')
		const [before] = await tx
			.select()
			.from(staffPrivate)
			.where(eq(staffPrivate.staffId, staffId))
			.limit(1)
		const beforeValues = (before ?? emptyPrivate()) as Record<string, unknown>
		const changes = diffFields(beforeValues, patch)
		if (Object.keys(changes).length > 0) {
			await tx
				.insert(staffPrivate)
				.values({ staffId, ...patch, updatedBy: auth.userId })
				.onConflictDoUpdate({
					target: staffPrivate.staffId,
					set: { ...patch, updatedBy: auth.userId, updatedAt: Date.now() },
				})
			await writeStaffAudit(tx, auth, ctx.ipHash, {
				action: 'staff.private.updated',
				entityType: 'staff',
				entityId: staffId,
				staffId,
				sensitivity: 'private',
				changes,
			})
		}
		const [after] = await tx
			.select()
			.from(staffPrivate)
			.where(eq(staffPrivate.staffId, staffId))
			.limit(1)
		return ok({ private: after ? serializePrivate(after) : emptyPrivate() })
	})
}

// ---------------------------------------------------------------------------
// Positions (org-wide, so writes need an unrestricted token)
// ---------------------------------------------------------------------------

export async function listPositions(
	ctx: StaffContext,
	options: { includeArchived: boolean },
) {
	const rows = await ctx.db
		.select()
		.from(staffPositions)
		.where(
			options.includeArchived ? undefined : isNull(staffPositions.archivedAt),
		)
		.orderBy(asc(staffPositions.name))
	const includePay = canSeePay(ctx.auth)
	if (includePay && rows.length > 0) {
		await writeStaffAudit(ctx.db, ctx.auth, ctx.ipHash, {
			action: 'staff.pay.read',
			entityType: 'position',
			sensitivity: 'pay',
			changes: { positions: rows.length },
		})
	}
	return {
		positions: rows.map((row) => serializePosition(row, includePay)),
		restricted: restricted(ctx.auth),
	}
}

export async function createPosition(
	ctx: StaffContext,
	input: StaffPositionCreate,
): Promise<Result<{ position: ReturnType<typeof serializePosition> }>> {
	const { db, auth, scope } = ctx
	if (!scope.unrestricted) return fail(403, 'unrestricted_scope_required')
	if (
		input.defaultRateMinor !== undefined &&
		!hasGrant(auth, 'update:staff_pay:any')
	) {
		return fail(403, 'Forbidden', 'update:staff_pay:any')
	}
	try {
		const row = await write(db, async (tx) => {
			const [position] = await tx
				.insert(staffPositions)
				.values({
					name: input.name,
					nameAr: input.nameAr || null,
					area: input.area || null,
					colorKey: input.colorKey,
					defaultRateMinor: input.defaultRateMinor ?? null,
					currency: input.currency ?? null,
					tipEligible: input.tipEligible,
					createdBy: auth.userId,
				})
				.returning()
			await writeStaffAudit(tx, auth, ctx.ipHash, {
				action: 'staff.position.created',
				entityType: 'position',
				entityId: position!.id,
				changes: { name: input.name },
			})
			if (input.defaultRateMinor !== undefined) {
				await writeStaffAudit(tx, auth, ctx.ipHash, {
					action: 'staff.position.rate_set',
					entityType: 'position',
					entityId: position!.id,
					sensitivity: 'pay',
					changes: {
						defaultRateMinor: { before: null, after: input.defaultRateMinor },
						currency: input.currency ?? null,
					},
				})
			}
			return position!
		})
		return ok({ position: serializePosition(row, canSeePay(auth)) })
	} catch (error) {
		if (
			isUniqueViolation(error, ['uniq_staff_positions_active_name', 'name'])
		) {
			return fail(409, 'position_name_taken')
		}
		throw error
	}
}

export async function updatePosition(
	ctx: StaffContext,
	positionId: string,
	patch: StaffPositionUpdate,
): Promise<Result<{ position: ReturnType<typeof serializePosition> }>> {
	const { db, auth, scope } = ctx
	if (!scope.unrestricted) return fail(403, 'unrestricted_scope_required')
	const touchesPay =
		patch.defaultRateMinor !== undefined || patch.currency !== undefined
	if (touchesPay && !hasGrant(auth, 'update:staff_pay:any')) {
		return fail(403, 'Forbidden', 'update:staff_pay:any')
	}
	try {
		return await write(db, async (tx) => {
			const [position] = await tx
				.select()
				.from(staffPositions)
				.where(eq(staffPositions.id, positionId))
				.limit(1)
			if (!position) return fail(404, 'Position not found')

			const { archived, ...fields } = patch
			const next: Record<string, unknown> = { ...fields }
			if (archived === true && position.archivedAt === null) {
				const [open] = await tx
					.select({ value: count() })
					.from(staffJobs)
					.where(
						and(
							eq(staffJobs.positionId, positionId),
							isNull(staffJobs.effectiveTo),
						),
					)
				if ((open?.value ?? 0) > 0) {
					return fail(
						409,
						'position_in_use',
						'Reassign people with this position before archiving it',
					)
				}
				next.archivedAt = Date.now()
			}
			if (archived === false) next.archivedAt = null

			const nextRate =
				'defaultRateMinor' in next
					? (next.defaultRateMinor as number | null)
					: position.defaultRateMinor
			const nextCurrency =
				'currency' in next
					? (next.currency as string | null)
					: position.currency
			if (nextRate !== null && nextCurrency === null) {
				return fail(422, 'currency_required', 'A default rate needs a currency')
			}

			const allChanges = diffFields(
				position as unknown as Record<string, unknown>,
				next,
			)
			if (Object.keys(allChanges).length === 0) {
				return ok({ position: serializePosition(position, canSeePay(auth)) })
			}
			const payChanges: Record<string, unknown> = {}
			const standardChanges: Record<string, unknown> = {}
			for (const [key, value] of Object.entries(allChanges)) {
				if (key === 'defaultRateMinor' || key === 'currency') {
					payChanges[key] = value
				} else standardChanges[key] = value
			}
			const [updated] = await tx
				.update(staffPositions)
				.set({ ...next, updatedAt: Date.now() })
				.where(eq(staffPositions.id, positionId))
				.returning()
			if (Object.keys(standardChanges).length > 0) {
				await writeStaffAudit(tx, auth, ctx.ipHash, {
					action: 'staff.position.updated',
					entityType: 'position',
					entityId: positionId,
					changes: standardChanges,
				})
			}
			if (Object.keys(payChanges).length > 0) {
				await writeStaffAudit(tx, auth, ctx.ipHash, {
					action: 'staff.position.rate_set',
					entityType: 'position',
					entityId: positionId,
					sensitivity: 'pay',
					changes: payChanges,
				})
			}
			return ok({ position: serializePosition(updated!, canSeePay(auth)) })
		})
	} catch (error) {
		if (
			isUniqueViolation(error, ['uniq_staff_positions_active_name', 'name'])
		) {
			return fail(409, 'position_name_taken')
		}
		throw error
	}
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export function utcToday(now: number) {
	return new Date(now).toISOString().slice(0, 10)
}

/** Closes open jobs at a scope; never earlier than a row's own start. */
export async function closeOpenJobs(
	tx: StaffDb,
	staffId: string,
	effectiveDate: string,
	scopeId?: string,
) {
	const open = await tx
		.select()
		.from(staffJobs)
		.where(
			and(
				eq(staffJobs.staffId, staffId),
				isNull(staffJobs.effectiveTo),
				scopeId ? eq(staffJobs.scopeId, scopeId) : undefined,
			),
		)
	let closed = 0
	for (const job of open) {
		if (job.effectiveFrom > effectiveDate) continue
		await tx
			.update(staffJobs)
			.set({ effectiveTo: effectiveDate })
			.where(and(eq(staffJobs.id, job.id), isNull(staffJobs.effectiveTo)))
		closed += 1
	}
	return closed
}

export async function listAssignments(ctx: StaffContext, staffId: string) {
	const access = await loadVisible(ctx.db, ctx.scope, staffId)
	if (!access.ok) return access
	return ok({
		assignments: ctx.scope
			.filter(access.value.allAssignments)
			.map(serializeAssignment),
	})
}

export async function addAssignment(
	ctx: StaffContext,
	staffId: string,
	input: StaffAssignmentInput,
): Promise<Result<{ assignment: ReturnType<typeof serializeAssignment> }>> {
	const { db, auth, scope } = ctx
	if (!scope.allows(input.scopeId)) return fail(403, 'scope_out_of_scope')
	return write(db, async (tx) => {
		const access = await loadVisible(tx, scope, staffId)
		if (!access.ok) return access
		const { staff, allAssignments } = access.value
		if (staff.status === 'terminated') {
			return fail(409, 'staff_terminated', 'Rehire this person first')
		}
		const existing = allAssignments.find((a) => a.scopeId === input.scopeId)
		if (existing?.active) return fail(409, 'already_assigned')

		const hasActivePrimary = allAssignments.some((a) => a.active && a.isPrimary)
		const makePrimary = input.isPrimary || !hasActivePrimary
		const values = {
			showInSchedule: input.showInSchedule,
			eligibleOpenShifts: input.eligibleOpenShifts,
			includeInClockErrors: input.includeInClockErrors,
			canWaiveBreaks: input.canWaiveBreaks,
		}
		let row: StaffScopeAssignment
		if (existing) {
			;[row] = (await tx
				.update(staffScopeAssignments)
				.set({
					...values,
					active: true,
					isPrimary: false,
					updatedAt: Date.now(),
				})
				.where(eq(staffScopeAssignments.id, existing.id))
				.returning()) as [StaffScopeAssignment]
		} else {
			;[row] = (await tx
				.insert(staffScopeAssignments)
				.values({ staffId, scopeId: input.scopeId, ...values })
				.returning()) as [StaffScopeAssignment]
		}
		if (makePrimary) await setPrimaryAssignment(tx, staffId, input.scopeId)
		await writeStaffAudit(tx, auth, ctx.ipHash, {
			action: existing
				? 'staff.assignment.reactivated'
				: 'staff.assignment.added',
			entityType: 'assignment',
			entityId: row.id,
			staffId,
			scopeId: input.scopeId,
			changes: { primary: makePrimary },
		})
		const [fresh] = await tx
			.select()
			.from(staffScopeAssignments)
			.where(eq(staffScopeAssignments.id, row.id))
		return ok({ assignment: serializeAssignment(fresh!) })
	})
}

async function loadAssignment(
	tx: StaffDb,
	ctx: StaffContext,
	staffId: string,
	assignmentId: string,
): Promise<Result<{ staff: StaffMember; assignment: StaffScopeAssignment }>> {
	const access = await loadVisible(tx, ctx.scope, staffId)
	if (!access.ok) return access
	const assignment = access.value.allAssignments.find(
		(a) => a.id === assignmentId,
	)
	if (!assignment || !ctx.scope.allows(assignment.scopeId)) {
		return fail(404, 'Assignment not found')
	}
	return ok({ staff: access.value.staff, assignment })
}

async function deactivate(
	tx: StaffDb,
	ctx: StaffContext,
	staff: StaffMember,
	assignment: StaffScopeAssignment,
	effectiveDate: string,
	action: string,
) {
	await tx
		.update(staffScopeAssignments)
		.set({
			active: false,
			isPrimary: false,
			pinLookup: null,
			pinSetAt: null,
			pinFailedCount: 0,
			pinLockedUntil: null,
			updatedAt: Date.now(),
		})
		.where(eq(staffScopeAssignments.id, assignment.id))
	if (staff.primaryScopeId === assignment.scopeId) {
		await tx
			.update(staffMembers)
			.set({ primaryScopeId: null, updatedAt: Date.now() })
			.where(eq(staffMembers.id, staff.id))
	}
	const closedJobs = await closeOpenJobs(
		tx,
		staff.id,
		effectiveDate,
		assignment.scopeId,
	)
	await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
		action,
		entityType: 'assignment',
		entityId: assignment.id,
		staffId: staff.id,
		scopeId: assignment.scopeId,
		changes: { closedJobs, pinCleared: assignment.pinLookup !== null },
	})
}

export async function updateAssignment(
	ctx: StaffContext,
	staffId: string,
	assignmentId: string,
	patch: StaffAssignmentUpdate,
): Promise<Result<{ assignment: ReturnType<typeof serializeAssignment> }>> {
	return write(ctx.db, async (tx) => {
		const loaded = await loadAssignment(tx, ctx, staffId, assignmentId)
		if (!loaded.ok) return loaded
		const { staff, assignment } = loaded.value
		if (staff.status === 'terminated') {
			return fail(409, 'staff_terminated', 'Rehire this person first')
		}
		const { isPrimary, active, ...flags } = patch
		if (isPrimary && (active === false || !assignment.active)) {
			return fail(
				422,
				'inactive_primary',
				'An inactive workplace cannot be primary',
			)
		}
		if (active === false && assignment.active) {
			await deactivate(
				tx,
				ctx,
				staff,
				assignment,
				utcToday(Date.now()),
				'staff.assignment.deactivated',
			)
		} else if (active === true && !assignment.active) {
			await tx
				.update(staffScopeAssignments)
				.set({ active: true, updatedAt: Date.now() })
				.where(eq(staffScopeAssignments.id, assignment.id))
			await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
				action: 'staff.assignment.reactivated',
				entityType: 'assignment',
				entityId: assignment.id,
				staffId,
				scopeId: assignment.scopeId,
			})
		}
		const flagChanges = diffFields(
			assignment as unknown as Record<string, unknown>,
			flags,
		)
		if (Object.keys(flagChanges).length > 0) {
			await tx
				.update(staffScopeAssignments)
				.set({ ...flags, updatedAt: Date.now() })
				.where(eq(staffScopeAssignments.id, assignment.id))
			await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
				action: 'staff.assignment.updated',
				entityType: 'assignment',
				entityId: assignment.id,
				staffId,
				scopeId: assignment.scopeId,
				changes: flagChanges,
			})
		}
		if (isPrimary === true && staff.primaryScopeId !== assignment.scopeId) {
			await setPrimaryAssignment(tx, staffId, assignment.scopeId)
			await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
				action: 'staff.updated',
				entityType: 'staff',
				entityId: staffId,
				staffId,
				changes: {
					primaryScopeId: {
						before: staff.primaryScopeId,
						after: assignment.scopeId,
					},
				},
			})
		}
		const [fresh] = await tx
			.select()
			.from(staffScopeAssignments)
			.where(eq(staffScopeAssignments.id, assignmentId))
		return ok({ assignment: serializeAssignment(fresh!) })
	})
}

/** Removing an assignment deactivates it (and clears its PIN); rows are kept for history. */
export async function removeAssignment(
	ctx: StaffContext,
	staffId: string,
	assignmentId: string,
	effectiveDate?: string,
): Promise<Result<{ assignment: ReturnType<typeof serializeAssignment> }>> {
	return write(ctx.db, async (tx) => {
		const loaded = await loadAssignment(tx, ctx, staffId, assignmentId)
		if (!loaded.ok) return loaded
		const { staff, assignment } = loaded.value
		if (assignment.active) {
			await deactivate(
				tx,
				ctx,
				staff,
				assignment,
				effectiveDate ?? utcToday(Date.now()),
				'staff.assignment.removed',
			)
		}
		const [fresh] = await tx
			.select()
			.from(staffScopeAssignments)
			.where(eq(staffScopeAssignments.id, assignmentId))
		return ok({ assignment: serializeAssignment(fresh!) })
	})
}

// ---------------------------------------------------------------------------
// PINs
// ---------------------------------------------------------------------------

export type PinOutcome = {
	/** Shown exactly once, in this response. Never stored and never read back. */
	pin: string
	assignmentId: string
	pinSetAt: number
}

export async function setPin(
	ctx: StaffContext,
	staffId: string,
	assignmentId: string,
	requestedPin: string | undefined,
): Promise<Result<PinOutcome>> {
	const { db, auth } = ctx
	return write(db, async (tx) => {
		const loaded = await loadAssignment(tx, ctx, staffId, assignmentId)
		if (!loaded.ok) return loaded
		const { staff, assignment } = loaded.value
		if (staff.status === 'terminated') {
			return fail(409, 'staff_terminated', 'Terminated staff cannot have a PIN')
		}
		if (!assignment.active) return fail(409, 'assignment_inactive')

		const settings = await getSettings(tx)
		const length = settings.pinLength || PIN_DEFAULT_LENGTH
		const lookupFor = (pin: string) =>
			hmacHash(pinLookupMessage(auth.orgId, assignment.scopeId, pin))

		let chosen: string | null = null
		let mode: 'generated' | 'custom'
		const setAt = Date.now()
		const apply = async (pin: string) => {
			try {
				await tx
					.update(staffScopeAssignments)
					.set({
						pinLookup: lookupFor(pin),
						pinSetAt: setAt,
						pinFailedCount: 0,
						pinLockedUntil: null,
						updatedAt: setAt,
					})
					.where(eq(staffScopeAssignments.id, assignment.id))
				return true
			} catch (error) {
				if (isUniqueViolation(error, ['pin_lookup'])) return false
				throw error
			}
		}

		if (requestedPin !== undefined) {
			mode = 'custom'
			const normalized = normalizePinDigits(requestedPin)
			const problem = checkPin(normalized, length)
			if (problem) {
				return fail(
					422,
					'invalid_pin',
					`PIN must be ${length} digits and not guessable (${problem})`,
				)
			}
			if (!(await apply(normalized))) {
				// Deliberately generic: do not reveal who holds the PIN.
				return fail(409, 'pin_unavailable', 'Choose another PIN')
			}
			chosen = normalized
		} else {
			mode = 'generated'
			for (let attempt = 0; attempt < 30 && !chosen; attempt++) {
				const candidate = generatePin(length)
				if (await apply(candidate)) chosen = candidate
			}
			if (!chosen) return fail(409, 'pin_unavailable', 'Try again')
		}

		await writeStaffAudit(tx, auth, ctx.ipHash, {
			action: 'staff.pin.reset',
			entityType: 'assignment',
			entityId: assignment.id,
			staffId,
			scopeId: assignment.scopeId,
			// The PIN and its lookup are never written to the audit log.
			changes: { mode, hadPin: assignment.pinLookup !== null },
		})
		return ok({ pin: chosen, assignmentId: assignment.id, pinSetAt: setAt })
	})
}

export async function clearPin(
	ctx: StaffContext,
	staffId: string,
	assignmentId: string,
): Promise<Result<{ assignment: ReturnType<typeof serializeAssignment> }>> {
	return write(ctx.db, async (tx) => {
		const loaded = await loadAssignment(tx, ctx, staffId, assignmentId)
		if (!loaded.ok) return loaded
		const { assignment } = loaded.value
		await tx
			.update(staffScopeAssignments)
			.set({
				pinLookup: null,
				pinSetAt: null,
				pinFailedCount: 0,
				pinLockedUntil: null,
				updatedAt: Date.now(),
			})
			.where(eq(staffScopeAssignments.id, assignmentId))
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'staff.pin.cleared',
			entityType: 'assignment',
			entityId: assignmentId,
			staffId,
			scopeId: assignment.scopeId,
			changes: { hadPin: assignment.pinLookup !== null },
		})
		const [fresh] = await tx
			.select()
			.from(staffScopeAssignments)
			.where(eq(staffScopeAssignments.id, assignmentId))
		return ok({ assignment: serializeAssignment(fresh!) })
	})
}

// ---------------------------------------------------------------------------
// Jobs and effective-dated pay
// ---------------------------------------------------------------------------

export async function createJob(
	ctx: StaffContext,
	staffId: string,
	input: StaffJobCreate,
): Promise<Result<{ job: ReturnType<typeof serializeJob> }>> {
	const { db, auth, scope } = ctx
	if (!scope.allows(input.scopeId)) return fail(403, 'scope_out_of_scope')

	const setsPay =
		input.rateMinor !== null ||
		input.annualSalaryMinor !== null ||
		input.payType === 'salary' ||
		input.overtimeExempt ||
		input.tipEligible
	if (setsPay && !hasGrant(auth, 'update:staff_pay:any')) {
		return fail(403, 'Forbidden', 'update:staff_pay:any')
	}

	try {
		return await write(db, async (tx) => {
			const access = await loadVisible(tx, scope, staffId)
			if (!access.ok) return access
			const { staff, allAssignments } = access.value
			if (staff.status === 'terminated') {
				return fail(409, 'staff_terminated', 'Rehire this person first')
			}
			if (
				!allAssignments.some((a) => a.scopeId === input.scopeId && a.active)
			) {
				return fail(
					409,
					'not_assigned_to_scope',
					'Assign the person to the workplace first',
				)
			}
			const [position] = await tx
				.select()
				.from(staffPositions)
				.where(eq(staffPositions.id, input.positionId))
				.limit(1)
			if (!position) return fail(404, 'Position not found')
			if (position.archivedAt !== null) {
				return fail(409, 'position_archived')
			}
			const [row] = await tx
				.insert(staffJobs)
				.values({
					staffId,
					scopeId: input.scopeId,
					positionId: input.positionId,
					payType: input.payType,
					rateMinor: input.rateMinor,
					annualSalaryMinor: input.annualSalaryMinor,
					currency: input.currency,
					overtimeExempt: input.overtimeExempt,
					tipEligible: input.tipEligible,
					isPrimary: input.isPrimary,
					effectiveFrom: input.effectiveFrom,
					createdBy: auth.userId,
				})
				.returning()
			await writeStaffAudit(tx, auth, ctx.ipHash, {
				action: 'staff.job.added',
				entityType: 'job',
				entityId: row!.id,
				staffId,
				scopeId: input.scopeId,
				changes: { positionId: input.positionId, primary: input.isPrimary },
			})
			if (setsPay) {
				await writeStaffAudit(tx, auth, ctx.ipHash, {
					action: 'staff.pay.set',
					entityType: 'job',
					entityId: row!.id,
					staffId,
					scopeId: input.scopeId,
					sensitivity: 'pay',
					changes: payAfter(row!),
				})
			}
			return ok({ job: serializeJob(row!, canSeePay(auth)) })
		})
	} catch (error) {
		// SQLite names only the indexed columns: the open-position index includes
		// position_id, the open-primary index does not.
		if (isUniqueViolation(error, ['position_id'])) {
			return fail(
				409,
				'job_exists',
				'This person already holds this position here; change the rate instead',
			)
		}
		if (isUniqueViolation(error, ['staff_jobs'])) {
			return fail(409, 'primary_job_exists')
		}
		throw error
	}
}

function payAfter(job: StaffJob) {
	return {
		payType: job.payType,
		rateMinor: job.rateMinor,
		annualSalaryMinor: job.annualSalaryMinor,
		currency: job.currency,
		overtimeExempt: job.overtimeExempt,
		tipEligible: job.tipEligible,
		effectiveFrom: job.effectiveFrom,
	}
}

export async function changeRate(
	ctx: StaffContext,
	staffId: string,
	jobId: string,
	input: StaffRateChange,
): Promise<
	Result<{
		job: ReturnType<typeof serializeJob>
		closed: ReturnType<typeof serializeJob>
	}>
> {
	const { db, auth, scope } = ctx
	try {
		return await write(db, async (tx) => {
			const access = await loadVisible(tx, scope, staffId)
			if (!access.ok) return access
			if (access.value.staff.status === 'terminated') {
				return fail(409, 'staff_terminated')
			}
			const [job] = await tx
				.select()
				.from(staffJobs)
				.where(and(eq(staffJobs.id, jobId), eq(staffJobs.staffId, staffId)))
				.limit(1)
			if (!job) return fail(404, 'Job not found')
			if (!scope.allows(job.scopeId)) return fail(404, 'Job not found')
			if (job.effectiveTo !== null) {
				return fail(409, 'job_closed', 'Only the current job row can change')
			}
			if (input.effectiveFrom <= job.effectiveFrom) {
				return fail(
					409,
					'effective_date_not_after_current',
					'A change must take effect after the current rate started',
				)
			}

			const payType = input.payType ?? job.payType
			const rateMinor =
				input.rateMinor !== undefined ? input.rateMinor : job.rateMinor
			let annualSalaryMinor =
				input.annualSalaryMinor !== undefined
					? input.annualSalaryMinor
					: job.annualSalaryMinor
			if (payType === 'salary' && annualSalaryMinor === null) {
				return fail(422, 'salary_required', 'Salary jobs need an annual salary')
			}
			if (payType === 'hourly') annualSalaryMinor = null
			const overtimeExempt = input.overtimeExempt ?? job.overtimeExempt
			const tipEligible = input.tipEligible ?? job.tipEligible

			if (
				payType === job.payType &&
				rateMinor === job.rateMinor &&
				annualSalaryMinor === job.annualSalaryMinor &&
				overtimeExempt === job.overtimeExempt &&
				tipEligible === job.tipEligible
			) {
				return fail(422, 'no_change', 'Nothing about the pay would change')
			}

			// Close first, then insert, so the open-row unique indexes hold.
			const closeDate = addDays(input.effectiveFrom, -1)
			await tx
				.update(staffJobs)
				.set({ effectiveTo: closeDate })
				.where(and(eq(staffJobs.id, job.id), isNull(staffJobs.effectiveTo)))
			const [next] = await tx
				.insert(staffJobs)
				.values({
					staffId,
					scopeId: job.scopeId,
					positionId: job.positionId,
					payType,
					rateMinor,
					annualSalaryMinor,
					currency: job.currency,
					overtimeExempt,
					tipEligible,
					isPrimary: job.isPrimary,
					effectiveFrom: input.effectiveFrom,
					changeReason: input.reason,
					createdBy: auth.userId,
				})
				.returning()
			await writeStaffAudit(tx, auth, ctx.ipHash, {
				action: 'staff.pay.changed',
				entityType: 'job',
				entityId: next!.id,
				staffId,
				scopeId: job.scopeId,
				sensitivity: 'pay',
				changes: {
					before: payAfter(job),
					after: payAfter(next!),
					previousJobId: job.id,
					reason: input.reason,
				},
			})
			return ok({
				job: serializeJob(next!, true),
				closed: serializeJob({ ...job, effectiveTo: closeDate }, true),
			})
		})
	} catch (error) {
		if (isUniqueViolation(error, ['staff_jobs'])) {
			return fail(409, 'job_exists')
		}
		throw error
	}
}

// ---------------------------------------------------------------------------
// Terminate and rehire
// ---------------------------------------------------------------------------

export async function terminateStaff(
	ctx: StaffContext,
	staffId: string,
	input: StaffTerminateInput,
): Promise<Result<{ staff: ReturnType<typeof serializeStaff> }>> {
	return write(ctx.db, async (tx) => {
		const access = await loadVisible(tx, ctx.scope, staffId)
		if (!access.ok) return access
		const { staff, allAssignments, coversAll } = access.value
		if (staff.status === 'terminated') return fail(409, 'already_terminated')
		// Ending employment affects every scope the person works at, so a
		// scope-limited manager can only do it when all of them are theirs.
		if (!coversAll) return fail(403, 'scope_out_of_scope')

		const now = Date.now()
		const effectiveDate = input.effectiveDate ?? utcToday(now)
		const [updated] = await tx
			.update(staffMembers)
			.set({
				status: 'terminated',
				terminatedAt: now,
				terminationReason: input.reason,
				eligibleForRehire: input.eligibleForRehire,
				updatedAt: now,
			})
			.where(eq(staffMembers.id, staffId))
			.returning()
		// PINs are cleared at termination; assignments stay as history.
		await tx
			.update(staffScopeAssignments)
			.set({
				active: false,
				isPrimary: false,
				pinLookup: null,
				pinSetAt: null,
				pinFailedCount: 0,
				pinLockedUntil: null,
				updatedAt: now,
			})
			.where(eq(staffScopeAssignments.staffId, staffId))
		const closedJobs = await closeOpenJobs(tx, staffId, effectiveDate)
		// Their "my schedule" link stops working with their employment.
		const linkRevoked = await revokeScheduleLink(
			tx,
			staffId,
			now,
			LINK_SYSTEM_ACTOR,
		)
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'staff.terminated',
			entityType: 'staff',
			entityId: staffId,
			staffId,
			scopeId: staff.primaryScopeId,
			changes: {
				reason: input.reason,
				effectiveDate,
				eligibleForRehire: input.eligibleForRehire,
				closedJobs,
				pinsCleared: allAssignments.filter((a) => a.pinLookup !== null).length,
				scheduleLinkRevoked: linkRevoked,
			},
		})
		return ok({ staff: serializeStaff(updated!, ctx.scope) })
	})
}

export async function rehireStaff(
	ctx: StaffContext,
	staffId: string,
	input: StaffRehireInput,
): Promise<Result<{ staff: ReturnType<typeof serializeStaff> }>> {
	return write(ctx.db, async (tx) => {
		const access = await loadVisible(tx, ctx.scope, staffId)
		if (!access.ok) return access
		const { staff, coversAll } = access.value
		if (staff.status !== 'terminated') return fail(409, 'not_terminated')
		if (!coversAll) return fail(403, 'scope_out_of_scope')
		// An erased person's row is only a pseudonymous pay record; it cannot be
		// brought back. Add the person again as a new staff member instead.
		if (staff.terminationReason === ERASED_TERMINATION_REASON) {
			return fail(409, 'erased')
		}
		if (staff.eligibleForRehire === false && !input.overrideIneligible) {
			return fail(
				409,
				'not_eligible_for_rehire',
				'This person was marked not eligible for rehire',
			)
		}
		const [updated] = await tx
			.update(staffMembers)
			.set({
				status: 'active',
				terminatedAt: null,
				terminationReason: null,
				eligibleForRehire: null,
				updatedAt: Date.now(),
			})
			.where(eq(staffMembers.id, staffId))
			.returning()
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'staff.rehired',
			entityType: 'staff',
			entityId: staffId,
			staffId,
			changes: {
				reason: input.reason,
				overrodeIneligible:
					staff.eligibleForRehire === false && input.overrideIneligible,
				previousTerminationReason: staff.terminationReason,
				previousTerminatedAt: staff.terminatedAt,
			},
		})
		return ok({ staff: serializeStaff(updated!, ctx.scope) })
	})
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export async function listNotes(ctx: StaffContext, staffId: string) {
	const access = await loadVisible(ctx.db, ctx.scope, staffId)
	if (!access.ok) return access
	const rows = await ctx.db
		.select()
		.from(staffNotes)
		.where(and(eq(staffNotes.staffId, staffId), isNull(staffNotes.deletedAt)))
		.orderBy(desc(staffNotes.createdAt))
		.limit(200)
	return ok({
		notes: rows.map((n) => ({
			id: n.id,
			staffId: n.staffId,
			authorId: n.authorId,
			body: n.body,
			createdAt: n.createdAt,
		})),
	})
}

export async function addNote(
	ctx: StaffContext,
	staffId: string,
	body: string,
) {
	return write(ctx.db, async (tx) => {
		const access = await loadVisible(tx, ctx.scope, staffId)
		if (!access.ok) return access
		const [note] = await tx
			.insert(staffNotes)
			.values({ staffId, authorId: ctx.auth.userId, body })
			.returning()
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'staff.note.added',
			entityType: 'note',
			entityId: note!.id,
			staffId,
			// The note text itself is not copied into the audit log.
			changes: { length: body.length },
		})
		return ok({
			note: {
				id: note!.id,
				staffId,
				authorId: note!.authorId,
				body: note!.body,
				createdAt: note!.createdAt,
			},
		})
	})
}

export async function removeNote(
	ctx: StaffContext,
	staffId: string,
	noteId: string,
) {
	return write(ctx.db, async (tx) => {
		const access = await loadVisible(tx, ctx.scope, staffId)
		if (!access.ok) return access
		const [note] = await tx
			.select()
			.from(staffNotes)
			.where(
				and(
					eq(staffNotes.id, noteId),
					eq(staffNotes.staffId, staffId),
					isNull(staffNotes.deletedAt),
				),
			)
			.limit(1)
		if (!note) return fail(404, 'Note not found')
		await tx
			.update(staffNotes)
			.set({ deletedAt: Date.now() })
			.where(eq(staffNotes.id, noteId))
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'staff.note.removed',
			entityType: 'note',
			entityId: noteId,
			staffId,
		})
		return ok({ removed: true as const })
	})
}

// ---------------------------------------------------------------------------
// Audit log reads
// ---------------------------------------------------------------------------

const SCOPE_ID_KEYS = new Set(['scopeId', 'primaryScopeId'])

/**
 * An audit row is visible to a scoped token because its own `scopeId` is in
 * scope, but its `changes` can still name other scopes (a person created at
 * two scopes, a primary scope moved from one to another). Those ids are
 * withheld so a manager sees only their own part of the story.
 */
export function redactChangesForScope(
	changes: unknown,
	scope: Pick<ScopeAccess, 'allows' | 'unrestricted'>,
): unknown {
	if (scope.unrestricted) return changes
	const redact = (value: unknown, key?: string): unknown => {
		if (Array.isArray(value)) {
			if (key === 'scopes') {
				return value.filter(
					(item) => typeof item !== 'string' || scope.allows(item),
				)
			}
			return value.map((item) => redact(item))
		}
		if (value && typeof value === 'object') {
			const out: Record<string, unknown> = {}
			for (const [childKey, child] of Object.entries(value)) {
				out[childKey] = redact(child, key ?? childKey)
			}
			return out
		}
		if (
			typeof value === 'string' &&
			key !== undefined &&
			SCOPE_ID_KEYS.has(key) &&
			!scope.allows(value)
		) {
			return null
		}
		return value
	}
	return redact(changes)
}

export async function listAudit(
	ctx: StaffContext,
	query: { staffId?: string; action?: string; before?: number; limit: number },
) {
	const sensitivities = readableSensitivities(ctx.auth)
	// bounded: at most three sensitivity levels
	const conditions: SQL[] = [inArray(staffAuditLog.sensitivity, sensitivities)]
	if (query.staffId) conditions.push(eq(staffAuditLog.staffId, query.staffId))
	if (query.action) conditions.push(eq(staffAuditLog.action, query.action))
	if (query.before) conditions.push(lt(staffAuditLog.at, query.before))
	// A scoped token sees only rows tied to its scopes; rows with no
	// scope (settings, positions) are unrestricted-only.
	const inScope = ctx.scope.where(staffAuditLog.scopeId)
	if (inScope) conditions.push(inScope)

	const rows = await ctx.db
		.select()
		.from(staffAuditLog)
		.where(and(...conditions))
		.orderBy(desc(staffAuditLog.at), desc(staffAuditLog.id))
		.limit(query.limit)
	return {
		entries: rows.map((row) => ({
			id: row.id,
			at: row.at,
			actorId: row.actorId,
			impersonated: row.impersonated,
			action: row.action,
			entityType: row.entityType,
			entityId: row.entityId,
			staffId: row.staffId,
			scopeId: row.scopeId,
			sensitivity: row.sensitivity,
			changes: redactChangesForScope(row.changes, ctx.scope),
		})),
	}
}
