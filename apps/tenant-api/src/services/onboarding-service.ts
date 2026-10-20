import {
	and,
	asc,
	count,
	desc,
	eq,
	inArray,
	isNull,
	ne,
	sql,
} from 'drizzle-orm'
import {
	addDays,
	builtinTaskType,
	checkTaskRules,
	dueDateFrom,
	ONBOARDING_DEFAULT_TASKS,
	ONBOARDING_LIMITS,
	type CertificateInput,
	type CertificateUpdate,
	type CertificateView,
	type OnboardingApply,
	type OnboardingSummaryEntry,
	type OnboardingTaskCreate,
	type OnboardingTaskUpdate,
	type OnboardingTaskView,
	type OnboardingTemplateInput,
	type OnboardingTemplateTaskView,
	type OnboardingTemplateView,
} from '@repo/staffing'
import {
	onboardingTasks,
	onboardingTemplates,
	onboardingTemplateTasks,
	staffCertificates,
	staffScopeAssignments,
	staffMembers,
	type OnboardingTaskRow,
	type OnboardingTemplateRow,
	type OnboardingTemplateTaskRow,
	type StaffCertificateRow,
	type StaffMember,
	type TenantDatabase,
	runTenantTransaction,
} from '@repo/tenant-db'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { type StaffDb, writeStaffAudit } from './staff-audit.ts'
import { type StaffContext } from './staff-service.ts'
import { inJsonList } from '../lib/chunked-in.ts'
import { insertRowsInChunks } from '../lib/chunked-in.ts'

/**
 * Onboarding checklists, their templates, and certificates with an expiry, all
 * reached by managers through `/operator/hiring/onboarding` and
 * `/operator/hiring/certificates` (token scope `hiring`).
 *
 * Rules every function here follows:
 * - A person is visible only inside the token's scope limit; outside it (or
 *   unknown) is the same 404, so a scoped manager cannot probe other scopes.
 * - Templates are organization-wide and hold no personal data, so any hiring
 *   reader may read them, but changing one needs a token that covers every
 *   scope (it changes what every scope's new hires get).
 * - Every change writes an audit row in the same transaction. Audit rows hold
 *   ids, codes and counts: never a task title, policy text, link or note.
 * - Nothing here stores a document, a tax form, a national id or a bank detail.
 *   Document upload needs in-region object storage (ADR 047) and is not offered.
 */

// ---------------------------------------------------------------------------
// Result plumbing
// ---------------------------------------------------------------------------

export type OnboardingFailure = {
	ok: false
	status: 400 | 403 | 404 | 409 | 422
	error: string
	message?: string
}
export type OnboardingResult<T> = { ok: true; value: T } | OnboardingFailure

const ok = <T>(value: T): OnboardingResult<T> => ({ ok: true, value })
const fail = (
	status: OnboardingFailure['status'],
	error: string,
	message?: string,
): OnboardingFailure => ({
	ok: false,
	status,
	error,
	...(message ? { message } : {}),
})

function write<T>(
	db: TenantDatabase,
	fn: (
		tx: Parameters<Parameters<TenantDatabase['transaction']>[0]>[0],
	) => Promise<T>,
): Promise<T> {
	return retryOnSqliteBusy(() => runTenantTransaction(db, fn))
}

/** Test seam: the clock. */
export const onboardingDeps = { now: () => Date.now() }

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

// ---------------------------------------------------------------------------
// Serializers: the only way rows leave this module
// ---------------------------------------------------------------------------

export function toTaskView(row: OnboardingTaskRow): OnboardingTaskView {
	return {
		id: row.id,
		staffId: row.staffId,
		taskKey: row.taskKey,
		title: row.title,
		type: row.type,
		instructions: row.instructions,
		linkUrl: row.linkUrl,
		assignee: row.assignee,
		assigneeUserId: row.assigneeUserId,
		templateId: row.templateId,
		status: row.status,
		dueDate: row.dueDate,
		sortOrder: row.sortOrder,
		source: row.source,
		completedAt: row.completedAt,
		completedBy: row.completedBy,
		createdAt: row.createdAt,
	}
}

function toTemplateTaskView(
	row: OnboardingTemplateTaskRow,
): OnboardingTemplateTaskView {
	return {
		id: row.id,
		type: row.type,
		title: row.title,
		instructions: row.instructions,
		linkUrl: row.linkUrl,
		dueInDays: row.dueInDays,
		assignee: row.assignee,
		assigneeUserId: row.assigneeUserId,
		sortOrder: row.sortOrder,
	}
}

function toTemplateView(
	row: OnboardingTemplateRow,
	tasks: OnboardingTemplateTaskRow[],
): OnboardingTemplateView {
	return {
		id: row.id,
		name: row.name,
		isDefault: row.isDefault,
		archivedAt: row.archivedAt,
		updatedAt: row.updatedAt,
		tasks: tasks
			.filter((task) => task.templateId === row.id)
			.sort((a, b) => a.sortOrder - b.sortOrder)
			.map(toTemplateTaskView),
	}
}

export function toCertificateView(row: StaffCertificateRow): CertificateView {
	return {
		id: row.id,
		staffId: row.staffId,
		kind: row.kind,
		label: row.label,
		issuedOn: row.issuedOn,
		expiresOn: row.expiresOn,
		note: row.note,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

async function loadVisibleStaff(
	db: StaffDb,
	ctx: Pick<StaffContext, 'scope'>,
	staffId: string,
): Promise<OnboardingResult<StaffMember>> {
	const [staff] = await db
		.select()
		.from(staffMembers)
		.where(eq(staffMembers.id, staffId))
		.limit(1)
	if (!staff) return fail(404, 'Staff member not found')
	if (!ctx.scope.unrestricted) {
		const rows = await db
			.select({ scopeId: staffScopeAssignments.scopeId })
			.from(staffScopeAssignments)
			.where(eq(staffScopeAssignments.staffId, staffId))
		if (!ctx.scope.allowsAny(rows.map((row) => row.scopeId))) {
			return fail(404, 'Staff member not found')
		}
	}
	return ok(staff)
}

function requireOrganizationScope(
	ctx: Pick<StaffContext, 'scope'>,
): OnboardingFailure | null {
	return ctx.scope.unrestricted
		? null
		: fail(403, 'unrestricted_scope_required')
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

async function loadTemplates(db: StaffDb, includeArchived: boolean) {
	const templates = await db
		.select()
		.from(onboardingTemplates)
		.where(includeArchived ? undefined : isNull(onboardingTemplates.archivedAt))
		.orderBy(desc(onboardingTemplates.isDefault), asc(onboardingTemplates.name))
	if (templates.length === 0) return []
	const tasks = await db
		.select()
		.from(onboardingTemplateTasks)
		.where(
			inJsonList(
				onboardingTemplateTasks.templateId,
				templates.map((row) => row.id),
			),
		)
	return templates.map((row) => toTemplateView(row, tasks))
}

export async function listTemplates(ctx: StaffContext) {
	return ok({ templates: await loadTemplates(ctx.db, false) })
}

function templateTaskValues(
	templateId: string,
	tasks: OnboardingTemplateInput['tasks'],
) {
	return tasks.map((task, index) => ({
		templateId,
		type: task.type,
		title: task.title,
		instructions: task.instructions,
		linkUrl: task.linkUrl,
		dueInDays: task.dueInDays,
		assignee: task.assignee,
		assigneeUserId: task.assigneeUserId,
		sortOrder: index,
	}))
}

async function clearOtherDefaults(
	tx: StaffDb,
	exceptId: string | null,
	now: number,
) {
	await tx
		.update(onboardingTemplates)
		.set({ isDefault: false, updatedAt: now })
		.where(
			and(
				eq(onboardingTemplates.isDefault, true),
				isNull(onboardingTemplates.archivedAt),
				exceptId ? ne(onboardingTemplates.id, exceptId) : undefined,
			),
		)
}

export async function createTemplate(
	ctx: StaffContext,
	input: OnboardingTemplateInput,
): Promise<OnboardingResult<{ template: OnboardingTemplateView }>> {
	const denied = requireOrganizationScope(ctx)
	if (denied) return denied
	const now = onboardingDeps.now()
	return write(ctx.db, async (tx) => {
		const [live] = await tx
			.select({ total: count() })
			.from(onboardingTemplates)
			.where(isNull(onboardingTemplates.archivedAt))
		if ((live?.total ?? 0) >= ONBOARDING_LIMITS.templates) {
			return fail(409, 'template_limit')
		}
		// The old default goes first: the partial unique index allows only one.
		if (input.isDefault) await clearOtherDefaults(tx, null, now)
		const [row] = await tx
			.insert(onboardingTemplates)
			.values({
				name: input.name,
				isDefault: input.isDefault,
				createdBy: ctx.auth.userId,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
		const template = row!
		const tasks = await insertRowsInChunks(
			onboardingTemplateTasks,
			templateTaskValues(template.id, input.tasks),
			(part) => tx.insert(onboardingTemplateTasks).values(part).returning(),
		)
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'onboarding.template.created',
			entityType: 'onboarding_template',
			entityId: template.id,
			changes: { tasks: tasks.length, isDefault: input.isDefault },
		})
		return ok({ template: toTemplateView(template, tasks) })
	})
}

export async function updateTemplate(
	ctx: StaffContext,
	id: string,
	input: OnboardingTemplateInput,
): Promise<OnboardingResult<{ template: OnboardingTemplateView }>> {
	const denied = requireOrganizationScope(ctx)
	if (denied) return denied
	const now = onboardingDeps.now()
	return write(ctx.db, async (tx) => {
		const [existing] = await tx
			.select()
			.from(onboardingTemplates)
			.where(
				and(
					eq(onboardingTemplates.id, id),
					isNull(onboardingTemplates.archivedAt),
				),
			)
			.limit(1)
		if (!existing) return fail(404, 'Template not found')
		// The old default is cleared first: the partial unique index allows one.
		if (input.isDefault) await clearOtherDefaults(tx, id, now)
		const [row] = await tx
			.update(onboardingTemplates)
			.set({ name: input.name, isDefault: input.isDefault, updatedAt: now })
			.where(eq(onboardingTemplates.id, id))
			.returning()
		await tx
			.delete(onboardingTemplateTasks)
			.where(eq(onboardingTemplateTasks.templateId, id))
		const tasks = await insertRowsInChunks(
			onboardingTemplateTasks,
			templateTaskValues(id, input.tasks),
			(part) => tx.insert(onboardingTemplateTasks).values(part).returning(),
		)
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'onboarding.template.updated',
			entityType: 'onboarding_template',
			entityId: id,
			changes: { tasks: tasks.length, isDefault: input.isDefault },
		})
		return ok({ template: toTemplateView(row!, tasks) })
	})
}

/**
 * Archiving keeps checklists already copied from the template exactly as they
 * are (they were copies); the template just stops being offered or attached.
 */
export async function archiveTemplate(
	ctx: StaffContext,
	id: string,
): Promise<OnboardingResult<{ archived: true }>> {
	const denied = requireOrganizationScope(ctx)
	if (denied) return denied
	const now = onboardingDeps.now()
	return write(ctx.db, async (tx) => {
		const updated = await tx
			.update(onboardingTemplates)
			.set({ archivedAt: now, isDefault: false, updatedAt: now })
			.where(
				and(
					eq(onboardingTemplates.id, id),
					isNull(onboardingTemplates.archivedAt),
				),
			)
			.returning({ id: onboardingTemplates.id })
		if (updated.length === 0) return fail(404, 'Template not found')
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'onboarding.template.archived',
			entityType: 'onboarding_template',
			entityId: id,
		})
		return ok({ archived: true as const })
	})
}

// ---------------------------------------------------------------------------
// Attaching a checklist (hire and "apply template")
// ---------------------------------------------------------------------------

export type ChecklistSource =
	| {
			kind: 'template'
			template: OnboardingTemplateRow
			tasks: OnboardingTemplateTaskRow[]
	  }
	| { kind: 'builtin' }

/**
 * Chooses what to copy: the template asked for (it must be live), else the live
 * default template, else the built-in starter list. Resolved before anything is
 * written so a caller can refuse cleanly.
 */
export async function resolveChecklistSource(
	db: StaffDb,
	templateId: string | undefined,
): Promise<OnboardingResult<ChecklistSource>> {
	const [template] = await db
		.select()
		.from(onboardingTemplates)
		.where(
			templateId
				? and(
						eq(onboardingTemplates.id, templateId),
						isNull(onboardingTemplates.archivedAt),
					)
				: and(
						eq(onboardingTemplates.isDefault, true),
						isNull(onboardingTemplates.archivedAt),
					),
		)
		.limit(1)
	if (!template) {
		return templateId
			? fail(404, 'Template not found')
			: ok({ kind: 'builtin' as const })
	}
	const tasks = await db
		.select()
		.from(onboardingTemplateTasks)
		.where(eq(onboardingTemplateTasks.templateId, template.id))
		.orderBy(asc(onboardingTemplateTasks.sortOrder))
	return ok({ kind: 'template' as const, template, tasks })
}

/** Rows to insert for one person. Pure: no I/O. */
export function checklistRows(
	source: ChecklistSource,
	input: {
		staffId: string
		baseDate: string
		now: number
		origin: 'hire' | 'template'
		startOrder: number
	},
): Array<typeof onboardingTasks.$inferInsert> {
	const common = {
		staffId: input.staffId,
		status: 'todo' as const,
		source: input.origin,
		createdAt: input.now,
	}
	if (source.kind === 'builtin') {
		return ONBOARDING_DEFAULT_TASKS.map((task, index) => ({
			...common,
			taskKey: task.key,
			type: builtinTaskType(task.key),
			dueDate: addDays(input.baseDate, task.dueInDays),
			sortOrder: input.startOrder + index,
		}))
	}
	return source.tasks.map((task, index) => ({
		...common,
		templateId: source.template.id,
		type: task.type,
		title: task.title,
		instructions: task.instructions,
		linkUrl: task.linkUrl,
		assignee: task.assignee,
		assigneeUserId: task.assigneeUserId,
		dueDate: dueDateFrom(input.baseDate, task.dueInDays),
		sortOrder: input.startOrder + index,
	}))
}

/** Inserts the checklist and returns how many tasks it created. */
export async function insertChecklist(
	tx: StaffDb,
	source: ChecklistSource,
	input: {
		staffId: string
		baseDate: string
		now: number
		origin: 'hire' | 'template'
		startOrder?: number
	},
): Promise<number> {
	const rows = checklistRows(source, {
		...input,
		startOrder: input.startOrder ?? 0,
	})
	if (rows.length === 0) return 0
	await insertRowsInChunks(onboardingTasks, rows, (part) =>
		tx.insert(onboardingTasks).values(part),
	)
	return rows.length
}

// ---------------------------------------------------------------------------
// One person's checklist
// ---------------------------------------------------------------------------

async function tasksFor(db: StaffDb, staffId: string) {
	return db
		.select()
		.from(onboardingTasks)
		.where(eq(onboardingTasks.staffId, staffId))
		.orderBy(asc(onboardingTasks.sortOrder), asc(onboardingTasks.createdAt))
}

export async function getChecklist(
	ctx: StaffContext,
	staffId: string,
): Promise<OnboardingResult<{ tasks: OnboardingTaskView[] }>> {
	const staff = await loadVisibleStaff(ctx.db, ctx, staffId)
	if (!staff.ok) return staff
	return ok({ tasks: (await tasksFor(ctx.db, staffId)).map(toTaskView) })
}

/** Roster progress: counts and the earliest open due date, never titles. */
export async function summarizeChecklists(
	ctx: StaffContext,
	staffIds: readonly string[] | undefined,
): Promise<OnboardingResult<{ entries: OnboardingSummaryEntry[] }>> {
	const visible = ctx.scope.where(staffScopeAssignments.scopeId)
	const conditions = [ne(staffMembers.status, 'terminated')]
	if (staffIds && staffIds.length > 0) {
		conditions.push(inJsonList(onboardingTasks.staffId, [...staffIds]))
	}
	if (visible) {
		conditions.push(
			// bounded: a subquery, never bound values
			inArray(
				onboardingTasks.staffId,
				ctx.db
					.select({ id: staffScopeAssignments.staffId })
					.from(staffScopeAssignments)
					.where(visible),
			),
		)
	}
	const rows = await ctx.db
		.select({
			staffId: onboardingTasks.staffId,
			total: count(),
			complete: sql<number>`sum(case when ${onboardingTasks.status} <> 'todo' then 1 else 0 end)`,
			nextDueDate: sql<
				string | null
			>`min(case when ${onboardingTasks.status} = 'todo' then ${onboardingTasks.dueDate} end)`,
		})
		.from(onboardingTasks)
		.innerJoin(staffMembers, eq(staffMembers.id, onboardingTasks.staffId))
		.where(and(...conditions))
		.groupBy(onboardingTasks.staffId)
		.limit(1_000)
	return ok({
		entries: rows.map((row) => ({
			staffId: row.staffId,
			total: Number(row.total),
			complete: Number(row.complete ?? 0),
			nextDueDate: row.nextDueDate ?? null,
		})),
	})
}

export async function addTask(
	ctx: StaffContext,
	staffId: string,
	input: OnboardingTaskCreate,
): Promise<OnboardingResult<{ task: OnboardingTaskView }>> {
	const now = onboardingDeps.now()
	return write(ctx.db, async (tx) => {
		const staff = await loadVisibleStaff(tx, ctx, staffId)
		if (!staff.ok) return staff
		if (staff.value.status === 'terminated')
			return fail(409, 'staff_terminated')
		const [existing] = await tx
			.select({
				total: count(),
				last: sql<number | null>`max(${onboardingTasks.sortOrder})`,
			})
			.from(onboardingTasks)
			.where(eq(onboardingTasks.staffId, staffId))
		if ((existing?.total ?? 0) >= ONBOARDING_LIMITS.tasksPerPerson) {
			return fail(409, 'task_limit')
		}
		const [row] = await tx
			.insert(onboardingTasks)
			.values({
				staffId,
				type: input.type,
				title: input.title,
				instructions: input.instructions,
				linkUrl: input.linkUrl,
				assignee: input.assignee,
				assigneeUserId: input.assigneeUserId,
				dueDate: input.dueDate,
				sortOrder: (existing?.last ?? -1) + 1,
				source: 'manual',
				createdAt: now,
			})
			.returning()
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'onboarding.task.added',
			entityType: 'onboarding_task',
			entityId: row!.id,
			staffId,
			scopeId: staff.value.primaryScopeId,
			changes: { type: input.type },
		})
		return ok({ task: toTaskView(row!) })
	})
}

export async function updateTask(
	ctx: StaffContext,
	staffId: string,
	taskId: string,
	input: OnboardingTaskUpdate,
): Promise<OnboardingResult<{ task: OnboardingTaskView }>> {
	const now = onboardingDeps.now()
	return write(ctx.db, async (tx) => {
		const staff = await loadVisibleStaff(tx, ctx, staffId)
		if (!staff.ok) return staff
		const [task] = await tx
			.select()
			.from(onboardingTasks)
			.where(
				and(
					eq(onboardingTasks.id, taskId),
					eq(onboardingTasks.staffId, staffId),
				),
			)
			.limit(1)
		if (!task) return fail(404, 'Task not found')

		// The merged task must still satisfy the cross-field rules (a form task
		// keeps its link, a member assignee keeps its member).
		const merged = {
			type: task.type,
			instructions:
				input.instructions !== undefined
					? input.instructions
					: task.instructions,
			linkUrl: input.linkUrl !== undefined ? input.linkUrl : task.linkUrl,
			assignee: input.assignee ?? task.assignee,
			assigneeUserId:
				input.assigneeUserId !== undefined
					? input.assigneeUserId
					: input.assignee && input.assignee !== 'member'
						? null
						: task.assigneeUserId,
		}
		const problem = checkTaskRules(merged)
		if (problem) return fail(422, problem[1], problem[0])

		const patch: Partial<typeof onboardingTasks.$inferInsert> = {}
		if (input.title !== undefined) patch.title = input.title
		if (input.instructions !== undefined)
			patch.instructions = merged.instructions
		if (input.linkUrl !== undefined) patch.linkUrl = merged.linkUrl
		if (input.assignee !== undefined || input.assigneeUserId !== undefined) {
			patch.assignee = merged.assignee
			patch.assigneeUserId = merged.assigneeUserId
		}
		if (input.dueDate !== undefined) {
			patch.dueDate = input.dueDate
			// A moved date reminds again on its new day.
			if (input.dueDate !== task.dueDate) patch.remindedStage = 0
		}
		const statusChanged =
			input.status !== undefined && input.status !== task.status
		if (statusChanged) {
			patch.status = input.status
			patch.completedAt = input.status === 'todo' ? null : now
			patch.completedBy = input.status === 'todo' ? null : ctx.auth.userId
			// Reopening a task starts its reminders over.
			if (input.status === 'todo') patch.remindedStage = 0
		}
		const [row] =
			Object.keys(patch).length > 0
				? await tx
						.update(onboardingTasks)
						.set(patch)
						.where(eq(onboardingTasks.id, taskId))
						.returning()
				: [task]
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'onboarding.task.updated',
			entityType: 'onboarding_task',
			entityId: taskId,
			staffId,
			scopeId: staff.value.primaryScopeId,
			changes: {
				fields: Object.keys(input),
				...(statusChanged ? { from: task.status, to: input.status } : {}),
			},
		})
		return ok({ task: toTaskView(row!) })
	})
}

export async function removeTask(
	ctx: StaffContext,
	staffId: string,
	taskId: string,
): Promise<OnboardingResult<{ removed: true }>> {
	return write(ctx.db, async (tx) => {
		const staff = await loadVisibleStaff(tx, ctx, staffId)
		if (!staff.ok) return staff
		const removed = await tx
			.delete(onboardingTasks)
			.where(
				and(
					eq(onboardingTasks.id, taskId),
					eq(onboardingTasks.staffId, staffId),
				),
			)
			.returning({ id: onboardingTasks.id })
		if (removed.length === 0) return fail(404, 'Task not found')
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'onboarding.task.removed',
			entityType: 'onboarding_task',
			entityId: taskId,
			staffId,
			scopeId: staff.value.primaryScopeId,
		})
		return ok({ removed: true as const })
	})
}

/**
 * Copies a template (or the default, or the built-in list) onto an existing
 * person. Refused when the same template was already copied to them, so a
 * double click does not double the list.
 */
export async function applyChecklist(
	ctx: StaffContext,
	staffId: string,
	input: OnboardingApply,
): Promise<OnboardingResult<{ tasks: OnboardingTaskView[]; created: number }>> {
	const now = onboardingDeps.now()
	return write(ctx.db, async (tx) => {
		const staff = await loadVisibleStaff(tx, ctx, staffId)
		if (!staff.ok) return staff
		if (staff.value.status === 'terminated')
			return fail(409, 'staff_terminated')
		const source = await resolveChecklistSource(tx, input.templateId)
		if (!source.ok) return source

		const existing = await tasksFor(tx, staffId)
		const chosen = source.value
		const already =
			chosen.kind === 'template'
				? existing.some((task) => task.templateId === chosen.template.id)
				: existing.some(
						(task) =>
							task.taskKey !== null &&
							ONBOARDING_DEFAULT_TASKS.some(
								(builtin) => builtin.key === task.taskKey,
							),
					)
		if (already) return fail(409, 'template_already_applied')
		const baseDate = input.baseDate ?? staff.value.hiredDate ?? utcDate(now)
		const incoming = checklistRows(source.value, {
			staffId,
			baseDate,
			now,
			origin: 'template',
			startOrder: 0,
		}).length
		if (existing.length + incoming > ONBOARDING_LIMITS.tasksPerPerson) {
			return fail(409, 'task_limit')
		}
		const created = await insertChecklist(tx, source.value, {
			staffId,
			baseDate,
			now,
			origin: 'template',
			startOrder: (existing.at(-1)?.sortOrder ?? -1) + 1,
		})
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'onboarding.checklist.applied',
			entityType: 'staff',
			entityId: staffId,
			staffId,
			scopeId: staff.value.primaryScopeId,
			changes: {
				templateId:
					source.value.kind === 'template' ? source.value.template.id : null,
				created,
			},
		})
		return ok({ tasks: (await tasksFor(tx, staffId)).map(toTaskView), created })
	})
}

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

export async function listCertificates(
	ctx: StaffContext,
	staffId: string,
): Promise<OnboardingResult<{ certificates: CertificateView[] }>> {
	const staff = await loadVisibleStaff(ctx.db, ctx, staffId)
	if (!staff.ok) return staff
	const rows = await ctx.db
		.select()
		.from(staffCertificates)
		.where(eq(staffCertificates.staffId, staffId))
		.orderBy(asc(staffCertificates.expiresOn), asc(staffCertificates.createdAt))
	return ok({ certificates: rows.map(toCertificateView) })
}

export async function addCertificate(
	ctx: StaffContext,
	staffId: string,
	input: CertificateInput,
): Promise<OnboardingResult<{ certificate: CertificateView }>> {
	const now = onboardingDeps.now()
	return write(ctx.db, async (tx) => {
		const staff = await loadVisibleStaff(tx, ctx, staffId)
		if (!staff.ok) return staff
		const [existing] = await tx
			.select({ total: count() })
			.from(staffCertificates)
			.where(eq(staffCertificates.staffId, staffId))
		if ((existing?.total ?? 0) >= ONBOARDING_LIMITS.certificatesPerPerson) {
			return fail(409, 'certificate_limit')
		}
		const [row] = await tx
			.insert(staffCertificates)
			.values({
				staffId,
				kind: input.kind,
				label: input.label,
				issuedOn: input.issuedOn,
				expiresOn: input.expiresOn,
				note: input.note,
				createdBy: ctx.auth.userId,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'staff.certificate.added',
			entityType: 'certificate',
			entityId: row!.id,
			staffId,
			scopeId: staff.value.primaryScopeId,
			changes: { kind: input.kind, hasExpiry: input.expiresOn !== null },
		})
		return ok({ certificate: toCertificateView(row!) })
	})
}

export async function updateCertificate(
	ctx: StaffContext,
	staffId: string,
	certificateId: string,
	input: CertificateUpdate,
): Promise<OnboardingResult<{ certificate: CertificateView }>> {
	const now = onboardingDeps.now()
	return write(ctx.db, async (tx) => {
		const staff = await loadVisibleStaff(tx, ctx, staffId)
		if (!staff.ok) return staff
		const [row] = await tx
			.select()
			.from(staffCertificates)
			.where(
				and(
					eq(staffCertificates.id, certificateId),
					eq(staffCertificates.staffId, staffId),
				),
			)
			.limit(1)
		if (!row) return fail(404, 'Certificate not found')

		const next = {
			kind: input.kind ?? row.kind,
			label: input.label !== undefined ? input.label : row.label,
			issuedOn: input.issuedOn !== undefined ? input.issuedOn : row.issuedOn,
			expiresOn:
				input.expiresOn !== undefined ? input.expiresOn : row.expiresOn,
			note: input.note !== undefined ? input.note : row.note,
		}
		if (next.kind === 'other' && !next.label) {
			return fail(422, 'label_required', 'label')
		}
		if (next.issuedOn && next.expiresOn && next.expiresOn < next.issuedOn) {
			return fail(422, 'expires_before_issued', 'expiresOn')
		}
		const [updated] = await tx
			.update(staffCertificates)
			.set({
				...next,
				// A new expiry date starts the alerts over (a renewed card).
				alertStage: next.expiresOn === row.expiresOn ? row.alertStage : 0,
				updatedAt: now,
			})
			.where(eq(staffCertificates.id, certificateId))
			.returning()
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'staff.certificate.updated',
			entityType: 'certificate',
			entityId: certificateId,
			staffId,
			scopeId: staff.value.primaryScopeId,
			changes: { fields: Object.keys(input) },
		})
		return ok({ certificate: toCertificateView(updated!) })
	})
}

export async function removeCertificate(
	ctx: StaffContext,
	staffId: string,
	certificateId: string,
): Promise<OnboardingResult<{ removed: true }>> {
	return write(ctx.db, async (tx) => {
		const staff = await loadVisibleStaff(tx, ctx, staffId)
		if (!staff.ok) return staff
		const removed = await tx
			.delete(staffCertificates)
			.where(
				and(
					eq(staffCertificates.id, certificateId),
					eq(staffCertificates.staffId, staffId),
				),
			)
			.returning({ id: staffCertificates.id })
		if (removed.length === 0) return fail(404, 'Certificate not found')
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'staff.certificate.removed',
			entityType: 'certificate',
			entityId: certificateId,
			staffId,
			scopeId: staff.value.primaryScopeId,
		})
		return ok({ removed: true as const })
	})
}
