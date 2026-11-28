import { AuditAction, auditService } from '@repo/audit'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	SETUP_REMINDER_WORKFLOW,
	SETUP_REMINDERS_FLAG,
	TEST_ACCOUNT_FLAG,
	setupReminderCopy,
	setupReminderLocale,
	type SetupReminderCopy,
} from '@repo/common/setup-reminders'
import {
	and,
	db,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	lt,
	max,
	not,
	exists,
	NotificationPreference,
	OnboardingStepProgress,
	Organization,
	OrganizationLocation,
	OrganizationRole,
	or,
	SetupReminder,
	SetupReminderState,
	sql,
	User,
	UserOrganization,
} from '@repo/database'
import { sendEmail, SetupReminderEmail } from '@repo/email'
import { createElement } from 'react'
import { ENV } from 'varlock/env'
import { orgDefaultLocale } from '#app/utils/location-name.server.ts'
import { recordOrganizationEvent } from '#app/utils/organization-events.server.ts'
import { reportUnsubscribeUrl } from '#app/utils/reports/report-unsubscribe.server.ts'
import { isLaunchChecklistOn, loadLaunchChecklist } from './launch.server.ts'
import {
	nextReminderDue,
	pickReminderTarget,
	progressSignature,
	type ReminderTarget,
} from './setup-reminders.ts'

/**
 * Setup reminders (#271). A daily job (the existing 03:00 slot) emails the
 * owner of an organization that is not live about its single next unfinished
 * launch step, 1, 3 and 7 days after the last progress, then stops. Progress
 * resets the sequence. Never sent to test organizations, cancelled accounts or
 * organizations that are live; owners can turn them off from the email or in
 * Notification settings. Admin can send one by hand (once a day per
 * organization) and sees the history. No guest data is read: the checklist is
 * evaluated from control-plane facts only (no regional call).
 */

export type ReminderDeps = {
	now: () => Date
	sendEmail: typeof sendEmail
}
const defaultDeps: ReminderDeps = { now: () => new Date(), sendEmail }

/** Subscription states that mean the account is cancelled. */
const ENDED_STATUSES = ['canceled', 'unpaid', 'incomplete_expired']
const DAY_MS = 86_400_000
/** One manual reminder per organization per day. */
export const MANUAL_REMINDER_INTERVAL_MS = DAY_MS
/** Only organizations signed up within this many days are looked at. */
const MAX_ORGANIZATION_AGE_DAYS = 120
const MAX_ORGANIZATIONS_PER_RUN = 500
const MAX_RECIPIENTS = 5

export type ReminderExclusion = 'inactive' | 'cancelled' | 'test'

export type ReminderRecipient = { userId: string; email: string }

type ReminderOrganization = {
	id: string
	slug: string
	name: string
	createdAt: Date
	active: boolean
	subscriptionStatus: string | null
}

async function loadOrganization(
	organizationId: string,
): Promise<ReminderOrganization | null> {
	const [row] = await db
		.select({
			id: Organization.id,
			slug: Organization.slug,
			name: Organization.name,
			createdAt: Organization.createdAt,
			active: Organization.active,
			subscriptionStatus: Organization.subscriptionStatus,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return row ?? null
}

/** Why an organization is never emailed, or null when it may be. */
export async function reminderExclusion(
	organization: Pick<
		ReminderOrganization,
		'id' | 'active' | 'subscriptionStatus'
	>,
): Promise<ReminderExclusion | null> {
	if (!organization.active) return 'inactive'
	if (
		organization.subscriptionStatus &&
		ENDED_STATUSES.includes(organization.subscriptionStatus)
	) {
		return 'cancelled'
	}
	// A test or demo account is marked with the organization flag `account.test`
	// (set in Admin, Feature flags). Only a literal `true` counts.
	if (
		(await getFeatureFlag(TEST_ACCOUNT_FLAG, {
			organizationId: organization.id,
		})) === true
	) {
		return 'test'
	}
	return null
}

/**
 * The owners who can receive the reminder: active owners (the built-in admin
 * role) with an address, not banned, and who have not turned reminders off.
 * A sign-in needs a verified address, so every stored address is verified.
 */
export async function resolveReminderRecipients(
	organizationId: string,
	now: Date,
): Promise<ReminderRecipient[]> {
	const rows = await db
		.select({
			userId: UserOrganization.userId,
			email: User.email,
			bannedAt: User.bannedAt,
			banExpiresAt: User.banExpiresAt,
		})
		.from(UserOrganization)
		.innerJoin(User, eq(User.id, UserOrganization.userId))
		.innerJoin(
			OrganizationRole,
			eq(OrganizationRole.id, UserOrganization.organizationRoleId),
		)
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
				eq(OrganizationRole.name, 'admin'),
				isNull(OrganizationRole.organizationId),
			),
		)
	const candidates: ReminderRecipient[] = []
	const seen = new Set<string>()
	for (const row of rows.sort((a, b) => a.userId.localeCompare(b.userId))) {
		if (seen.has(row.userId) || !row.email) continue
		if (
			row.bannedAt !== null &&
			(row.banExpiresAt === null || row.banExpiresAt > now)
		) {
			continue
		}
		seen.add(row.userId)
		candidates.push({ userId: row.userId, email: row.email })
		if (candidates.length >= MAX_RECIPIENTS) break
	}
	if (candidates.length === 0) return []
	const optedOut = await db
		.select({ userId: NotificationPreference.userId })
		.from(NotificationPreference)
		.where(
			and(
				eq(NotificationPreference.organizationId, organizationId),
				eq(NotificationPreference.workflow, SETUP_REMINDER_WORKFLOW),
				eq(NotificationPreference.email, false),
				inArray(
					NotificationPreference.userId,
					candidates.map((candidate) => candidate.userId),
				),
			),
		)
	const off = new Set(optedOut.map((row) => row.userId))
	return candidates.filter((candidate) => !off.has(candidate.userId))
}

export type ReminderEvaluation =
	| { status: 'excluded'; reason: ReminderExclusion }
	| { status: 'checklist_off' }
	| { status: 'live' }
	| { status: 'nothing_to_remind' }
	| {
			status: 'ok'
			organization: ReminderOrganization
			target: Extract<ReminderTarget, { kind: 'step' }>
			signature: string
			locale: 'en' | 'ar'
	  }

/**
 * What a reminder would say right now for an organization: its next step and
 * progress, from the launch checklist (control-plane facts only). Reads, and
 * writes nothing but the checklist's own bookkeeping.
 */
export async function evaluateSetupReminder(
	organizationId: string,
	now: Date,
): Promise<ReminderEvaluation> {
	const organization = await loadOrganization(organizationId)
	if (!organization) return { status: 'nothing_to_remind' }
	const exclusion = await reminderExclusion(organization)
	if (exclusion) return { status: 'excluded', reason: exclusion }
	if (!(await isLaunchChecklistOn(organizationId))) {
		return { status: 'checklist_off' }
	}
	// A location that was ever live makes the organization live: never nagged.
	const [everLive] = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organizationId),
				sql`${OrganizationLocation.liveAt} is not null`,
			),
		)
		.limit(1)
	if (everLive) return { status: 'live' }
	// No regional call: the optional steps that need one are never nagged about.
	const checklist = await loadLaunchChecklist({
		organizationId,
		userId: null,
		now,
		facts: null,
	})
	const target = pickReminderTarget(checklist)
	if (target.kind === 'live') return { status: 'live' }
	if (target.kind === 'none') return { status: 'nothing_to_remind' }
	return {
		status: 'ok',
		organization,
		target,
		signature: progressSignature(target),
		locale: setupReminderLocale(await orgDefaultLocale(organizationId)),
	}
}

function absoluteUrl(path: string) {
	return `${String(ENV.BASE_URL ?? '').replace(/\/$/, '')}${path}`
}

export type BuiltReminder = {
	copy: SetupReminderCopy
	actionUrl: string
	stepKey: string
}

export function buildReminderCopy(
	evaluation: Extract<ReminderEvaluation, { status: 'ok' }>,
): BuiltReminder {
	const { organization, target, locale } = evaluation
	return {
		copy: setupReminderCopy({
			locale,
			organizationName: organization.name,
			stepKey: target.stepKey,
			done: target.done,
			total: target.total,
		}),
		actionUrl: absoluteUrl(`/${organization.slug}${target.href}`),
		stepKey: target.stepKey,
	}
}

async function deliver(
	deps: ReminderDeps,
	evaluation: Extract<ReminderEvaluation, { status: 'ok' }>,
	recipients: ReminderRecipient[],
): Promise<number> {
	const built = buildReminderCopy(evaluation)
	let sent = 0
	for (const recipient of recipients) {
		try {
			const result = await deps.sendEmail({
				to: recipient.email,
				subject: built.copy.subject,
				react: createElement(SetupReminderEmail, {
					lang: built.copy.locale,
					dir: built.copy.dir,
					preview: built.copy.preview,
					eyebrow: built.copy.eyebrow,
					heading: built.copy.heading,
					intro: built.copy.intro,
					progress: built.copy.progress,
					actionLabel: built.copy.actionLabel,
					actionUrl: built.actionUrl,
					unsubscribeLabel: built.copy.unsubscribeLabel,
					unsubscribeUrl: reportUnsubscribeUrl({
						kind: 'setup',
						organizationId: evaluation.organization.id,
						userId: recipient.userId,
					}),
					footer: built.copy.footer,
				}),
			})
			if (result.status !== 'error') sent++
		} catch {
			// One failed address never stops the others.
		}
	}
	return sent
}

async function logReminder(input: {
	evaluation: Extract<ReminderEvaluation, { status: 'ok' }>
	kind: 'auto' | 'manual'
	day: number | null
	recipientCount: number
	sentById?: string
	now: Date
}) {
	await db.insert(SetupReminder).values({
		organizationId: input.evaluation.organization.id,
		kind: input.kind,
		day: input.day,
		stepKey: input.evaluation.target.stepKey,
		doneCount: input.evaluation.target.done,
		totalCount: input.evaluation.target.total,
		recipientCount: input.recipientCount,
		sentById: input.sentById ?? null,
		sentAt: input.now,
	})
	// On the Admin Timeline (#279): the kind only.
	await recordOrganizationEvent({
		organizationId: input.evaluation.organization.id,
		kind: 'reminder_sent',
		payload: {
			reminderKind: input.kind === 'auto' ? 'setup_auto' : 'setup_manual',
		},
		dedupeKey: `setup-reminder:${input.evaluation.organization.id}:${input.now.getTime()}`,
		at: input.now,
	})
}

/** When the organization last made progress: sign-up, or its last step done. */
async function firstProgressAt(
	organization: Pick<ReminderOrganization, 'id' | 'createdAt'>,
): Promise<Date> {
	const [row] = await db
		.select({ at: max(OnboardingStepProgress.completedAt) })
		.from(OnboardingStepProgress)
		.where(eq(OnboardingStepProgress.organizationId, organization.id))
	const at = row?.at ? new Date(row.at) : null
	return at && at > organization.createdAt ? at : organization.createdAt
}

export type SetupReminderRunResult = {
	checked: number
	sent: number
	skipped: number
	reset: number
	excluded: number
}

/**
 * One organization's turn in the daily run. Returns what happened.
 */
async function runForOrganization(
	organizationId: string,
	deps: ReminderDeps,
): Promise<'sent' | 'skipped' | 'reset' | 'excluded' | 'waiting' | 'nobody'> {
	const now = deps.now()
	const organization = await loadOrganization(organizationId)
	if (!organization) return 'excluded'
	// The automatic sequence is behind the organization flag `launch.reminders`
	// (default off, only a literal `true`).
	if (
		(await getFeatureFlag(SETUP_REMINDERS_FLAG, { organizationId })) !== true
	) {
		return 'excluded'
	}
	const evaluation = await evaluateSetupReminder(organizationId, now)
	if (evaluation.status !== 'ok') return 'excluded'

	const [state] = await db
		.select()
		.from(SetupReminderState)
		.where(eq(SetupReminderState.organizationId, organizationId))
		.limit(1)
	if (!state) {
		await db
			.insert(SetupReminderState)
			.values({
				organizationId,
				progressSignature: evaluation.signature,
				progressAt: await firstProgressAt(organization),
				lastAutoDay: 0,
			})
			.onConflictDoNothing()
		const [created] = await db
			.select()
			.from(SetupReminderState)
			.where(eq(SetupReminderState.organizationId, organizationId))
			.limit(1)
		if (!created) return 'waiting'
		return decideAndSend(created, evaluation, deps, now)
	}
	if (state.progressSignature !== evaluation.signature) {
		// Progress (a step done, or undone): the sequence starts again from now.
		await db
			.update(SetupReminderState)
			.set({
				progressSignature: evaluation.signature,
				progressAt: now,
				lastAutoDay: 0,
			})
			.where(eq(SetupReminderState.organizationId, organizationId))
		return 'reset'
	}
	return decideAndSend(state, evaluation, deps, now)
}

async function decideAndSend(
	state: typeof SetupReminderState.$inferSelect,
	evaluation: Extract<ReminderEvaluation, { status: 'ok' }>,
	deps: ReminderDeps,
	now: Date,
): Promise<'sent' | 'skipped' | 'waiting' | 'nobody'> {
	const due = nextReminderDue({
		progressAt: state.progressAt,
		now,
		lastAutoDay: state.lastAutoDay,
	})
	if (!due) return 'waiting'
	// Claim the day with one compare-and-set UPDATE: two runs at once, or a retried
	// run, can never send the same reminder twice.
	const claimed = await db
		.update(SetupReminderState)
		.set({ lastAutoDay: due.day })
		.where(
			and(
				eq(SetupReminderState.organizationId, state.organizationId),
				eq(SetupReminderState.progressSignature, state.progressSignature),
				lt(SetupReminderState.lastAutoDay, due.day),
			),
		)
		.returning({ id: SetupReminderState.organizationId })
	if (claimed.length === 0) return 'waiting'
	if (!due.send) return 'skipped'
	const recipients = await resolveReminderRecipients(
		evaluation.organization.id,
		now,
	)
	if (recipients.length === 0) return 'nobody'
	const sent = await deliver(deps, evaluation, recipients)
	if (sent === 0) {
		// Nothing went out (the provider failed): give the day back so the next run
		// tries again while it is still inside the window.
		await db
			.update(SetupReminderState)
			.set({ lastAutoDay: state.lastAutoDay })
			.where(eq(SetupReminderState.organizationId, state.organizationId))
		return 'waiting'
	}
	await logReminder({
		evaluation,
		kind: 'auto',
		day: due.day,
		recipientCount: sent,
		now,
	})
	return 'sent'
}

/**
 * The daily run: every organization that is not live and was set up recently
 * enough gets its turn in the sequence. Idempotent, bounded, and one
 * organization failing never stops the rest.
 */
export async function runSetupReminders(
	deps: ReminderDeps = defaultDeps,
): Promise<SetupReminderRunResult> {
	const now = deps.now()
	const since = new Date(now.getTime() - MAX_ORGANIZATION_AGE_DAYS * DAY_MS)
	const candidates = await db
		.select({ id: Organization.id })
		.from(Organization)
		.leftJoin(
			SetupReminderState,
			eq(SetupReminderState.organizationId, Organization.id),
		)
		.where(
			and(
				eq(Organization.active, true),
				gte(Organization.createdAt, since),
				or(
					isNull(Organization.subscriptionStatus),
					sql`${Organization.subscriptionStatus} not in ('canceled', 'unpaid', 'incomplete_expired')`,
				),
				// Never an organization with a live location.
				not(
					exists(
						db
							.select({ one: sql`1` })
							.from(OrganizationLocation)
							.where(
								and(
									eq(OrganizationLocation.organizationId, Organization.id),
									sql`${OrganizationLocation.liveAt} is not null`,
								),
							),
					),
				),
			),
		)
		.orderBy(sql`${SetupReminderState.updatedAt} asc nulls first`)
		.limit(MAX_ORGANIZATIONS_PER_RUN)
	const result: SetupReminderRunResult = {
		checked: 0,
		sent: 0,
		skipped: 0,
		reset: 0,
		excluded: 0,
	}
	for (const candidate of candidates) {
		result.checked++
		try {
			const outcome = await runForOrganization(candidate.id, deps)
			if (outcome === 'sent') result.sent++
			else if (outcome === 'skipped') result.skipped++
			else if (outcome === 'reset') result.reset++
			else if (outcome === 'excluded') result.excluded++
		} catch (error) {
			console.error('Setup reminder failed for an organization:', {
				error: error instanceof Error ? error.name : 'unknown',
			})
		}
	}
	return result
}

export type ReminderPreview =
	| {
			status: 'ok'
			subject: string
			heading: string
			intro: string
			progress: string
			actionLabel: string
			locale: 'en' | 'ar'
			recipients: number
			/** When a manual reminder may go out again; null: now. */
			nextManualAt: string | null
	  }
	| { status: 'nobody_to_notify' }
	| { status: 'excluded'; reason: ReminderExclusion }
	| { status: 'checklist_off' }
	| { status: 'live' }
	| { status: 'nothing_to_remind' }

async function lastManualAt(organizationId: string): Promise<Date | null> {
	const [row] = await db
		.select({ sentAt: SetupReminder.sentAt })
		.from(SetupReminder)
		.where(
			and(
				eq(SetupReminder.organizationId, organizationId),
				eq(SetupReminder.kind, 'manual'),
			),
		)
		.orderBy(desc(SetupReminder.sentAt))
		.limit(1)
	return row?.sentAt ?? null
}

/** What Admin's "Send reminder now" would send, with who it would go to. */
export async function previewSetupReminder(
	organizationId: string,
	deps: ReminderDeps = defaultDeps,
): Promise<ReminderPreview> {
	const now = deps.now()
	const evaluation = await evaluateSetupReminder(organizationId, now)
	if (evaluation.status !== 'ok') return evaluation
	const recipients = await resolveReminderRecipients(organizationId, now)
	if (recipients.length === 0) return { status: 'nobody_to_notify' }
	const built = buildReminderCopy(evaluation)
	const last = await lastManualAt(organizationId)
	const next = last
		? new Date(last.getTime() + MANUAL_REMINDER_INTERVAL_MS)
		: null
	return {
		status: 'ok',
		subject: built.copy.subject,
		heading: built.copy.heading,
		intro: built.copy.intro,
		progress: built.copy.progress,
		actionLabel: built.copy.actionLabel,
		locale: built.copy.locale,
		recipients: recipients.length,
		nextManualAt: next && next > now ? next.toISOString() : null,
	}
}

export type ManualReminderResult =
	| { status: 'sent'; recipients: number }
	| { status: 'limit'; nextAt: string }
	| { status: 'nobody_to_notify' }
	| { status: 'excluded'; reason: ReminderExclusion }
	| { status: 'checklist_off' }
	| { status: 'live' }
	| { status: 'nothing_to_remind' }
	| { status: 'failed' }

/**
 * Admin's manual reminder: one per organization per day, audit logged, with
 * the same exclusions as the automatic ones (test, cancelled, live) and the
 * same opt-out. The history row is written only when an email went out.
 */
export async function sendManualSetupReminder(
	input: { organizationId: string; adminUserId: string },
	deps: ReminderDeps = defaultDeps,
): Promise<ManualReminderResult> {
	const now = deps.now()
	const evaluation = await evaluateSetupReminder(input.organizationId, now)
	if (evaluation.status !== 'ok') return evaluation
	const last = await lastManualAt(input.organizationId)
	if (last && now.getTime() - last.getTime() < MANUAL_REMINDER_INTERVAL_MS) {
		return {
			status: 'limit',
			nextAt: new Date(
				last.getTime() + MANUAL_REMINDER_INTERVAL_MS,
			).toISOString(),
		}
	}
	const recipients = await resolveReminderRecipients(input.organizationId, now)
	if (recipients.length === 0) return { status: 'nobody_to_notify' }
	const sent = await deliver(deps, evaluation, recipients)
	if (sent === 0) return { status: 'failed' }
	await logReminder({
		evaluation,
		kind: 'manual',
		day: null,
		recipientCount: sent,
		sentById: input.adminUserId,
		now,
	})
	try {
		await auditService.log({
			action: AuditAction.ORG_SETTINGS_UPDATED,
			userId: input.adminUserId,
			organizationId: input.organizationId,
			resourceType: 'organization',
			resourceId: input.organizationId,
			details: 'Setup reminder sent manually',
			// The step and the count only: never an address.
			metadata: { stepKey: evaluation.target.stepKey, recipients: sent },
		})
	} catch {
		// A log line never undoes a sent email.
	}
	return { status: 'sent', recipients: sent }
}
