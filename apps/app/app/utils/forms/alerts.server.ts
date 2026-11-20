import {
	FORM_ALERT_EMAIL_WINDOW_MS,
	FORM_RESPONSE_WORKFLOW,
	type FormResponseEvent,
	type FormResponseResult,
} from '@repo/common/form-alerts'
import {
	and,
	db,
	eq,
	FormAlertDigest,
	inArray,
	isNull,
	lte,
	Notification,
	NotificationPreference,
	or,
	OrganizationRole,
	Permission,
	sql,
	User,
	UserOrganization,
	_OrganizationPermissionToRole,
} from '@repo/database'
import { StaffingAlertEmail, sendEmail } from '@repo/email'
import { ENV } from 'varlock/env'
import {
	FORM_EMAIL_ACTION,
	FORM_EMAIL_EYEBROW,
	FORM_EMAIL_SETTINGS_NOTE,
	FORM_RESPONSE_NOTIFICATION_TYPE,
	formAlertPath,
	formResponseEmail,
} from './form-alerts.ts'

export type FormAlertRecipient = {
	userId: string
	email: string
	name: string | null
}

const MAX_RECIPIENTS = 100

/**
 * Active, unbanned members whose role holds `read:website:any` (the people who
 * can open the Mailbox's forms), optionally narrowed to the members chosen in
 * the form's settings. Capped, so an alert can never become a mass mailing.
 */
export async function resolveFormAlertRecipients(input: {
	organizationId: string
	/** `null`: every member with website access. */
	onlyUserIds: readonly string[] | null
	now?: Date
}): Promise<FormAlertRecipient[]> {
	const now = input.now ?? new Date()
	if (input.onlyUserIds && input.onlyUserIds.length === 0) return []
	const rows = await db
		.select({
			userId: UserOrganization.userId,
			email: User.email,
			name: User.name,
			bannedAt: User.bannedAt,
			banExpiresAt: User.banExpiresAt,
		})
		.from(UserOrganization)
		.innerJoin(User, eq(User.id, UserOrganization.userId))
		.innerJoin(
			OrganizationRole,
			eq(OrganizationRole.id, UserOrganization.organizationRoleId),
		)
		.innerJoin(
			_OrganizationPermissionToRole,
			eq(_OrganizationPermissionToRole.A, OrganizationRole.id),
		)
		.innerJoin(Permission, eq(Permission.id, _OrganizationPermissionToRole.B))
		.where(
			and(
				eq(UserOrganization.organizationId, input.organizationId),
				eq(UserOrganization.active, true),
				or(
					isNull(OrganizationRole.organizationId),
					eq(OrganizationRole.organizationId, input.organizationId),
				),
				eq(Permission.context, 'organization'),
				eq(Permission.action, 'read'),
				eq(Permission.entity, 'website'),
				eq(Permission.access, 'any'),
				input.onlyUserIds
					? inArray(UserOrganization.userId, [...input.onlyUserIds])
					: undefined,
			),
		)
	const seen = new Set<string>()
	const recipients: FormAlertRecipient[] = []
	for (const row of rows.sort((a, b) => a.userId.localeCompare(b.userId))) {
		if (seen.has(row.userId) || !row.email) continue
		const banned =
			row.bannedAt !== null &&
			(row.banExpiresAt === null || row.banExpiresAt > now)
		if (banned) continue
		seen.add(row.userId)
		recipients.push({ userId: row.userId, email: row.email, name: row.name })
		if (recipients.length >= MAX_RECIPIENTS) break
	}
	return recipients
}

async function channelPreferences(
	organizationId: string,
	userIds: string[],
): Promise<Map<string, { inApp: boolean; email: boolean }>> {
	const map = new Map<string, { inApp: boolean; email: boolean }>()
	if (userIds.length === 0) return map
	const rows = await db
		.select({
			userId: NotificationPreference.userId,
			inApp: NotificationPreference.inApp,
			email: NotificationPreference.email,
		})
		.from(NotificationPreference)
		.where(
			and(
				eq(NotificationPreference.organizationId, organizationId),
				eq(NotificationPreference.workflow, FORM_RESPONSE_WORKFLOW),
				inArray(NotificationPreference.userId, userIds),
			),
		)
	for (const row of rows) {
		map.set(row.userId, { inApp: row.inApp, email: row.email })
	}
	return map
}

export type FormAlertDeps = {
	now: () => Date
	sendEmail: typeof sendEmail
}

const defaultDeps: FormAlertDeps = { now: () => new Date(), sendEmail }

function actionUrl(orgSlug: string, formId: string) {
	const baseUrl = String(ENV.BASE_URL ?? '').replace(/\/$/, '')
	return `${baseUrl}/${orgSlug}${formAlertPath(formId)}`
}

async function sendDigestEmail(
	deps: FormAlertDeps,
	input: {
		email: string
		orgSlug: string
		formId: string
		formName: string
		count: number
	},
): Promise<boolean> {
	const copy = formResponseEmail(input.formName, input.count)
	try {
		const result = await deps.sendEmail({
			to: input.email,
			subject: copy.subject,
			react: StaffingAlertEmail({
				eyebrow: FORM_EMAIL_EYEBROW,
				headline: copy.headline,
				detail: copy.detail,
				actionLabel: FORM_EMAIL_ACTION,
				actionUrl: actionUrl(input.orgSlug, input.formId),
				settingsNote: FORM_EMAIL_SETTINGS_NOTE,
			}),
		})
		return result.status !== 'error'
	} catch {
		return false
	}
}

/**
 * Adds a response to a member's pending count and, when no email went to them
 * for this form in the last 10 minutes, sends one covering everything pending
 * ("3 new responses"). The claim is one compare-and-set UPDATE on the pending
 * count, so two responses arriving together cannot both send. Responses that
 * land inside the window wait in `pendingCount` for the next email (or for the
 * sweep, `flushFormAlertDigests`).
 */
async function recordAndMaybeEmail(
	deps: FormAlertDeps,
	input: {
		organizationId: string
		orgSlug: string
		userId: string
		email: string
		formId: string
		formName: string
		count: number
	},
): Promise<boolean> {
	const now = deps.now()
	const key = and(
		eq(FormAlertDigest.organizationId, input.organizationId),
		eq(FormAlertDigest.userId, input.userId),
		eq(FormAlertDigest.formId, input.formId),
	)
	await db
		.insert(FormAlertDigest)
		.values({
			organizationId: input.organizationId,
			userId: input.userId,
			formId: input.formId,
			formName: input.formName,
			pendingCount: 0,
		})
		.onConflictDoNothing()
	await db
		.update(FormAlertDigest)
		.set({
			pendingCount: sql`${FormAlertDigest.pendingCount} + ${input.count}`,
			formName: input.formName,
		})
		.where(key)
	return claimAndSend(deps, { ...input, key, now })
}

async function claimAndSend(
	deps: FormAlertDeps,
	input: {
		organizationId: string
		orgSlug: string
		userId: string
		email: string
		formId: string
		formName: string
		key: ReturnType<typeof and>
		now: Date
	},
): Promise<boolean> {
	const [row] = await db
		.select()
		.from(FormAlertDigest)
		.where(input.key)
		.limit(1)
	if (!row || row.pendingCount < 1) return false
	const windowStart = new Date(input.now.getTime() - FORM_ALERT_EMAIL_WINDOW_MS)
	const claimed = await db
		.update(FormAlertDigest)
		.set({ lastEmailedAt: input.now, pendingCount: 0 })
		.where(
			and(
				input.key,
				eq(FormAlertDigest.pendingCount, row.pendingCount),
				or(
					isNull(FormAlertDigest.lastEmailedAt),
					lte(FormAlertDigest.lastEmailedAt, windowStart),
				),
			),
		)
		.returning({ id: FormAlertDigest.id })
	if (claimed.length === 0) return false
	const sent = await sendDigestEmail(deps, {
		email: input.email,
		orgSlug: input.orgSlug,
		formId: input.formId,
		formName: row.formName || input.formName,
		count: row.pendingCount,
	})
	if (!sent) {
		// Not sent: put the count back so the next response or sweep tries again.
		await db
			.update(FormAlertDigest)
			.set({
				lastEmailedAt: row.lastEmailedAt,
				pendingCount: sql`${FormAlertDigest.pendingCount} + ${row.pendingCount}`,
			})
			.where(input.key)
		return false
	}
	return true
}

/**
 * Handles one "new response" event from a region (#142): an in-app
 * notification per member within seconds (the notification row is the claim,
 * so a retried delivery tells nobody twice), and email batched to one per form
 * per member per 10 minutes. Nothing about the answers is ever here.
 */
export async function deliverFormResponseAlert(
	event: FormResponseEvent,
	organization: { id: string; slug: string },
	deps: FormAlertDeps = defaultDeps,
): Promise<FormResponseResult> {
	const recipients = await resolveFormAlertRecipients({
		organizationId: organization.id,
		onlyUserIds: event.notify.mode === 'members' ? event.notify.userIds : null,
		now: deps.now(),
	})
	if (recipients.length === 0)
		return { inApp: 0, emailed: 0, skipped: 'no_recipients' }
	const preferences = await channelPreferences(
		organization.id,
		recipients.map((recipient) => recipient.userId),
	)
	let inApp = 0
	let emailed = 0
	for (const recipient of recipients) {
		const channels = preferences.get(recipient.userId) ?? {
			inApp: true,
			email: true,
		}
		if (channels.inApp) {
			const claimed = await db
				.insert(Notification)
				.values({
					userId: recipient.userId,
					organizationId: organization.id,
					type: FORM_RESPONSE_NOTIFICATION_TYPE,
					// One per response: a redelivery finds the row and adds nothing.
					entityId: event.eventId,
					payload: JSON.stringify({
						orgSlug: organization.slug,
						formId: event.formId,
						formName: event.formName,
						kind: 'form_response',
						count: event.count,
					}),
				})
				.onConflictDoNothing()
				.returning({ id: Notification.id })
			if (claimed.length === 0) continue // already handled for this member
			inApp++
		}
		if (channels.email) {
			const sent = await recordAndMaybeEmail(deps, {
				organizationId: organization.id,
				orgSlug: organization.slug,
				userId: recipient.userId,
				email: recipient.email,
				formId: event.formId,
				formName: event.formName,
				count: event.count,
			})
			if (sent) emailed++
		}
	}
	return { inApp, emailed }
}

/**
 * The sweep (every 15 minutes, with the domain-status slot): sends the batched
 * email for members whose responses piled up inside a window and whose last
 * email is now older than 10 minutes. Returns how many went out.
 */
export async function flushFormAlertDigests(
	deps: FormAlertDeps = defaultDeps,
): Promise<{ emailed: number }> {
	const now = deps.now()
	const windowStart = new Date(now.getTime() - FORM_ALERT_EMAIL_WINDOW_MS)
	const due = await db
		.select({
			digest: FormAlertDigest,
			email: User.email,
			slug: sql<string>`(select "slug" from "Organization" where "Organization"."id" = ${FormAlertDigest.organizationId})`,
		})
		.from(FormAlertDigest)
		.innerJoin(User, eq(User.id, FormAlertDigest.userId))
		.where(
			and(
				sql`${FormAlertDigest.pendingCount} > 0`,
				or(
					isNull(FormAlertDigest.lastEmailedAt),
					lte(FormAlertDigest.lastEmailedAt, windowStart),
				),
			),
		)
		.limit(200)
	let emailed = 0
	for (const { digest, email, slug } of due) {
		if (!email || !slug) continue
		const preferences = await channelPreferences(digest.organizationId, [
			digest.userId,
		])
		if (preferences.get(digest.userId)?.email === false) {
			await db
				.update(FormAlertDigest)
				.set({ pendingCount: 0 })
				.where(eq(FormAlertDigest.id, digest.id))
			continue
		}
		const sent = await claimAndSend(deps, {
			organizationId: digest.organizationId,
			orgSlug: slug,
			userId: digest.userId,
			email,
			formId: digest.formId,
			formName: digest.formName,
			key: eq(FormAlertDigest.id, digest.id),
			now,
		})
		if (sent) emailed++
	}
	return { emailed }
}
