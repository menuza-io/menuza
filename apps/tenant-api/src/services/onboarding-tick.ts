import { and, asc, eq, inArray, lt, lte } from 'drizzle-orm'
import {
	addDays,
	certificateAlertStage,
	dedupeKeys,
	formatDate,
	localParts,
	managerOutboxKind,
	ONBOARDING_LIMITS,
	taskReminderStage,
} from '@repo/staffing'
import {
	onboardingTasks,
	staffCertificates,
	staffMembers,
} from '@repo/tenant-db'
import { type ScopeFacts } from '../lib/scope-context.ts'
import { type StaffDb } from './staff-audit.ts'
import { type QueuedMessage } from './staff-tick-service.ts'

/**
 * The onboarding half of the regional tick (flag `staffing.hiring`): reminders
 * for checklist tasks that are due or overdue, and alerts for certificates that
 * are about to expire or have expired.
 *
 * Nothing here leaves the region except what the manager-alert contract
 * allows. Each reminder is one outbox row per task (or certificate) and stage,
 * so the alert the App receives carries a scope id and a count and nothing
 * else: no name, no task title, no date.
 *
 * Idempotent: a stage is recorded on the row when its reminder is queued, and
 * the outbox dedupe key repeats the guarantee if two ticks race.
 *
 * "Today" is the person's own scope day, so a task due today reminds on the
 * morning of that day wherever the scope is. The query looks one UTC day
 * ahead and the exact stage is decided per scope.
 */

/** Most rows one pass reads, so a large backlog never holds a long query. */
export const ONBOARDING_TICK_BATCH = 500

const ACTIVE_STATUSES = ['invited', 'active', 'on_leave'] as const

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export type OnboardingTickInput = {
	db: StaffDb
	now: number
	getScope: (scopeId: string) => Promise<ScopeFacts | null>
	enqueue: (message: QueuedMessage) => Promise<boolean>
}

export type OnboardingTickResult = {
	queued: number
	tasks: number
	certificates: number
}

export async function runOnboardingTick(
	input: OnboardingTickInput,
): Promise<OnboardingTickResult> {
	const { db, now } = input
	const zones = new Map<string, string>()
	const todayAt = async (scopeId: string | null): Promise<string> => {
		const key = scopeId ?? ''
		let zone = zones.get(key)
		if (zone === undefined) {
			const facts = scopeId ? await input.getScope(scopeId) : null
			zone = facts?.timeZone ?? 'UTC'
			zones.set(key, zone)
		}
		const parts = localParts(now, zone)
		return formatDate(parts.year, parts.month, parts.day)
	}

	let tasksQueued = 0
	let certificatesQueued = 0
	const tomorrow = addDays(utcDate(now), 1)

	const dueTasks = await db
		.select({
			id: onboardingTasks.id,
			staffId: onboardingTasks.staffId,
			dueDate: onboardingTasks.dueDate,
			remindedStage: onboardingTasks.remindedStage,
			scopeId: staffMembers.primaryScopeId,
		})
		.from(onboardingTasks)
		.innerJoin(staffMembers, eq(staffMembers.id, onboardingTasks.staffId))
		.where(
			and(
				eq(onboardingTasks.status, 'todo'),
				lte(onboardingTasks.dueDate, tomorrow),
				lt(onboardingTasks.remindedStage, 2),
				inArray(staffMembers.status, [...ACTIVE_STATUSES]),
			),
		)
		.orderBy(asc(onboardingTasks.dueDate))
		.limit(ONBOARDING_TICK_BATCH)
	for (const task of dueTasks) {
		const today = await todayAt(task.scopeId)
		const stage = taskReminderStage(
			{ status: 'todo', dueDate: task.dueDate },
			today,
		)
		if (stage === 0 || stage <= task.remindedStage) continue
		const queued = await input.enqueue({
			kind: managerOutboxKind('onboarding_due'),
			staffId: task.staffId,
			scopeId: task.scopeId,
			dedupeKey: dedupeKeys.onboardingDue(task.id, stage, task.dueDate!),
			payload: { stage },
		})
		if (queued) tasksQueued++
		await db
			.update(onboardingTasks)
			.set({ remindedStage: stage })
			.where(
				and(
					eq(onboardingTasks.id, task.id),
					eq(onboardingTasks.status, 'todo'),
					lt(onboardingTasks.remindedStage, stage),
				),
			)
	}

	const horizon = addDays(
		utcDate(now),
		ONBOARDING_LIMITS.certificateWarnDays + 1,
	)
	const dueCertificates = await db
		.select({
			id: staffCertificates.id,
			staffId: staffCertificates.staffId,
			expiresOn: staffCertificates.expiresOn,
			alertStage: staffCertificates.alertStage,
			scopeId: staffMembers.primaryScopeId,
		})
		.from(staffCertificates)
		.innerJoin(staffMembers, eq(staffMembers.id, staffCertificates.staffId))
		.where(
			and(
				lte(staffCertificates.expiresOn, horizon),
				lt(staffCertificates.alertStage, 2),
				inArray(staffMembers.status, [...ACTIVE_STATUSES]),
			),
		)
		.orderBy(asc(staffCertificates.expiresOn))
		.limit(ONBOARDING_TICK_BATCH)
	for (const certificate of dueCertificates) {
		const today = await todayAt(certificate.scopeId)
		const stage = certificateAlertStage(certificate.expiresOn, today)
		if (stage === 0 || stage <= certificate.alertStage) continue
		const queued = await input.enqueue({
			kind: managerOutboxKind('certificate_expiring'),
			staffId: certificate.staffId,
			scopeId: certificate.scopeId,
			dedupeKey: dedupeKeys.certificateExpiring(
				certificate.id,
				stage,
				certificate.expiresOn!,
			),
			payload: { stage },
		})
		if (queued) certificatesQueued++
		await db
			.update(staffCertificates)
			.set({ alertStage: stage })
			.where(
				and(
					eq(staffCertificates.id, certificate.id),
					lt(staffCertificates.alertStage, stage),
				),
			)
	}

	return {
		queued: tasksQueued + certificatesQueued,
		tasks: tasksQueued,
		certificates: certificatesQueued,
	}
}
