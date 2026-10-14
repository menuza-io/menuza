import { and, asc, count, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { STAFF_EXPORT_FORMAT, type StaffSummary } from '@repo/staffing'
import {
	hiringApplications,
	staffAuditLog,
	staffJobs,
	staffScopeAssignments,
	staffMembers,
	onboardingTasks,
	staffCertificates,
	staffNotes,
	staffPositions,
	staffPrivate,
	staffingSettings,
	shiftRequests,
	shifts,
	staffAvailability,
	timeEntries,
	timeOffRequests,
	type TenantDatabase,
} from '@repo/tenant-db'
import { getNodeRegion } from '../lib/region.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { hasGrant } from '../lib/staff-auth.ts'
import {
	LINK_SYSTEM_ACTOR,
	revokeScheduleLink,
} from './schedule-link-service.ts'
import {
	writeStaffAudit,
	writeSystemAudit,
	type StaffDb,
} from './staff-audit.ts'
import { eraseApplicationsForStaff } from './hiring-service.ts'
import {
	closeOpenJobs,
	ERASED_TERMINATION_REASON,
	serializeAssignment,
	serializeJob,
	serializePosition,
	serializeSettings,
	serializeStaff,
	utcToday,
	type Failure,
	type StaffContext,
} from './staff-service.ts'

/**
 * Server-to-server staff operations for `/internal/staff`: summary counts for
 * the region-switch guard, linking and unlinking an App login, erasure of a
 * deleted account, and the in-region export used for access requests.
 *
 * Nothing here is reachable with an operator token. Inputs are opaque ids,
 * outputs are counts or (for exports) the data subject's own record; the
 * control plane never receives a name, a contact detail or a pay figure from
 * these functions except through `exportSubject`, which refuses to run on a
 * node that holds data that may not leave its region.
 */

export type InternalResult<T> = { ok: true; value: T } | Failure

const ok = <T>(value: T): InternalResult<T> => ({ ok: true, value })
const fail = (
	status: Failure['status'],
	error: string,
	message?: string,
): Failure => ({ ok: false, status, error, ...(message ? { message } : {}) })

function write<T>(
	db: TenantDatabase,
	fn: (
		tx: Parameters<Parameters<TenantDatabase['transaction']>[0]>[0],
	) => Promise<T>,
): Promise<T> {
	return retryOnSqliteBusy(() => db.transaction(fn))
}

function isUniqueViolation(error: unknown): boolean {
	let root: unknown = error
	while (root instanceof Error && (root as { cause?: unknown }).cause) {
		root = (root as { cause?: unknown }).cause
	}
	return (
		root instanceof Error &&
		/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(root.message)
	)
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** What a region switch would destroy: counts only. */
export async function summarizeStaff(
	db: TenantDatabase,
): Promise<StaffSummary> {
	const [
		byStatusRows,
		[linked],
		[assignments],
		[positions],
		[jobs],
		[notes],
		[applicants],
		[timeCardRows],
		[shiftRows],
	] = await Promise.all([
		db
			.select({ status: staffMembers.status, total: count() })
			.from(staffMembers)
			.groupBy(staffMembers.status),
		db
			.select({ total: count() })
			.from(staffMembers)
			.where(isNotNull(staffMembers.userId)),
		db.select({ total: count() }).from(staffScopeAssignments),
		db.select({ total: count() }).from(staffPositions),
		db.select({ total: count() }).from(staffJobs),
		db.select({ total: count() }).from(staffNotes),
		db.select({ total: count() }).from(hiringApplications),
		db.select({ total: count() }).from(timeEntries),
		db.select({ total: count() }).from(shifts),
	])
	const [audit] = await db.select({ total: count() }).from(staffAuditLog)

	const byStatus = { invited: 0, active: 0, on_leave: 0, terminated: 0 }
	let staff = 0
	for (const row of byStatusRows) {
		staff += row.total
		if (row.status in byStatus) {
			byStatus[row.status as keyof typeof byStatus] = row.total
		}
	}
	return {
		staff,
		byStatus,
		linkedLogins: linked?.total ?? 0,
		scopeAssignments: assignments?.total ?? 0,
		positions: positions?.total ?? 0,
		payRecords: jobs?.total ?? 0,
		notes: notes?.total ?? 0,
		applicants: applicants?.total ?? 0,
		timeCards: timeCardRows?.total ?? 0,
		shifts: shiftRows?.total ?? 0,
		auditEntries: audit?.total ?? 0,
	}
}

// ---------------------------------------------------------------------------
// Link and unlink
// ---------------------------------------------------------------------------

/**
 * Connects a staff row to the control-plane login that accepted an invitation
 * carrying its id. Idempotent for the same pair; refuses to take over a row that
 * belongs to another login, to give one login two staff rows, and to link a
 * terminated (or erased) row.
 */
export async function linkUser(
	db: TenantDatabase,
	input: { staffMemberId: string; userId: string },
): Promise<InternalResult<{ linked: boolean; alreadyLinked: boolean }>> {
	try {
		return await write(db, async (tx) => {
			const [staff] = await tx
				.select()
				.from(staffMembers)
				.where(eq(staffMembers.id, input.staffMemberId))
				.limit(1)
			if (!staff) return fail(404, 'staff_not_found')
			if (staff.userId === input.userId) {
				return ok({ linked: true, alreadyLinked: true })
			}
			if (staff.userId) return fail(409, 'staff_linked_to_other_user')
			if (staff.status === 'terminated') return fail(409, 'staff_terminated')
			const [other] = await tx
				.select({ id: staffMembers.id })
				.from(staffMembers)
				.where(eq(staffMembers.userId, input.userId))
				.limit(1)
			if (other) return fail(409, 'user_already_linked')

			await tx
				.update(staffMembers)
				.set({ userId: input.userId, updatedAt: Date.now() })
				.where(eq(staffMembers.id, staff.id))
			await writeSystemAudit(tx, {
				action: 'staff.user_linked',
				entityType: 'staff',
				entityId: staff.id,
				staffId: staff.id,
				scopeId: staff.primaryScopeId,
				changes: { userId: input.userId },
			})
			return ok({ linked: true, alreadyLinked: false })
		})
	} catch (error) {
		if (isUniqueViolation(error)) return fail(409, 'user_already_linked')
		throw error
	}
}

/**
 * Detaches a login from its staff row when the member's app access is removed.
 * This is deliberately NOT termination: the person keeps their schedule, PIN
 * and pay history, and can still clock in. Idempotent: nothing linked is a
 * success with a count of zero.
 */
export async function unlinkUser(
	db: TenantDatabase,
	input: { userId: string },
): Promise<InternalResult<{ unlinked: number }>> {
	return write(db, async (tx) => {
		const rows = await tx
			.select({
				id: staffMembers.id,
				primaryScopeId: staffMembers.primaryScopeId,
			})
			.from(staffMembers)
			.where(eq(staffMembers.userId, input.userId))
		for (const row of rows) {
			await tx
				.update(staffMembers)
				.set({ userId: null, updatedAt: Date.now() })
				.where(eq(staffMembers.id, row.id))
			await writeSystemAudit(tx, {
				action: 'staff.user_unlinked',
				entityType: 'staff',
				entityId: row.id,
				staffId: row.id,
				scopeId: row.primaryScopeId,
				changes: { userId: input.userId },
			})
		}
		return ok({ unlinked: rows.length })
	})
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

/** Replaces an audit row's field-level values. The only edit the log allows. */
const REDACTED = { redacted: true } as const

/**
 * Anonymizes the staff row linked to an erased login. What goes: names
 * (replaced by a pseudonym), contact details, employee number, login link, PIN
 * lookups, the private record (birth date, address, emergency contact), notes,
 * the free text on their schedule requests, and the before/after values in the person's audit rows. What stays: the row
 * itself as a terminated pseudonym, its scope assignments (deactivated) and
 * its effective-dated pay history, because wage records have a legal retention
 * period that outlives the account. Time entries will stay the same way under
 * the pseudonym. The audit trail of who did what and when is kept, redacted.
 *
 * Idempotent: once the link is cleared there is nothing left to find.
 */
export async function eraseLinkedUser(
	db: TenantDatabase,
	input: { userId: string },
): Promise<InternalResult<{ erased: number }>> {
	return write(db, async (tx) => {
		const rows = await tx
			.select()
			.from(staffMembers)
			.where(eq(staffMembers.userId, input.userId))
		const now = Date.now()
		for (const staff of rows) {
			// Redact first: the erasure's own audit row is written afterwards and
			// stays readable.
			const redacted = await tx
				.update(staffAuditLog)
				.set({ changes: REDACTED })
				.where(
					and(
						eq(staffAuditLog.staffId, staff.id),
						isNotNull(staffAuditLog.changes),
						sql`${staffAuditLog.changes} <> '{"redacted":true}'`,
					),
				)
				.returning({ id: staffAuditLog.id })
			const deletedNotes = await tx
				.delete(staffNotes)
				.where(eq(staffNotes.staffId, staff.id))
				.returning({ id: staffNotes.id })
			// The application this person was hired from (answers, contact details,
			// notes, interviews) is personal data too, and goes with them.
			const applicationsErased = await eraseApplicationsForStaff(tx, [staff.id])
			// Checklist tasks (who ticked what, and when) and certificates are
			// about this person alone; neither has a retention duty, so both go.
			const deletedTasks = await tx
				.delete(onboardingTasks)
				.where(eq(onboardingTasks.staffId, staff.id))
				.returning({ id: onboardingTasks.id })
			const deletedCertificates = await tx
				.delete(staffCertificates)
				.where(eq(staffCertificates.staffId, staff.id))
				.returning({ id: staffCertificates.id })
			const deletedPrivate = await tx
				.delete(staffPrivate)
				.where(eq(staffPrivate.staffId, staff.id))
				.returning({ staffId: staffPrivate.staffId })
			// Free text a person (or a manager about them) wrote on a time-off,
			// availability or swap/cover/drop request goes with them; the request
			// rows and their dates stay as scheduling history.
			await tx
				.update(timeOffRequests)
				.set({ note: null, decisionNote: null })
				.where(eq(timeOffRequests.staffId, staff.id))
			await tx
				.update(staffAvailability)
				.set({ note: null, decisionNote: null })
				.where(eq(staffAvailability.staffId, staff.id))
			await tx
				.update(shiftRequests)
				.set({ note: null, decisionNote: null })
				.where(eq(shiftRequests.requesterStaffId, staff.id))
			const assignments = await tx
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
				.where(eq(staffScopeAssignments.staffId, staff.id))
				.returning({ id: staffScopeAssignments.id })
			const closedJobs = await closeOpenJobs(tx, staff.id, utcToday(now))
			await revokeScheduleLink(tx, staff.id, now, LINK_SYSTEM_ACTOR)
			await tx
				.update(staffMembers)
				.set({
					firstName: 'Erased',
					lastName: `Staff ${staff.id.slice(0, 8)}`,
					firstNameAr: null,
					lastNameAr: null,
					email: null,
					phone: null,
					userId: null,
					employeeNumber: null,
					status: 'terminated',
					terminatedAt: staff.terminatedAt ?? now,
					terminationReason: ERASED_TERMINATION_REASON,
					eligibleForRehire: false,
					updatedAt: now,
				})
				.where(eq(staffMembers.id, staff.id))
			await writeSystemAudit(tx, {
				action: 'staff.erased',
				entityType: 'staff',
				entityId: staff.id,
				staffId: staff.id,
				scopeId: staff.primaryScopeId,
				changes: {
					auditRowsRedacted: redacted.length,
					notesDeleted: deletedNotes.length,
					onboardingTasksDeleted: deletedTasks.length,
					certificatesDeleted: deletedCertificates.length,
					applicationsErased,
					privateRecordDeleted: deletedPrivate.length > 0,
					assignmentsDeactivated: assignments.length,
					closedJobs,
				},
			})
		}
		return ok({ erased: rows.length })
	})
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Most audit rows a single export file carries. */
export const EXPORT_AUDIT_LIMIT = 20_000

export type ExportOptions = {
	/** Limit to one person. Omitted exports the whole roster. */
	staffId?: string
	/** Which sensitive groups to include (the caller's grants decide). */
	include: { pay: boolean; private: boolean }
	/** Operator ids and client hashes are left out of a person's own copy. */
	includeActors: boolean
}

/**
 * Everything the regional database holds about staff, shaped for a file.
 * `pin_lookup`, failure counters and other secrets are never included. Pay and
 * private groups appear only when `include` allows them; they are omitted, not
 * blanked.
 */
export async function buildStaffExport(
	db: StaffDb,
	options: ExportOptions,
	meta: { orgId: string },
) {
	const staffRows = await db
		.select()
		.from(staffMembers)
		.where(options.staffId ? eq(staffMembers.id, options.staffId) : undefined)
		.orderBy(asc(staffMembers.lastName), asc(staffMembers.firstName))
	const staffIds = staffRows.map((row) => row.id)

	const applications = staffIds.length
		? await db
				.select()
				.from(hiringApplications)
				.where(inArray(hiringApplications.hiredStaffId, staffIds))
		: []
	const [assignments, jobs, notes, privates, tasks, certificates] =
		staffIds.length
			? await Promise.all([
					db
						.select()
						.from(staffScopeAssignments)
						.where(inArray(staffScopeAssignments.staffId, staffIds)),
					db
						.select()
						.from(staffJobs)
						.where(inArray(staffJobs.staffId, staffIds))
						.orderBy(desc(staffJobs.effectiveFrom), desc(staffJobs.createdAt)),
					db
						.select()
						.from(staffNotes)
						.where(inArray(staffNotes.staffId, staffIds))
						.orderBy(desc(staffNotes.createdAt)),
					options.include.private
						? db
								.select()
								.from(staffPrivate)
								.where(inArray(staffPrivate.staffId, staffIds))
						: Promise.resolve([]),
					db
						.select()
						.from(onboardingTasks)
						.where(inArray(onboardingTasks.staffId, staffIds))
						.orderBy(asc(onboardingTasks.sortOrder)),
					db
						.select()
						.from(staffCertificates)
						.where(inArray(staffCertificates.staffId, staffIds))
						.orderBy(asc(staffCertificates.expiresOn)),
				])
			: [[], [], [], [], [], []]

	// A person's own copy lists only the positions they hold.
	const positionIds = new Set(jobs.map((job) => job.positionId))
	const allPositions = await db
		.select()
		.from(staffPositions)
		.orderBy(asc(staffPositions.name))
	const positions = options.staffId
		? allPositions.filter((row) => positionIds.has(row.id))
		: allPositions

	const sensitivities: Array<'standard' | 'pay' | 'private'> = ['standard']
	if (options.include.pay) sensitivities.push('pay')
	if (options.include.private) sensitivities.push('private')
	const auditRows = await db
		.select()
		.from(staffAuditLog)
		.where(
			and(
				inArray(staffAuditLog.sensitivity, sensitivities),
				options.staffId
					? eq(staffAuditLog.staffId, options.staffId)
					: undefined,
			),
		)
		.orderBy(desc(staffAuditLog.at), desc(staffAuditLog.id))
		.limit(EXPORT_AUDIT_LIMIT + 1)

	const settings = options.staffId
		? null
		: await db
				.select()
				.from(staffingSettings)
				.where(eq(staffingSettings.id, 'org'))
				.limit(1)
				.then((rows) => rows[0] ?? null)

	const byStaff = <T extends { staffId: string }>(rows: T[], id: string) =>
		rows.filter((row) => row.staffId === id)

	return {
		format: STAFF_EXPORT_FORMAT,
		exportedAt: Date.now(),
		orgId: meta.orgId,
		region: getNodeRegion(),
		includes: { pay: options.include.pay, private: options.include.private },
		settings: settings ? serializeSettings(settings) : null,
		positions: positions.map((row) =>
			serializePosition(row, options.include.pay),
		),
		staff: staffRows.map((row) => {
			const own = byStaff(privates, row.id)[0]
			return {
				...serializeStaff(row),
				assignments: byStaff(assignments, row.id).map(serializeAssignment),
				jobs: byStaff(jobs, row.id).map((job) =>
					serializeJob(job, options.include.pay),
				),
				// What the person told us when they applied (their own answers).
				application: serializeApplicationForExport(
					applications.find((item) => item.hiredStaffId === row.id),
				),
				onboardingTasks: byStaff(tasks, row.id).map((task) => ({
					id: task.id,
					taskKey: task.taskKey,
					title: task.title,
					type: task.type,
					instructions: task.instructions,
					linkUrl: task.linkUrl,
					status: task.status,
					dueDate: task.dueDate,
					completedAt: task.completedAt,
					createdAt: task.createdAt,
					...(options.includeActors ? { completedBy: task.completedBy } : {}),
				})),
				certificates: byStaff(certificates, row.id).map((certificate) => ({
					id: certificate.id,
					kind: certificate.kind,
					label: certificate.label,
					issuedOn: certificate.issuedOn,
					expiresOn: certificate.expiresOn,
					note: certificate.note,
				})),
				notes: byStaff(notes, row.id)
					.filter((note) => note.deletedAt === null)
					.map((note) => ({
						id: note.id,
						body: note.body,
						createdAt: note.createdAt,
						...(options.includeActors ? { authorId: note.authorId } : {}),
					})),
				...(options.include.private
					? {
							private: own
								? {
										dateOfBirth: own.dateOfBirth,
										addressLine1: own.addressLine1,
										addressLine2: own.addressLine2,
										city: own.city,
										region: own.region,
										postalCode: own.postalCode,
										country: own.country,
										emergencyContactName: own.emergencyContactName,
										emergencyContactPhone: own.emergencyContactPhone,
										emergencyContactRelation: own.emergencyContactRelation,
									}
								: null,
						}
					: {}),
			}
		}),
		auditLog: auditRows.slice(0, EXPORT_AUDIT_LIMIT).map((row) => ({
			at: row.at,
			action: row.action,
			entityType: row.entityType,
			entityId: row.entityId,
			staffId: row.staffId,
			scopeId: row.scopeId,
			sensitivity: row.sensitivity,
			changes: row.changes,
			...(options.includeActors
				? {
						actorKind: row.actorKind,
						actorId: row.actorId,
						impersonated: row.impersonated,
					}
				: {}),
		})),
		auditLogTruncated: auditRows.length > EXPORT_AUDIT_LIMIT,
	}
}

function serializeApplicationForExport(
	row: typeof hiringApplications.$inferSelect | undefined,
) {
	if (!row) return null
	return {
		postingTitle: row.postingTitle,
		source: row.source,
		appliedAt: row.createdAt,
		consentAt: row.consentAt,
		consentVersion: row.consentVersion,
		answers: row.answers,
	}
}

export type StaffExport = Awaited<ReturnType<typeof buildStaffExport>>

/**
 * Operator-side export, reached browser-direct before a region switch or to
 * fulfil an access request for data that may not leave its region. Needs a token
 * that is not scope-limited (the file covers every scope). Pay and private
 * groups follow the token's grants. The audit row is written first: a failed
 * trail means no file.
 */
export async function exportForOperator(
	ctx: StaffContext,
	input: { staffId?: string },
): Promise<InternalResult<StaffExport>> {
	if (!ctx.scope.unrestricted) return fail(403, 'unrestricted_scope_required')
	if (input.staffId) {
		const [exists] = await ctx.db
			.select({ id: staffMembers.id })
			.from(staffMembers)
			.where(eq(staffMembers.id, input.staffId))
			.limit(1)
		if (!exists) return fail(404, 'Staff member not found')
	}
	const include = {
		pay: hasGrant(ctx.auth, 'read:staff_pay:any'),
		private: hasGrant(ctx.auth, 'read:staff_private:any'),
	}
	await writeStaffAudit(ctx.db, ctx.auth, ctx.ipHash, {
		action: 'staff.exported',
		entityType: 'staff',
		entityId: input.staffId ?? null,
		staffId: input.staffId ?? null,
		sensitivity: include.private ? 'private' : include.pay ? 'pay' : 'standard',
		changes: {
			scope: input.staffId ? 'one' : 'all',
			pay: include.pay,
			private: include.private,
		},
	})
	return ok(
		await buildStaffExport(
			ctx.db,
			{ staffId: input.staffId, include, includeActors: true },
			{ orgId: ctx.auth.orgId },
		),
	)
}

/**
 * A data subject's own copy, generated in the region that holds it. Refused on
 * a node that must not release its data to the US control plane: the caller of
 * an internal route is the US App, so a Saudi-region export is delivered
 * browser-direct by an operator (`GET /operator/staff/export`) instead.
 */
export async function exportSubject(
	db: TenantDatabase,
	input: { userId: string },
	meta: { orgId: string },
): Promise<InternalResult<{ export: StaffExport | null }>> {
	if (getNodeRegion() === 'ksa') {
		return fail(
			409,
			'export_requires_regional_delivery',
			'Data held in this region is exported in-region by an operator, not through the control plane',
		)
	}
	const [staff] = await db
		.select({ id: staffMembers.id })
		.from(staffMembers)
		.where(eq(staffMembers.userId, input.userId))
		.limit(1)
	if (!staff) return ok({ export: null })
	// The trail comes first: nothing is disclosed without an audit row.
	await writeSystemAudit(db, {
		action: 'staff.exported',
		entityType: 'staff',
		entityId: staff.id,
		staffId: staff.id,
		sensitivity: 'private',
		changes: { via: 'subject_access_request' },
	})
	const bundle = await buildStaffExport(
		db,
		{
			staffId: staff.id,
			include: { pay: true, private: true },
			includeActors: false,
		},
		meta,
	)
	return ok({ export: bundle })
}
