import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	and,
	db,
	eq,
	isNull,
	MarketingOccasionChoice,
	ne,
	Notification,
	or,
	Organization,
} from '@repo/database'
import { sendEmail, StaffingAlertEmail } from '@repo/email'
import { buildOccasionMessage } from '@repo/marketing/occasion-message'
import {
	AUTO_SCHEDULE_LEAD_DAYS,
	OCCASION_CONFLICT_DAYS,
	occasionTitle,
	occasionsBetween,
	type OccasionKey,
} from '@repo/marketing/occasions'
import {
	checkSmsSend,
	reserveSmsSend,
} from '@repo/marketing/server/sms-allowance'
import { ENV } from 'varlock/env'
import { designEmail } from '#app/utils/email/designer.server.ts'
import { orgSiteUrl } from '#app/utils/launch/launch.server.ts'
import { dayKey } from '#app/utils/social/time.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import {
	loadOrganizationFacts,
	marketOf,
	organizationTimeZone,
	recommendedSendAt,
	type OccasionChoiceRow,
} from './calendar.server.ts'
import { resolveCampaignAlertRecipients } from './campaign-alerts.server.ts'
import { MARKETING_FLAG_KEYS } from './marketing-flags.server.ts'
import {
	OCCASION_ALERT_TYPES,
	occasionAlertEmailCopy,
	occasionAlertPath,
	type OccasionAlertKind,
} from './occasion-alerts.ts'

/**
 * The daily occasion job (#152): for every occasion an organization turned
 * Auto-schedule on for, 14 days before the day it creates a Scheduled broadcast
 * with the occasion's ready-made words, once per year, and tells the operator,
 * who can edit or cancel it until it goes out. Never sends by itself: only an
 * occasion with Auto-schedule on is touched, only while `marketing.calendar` is
 * on, and the usual consent, frequency and quiet-hours rules apply when the
 * region starts the broadcast.
 *
 * Idempotent: one conditional update claims the year for an occasion, so two
 * runs (the workflow and the hourly sweep) never create two broadcasts. A
 * broadcast already scheduled within 2 days of the occasion or of the planned
 * send is a conflict (`occasion_conflict`, checked by the region in the same
 * write): nothing is created, the year is marked skipped and the operator told.
 */

export type CreateOutcome =
	| { status: 'created'; campaignId: string }
	| { status: 'conflict' }
	| { status: 'failed' }

export type OccasionJobDeps = {
	isEnabled: (organizationId: string) => Promise<boolean>
	createCampaign: (
		organization: { id: string; dataRegion: string },
		payload: Record<string, unknown>,
	) => Promise<CreateOutcome>
	notify: (input: {
		organization: { id: string; slug: string }
		kind: OccasionAlertKind
		occasionKey: OccasionKey
		year: number
		campaignId: string | null
		reason: string | null
	}) => Promise<void>
}

export const defaultDeps: OccasionJobDeps = {
	isEnabled: async (organizationId) => {
		const flag = await getFeatureFlag(MARKETING_FLAG_KEYS.calendar, {
			organizationId,
		})
		return flag === true || flag === 'true'
	},
	createCampaign: async (organization, payload) => {
		const { tenantApiUrl } = resolveRegionalTenantApiUrls(
			organization.dataRegion,
		)
		try {
			const res = await fetch(
				`${tenantApiUrl.replace(/\/$/, '')}/api/marketing/campaigns/auto-schedule`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ ...payload, orgId: organization.id }),
					signal: AbortSignal.timeout(30_000),
				},
			)
			if (res.status === 409) return { status: 'conflict' }
			if (!res.ok) return { status: 'failed' }
			const body = (await res.json()) as { campaignId?: string }
			return body.campaignId
				? { status: 'created', campaignId: body.campaignId }
				: { status: 'failed' }
		} catch {
			return { status: 'failed' }
		}
	},
	notify: notifyOperators,
}

async function notifyOperators(input: {
	organization: { id: string; slug: string }
	kind: OccasionAlertKind
	occasionKey: OccasionKey
	year: number
	campaignId: string | null
	reason: string | null
}) {
	const recipients = await resolveCampaignAlertRecipients({
		organizationId: input.organization.id,
	})
	const copy = occasionAlertEmailCopy(
		input.kind,
		occasionTitle(input.occasionKey, 'en'),
		input.reason,
	)
	const baseUrl = String(ENV.BASE_URL ?? '').replace(/\/$/, '')
	const actionUrl = `${baseUrl}/${input.organization.slug}${occasionAlertPath(input.campaignId)}`
	for (const recipient of recipients) {
		// The row is the claim for this occasion, year and member: a repeat run
		// tells nobody twice.
		const claimed = await db
			.insert(Notification)
			.values({
				userId: recipient.userId,
				organizationId: input.organization.id,
				type: OCCASION_ALERT_TYPES[input.kind],
				entityId: `${input.occasionKey}:${input.year}`,
				payload: JSON.stringify({
					orgSlug: input.organization.slug,
					occasionKey: input.occasionKey,
					year: input.year,
					campaignId: input.campaignId,
					reason: input.reason,
				}),
			})
			.onConflictDoNothing()
			.returning({ id: Notification.id })
		if (claimed.length === 0) continue
		try {
			await sendEmail({
				to: recipient.email,
				subject: copy.subject,
				react: StaffingAlertEmail({
					eyebrow: copy.eyebrow,
					headline: copy.headline,
					detail: copy.detail,
					actionLabel: copy.actionLabel,
					actionUrl,
					settingsNote: '',
				}),
			})
		} catch {
			console.error('Failed to send occasion alert email')
		}
	}
}

export type OccasionJobResult = {
	organizations: number
	scheduled: number
	skipped: number
	failed: number
}

/** Runs one pass for every organization with an occasion set to auto-schedule. */
export async function runOccasionAutoSchedule(
	options: { now?: number; deps?: Partial<OccasionJobDeps> } = {},
): Promise<OccasionJobResult> {
	const now = options.now ?? Date.now()
	const deps = { ...defaultDeps, ...options.deps }
	const result: OccasionJobResult = {
		organizations: 0,
		scheduled: 0,
		skipped: 0,
		failed: 0,
	}
	const rows = await db
		.select({ choice: MarketingOccasionChoice })
		.from(MarketingOccasionChoice)
		.innerJoin(
			Organization,
			eq(Organization.id, MarketingOccasionChoice.organizationId),
		)
		.where(
			and(
				eq(MarketingOccasionChoice.autoSchedule, true),
				eq(Organization.active, true),
				eq(Organization.hasProvisionedDb, true),
			),
		)
	const byOrg = new Map<string, OccasionChoiceRow[]>()
	for (const { choice } of rows) {
		byOrg.set(choice.organizationId, [
			...(byOrg.get(choice.organizationId) ?? []),
			choice,
		])
	}
	for (const [organizationId, choices] of byOrg) {
		result.organizations++
		try {
			const outcome = await runForOrganization(
				organizationId,
				choices,
				now,
				deps,
			)
			result.scheduled += outcome.scheduled
			result.skipped += outcome.skipped
			result.failed += outcome.failed
		} catch (error) {
			result.failed++
			console.error('Occasion auto-schedule failed for an organization', {
				organizationId,
				reason: error instanceof Error ? error.name : 'unknown',
			})
		}
	}
	return result
}

async function runForOrganization(
	organizationId: string,
	choices: OccasionChoiceRow[],
	now: number,
	deps: OccasionJobDeps,
) {
	const outcome = { scheduled: 0, skipped: 0, failed: 0 }
	if (!(await deps.isEnabled(organizationId))) return outcome
	const org = await loadOrganizationFacts(organizationId)
	if (!org) return outcome
	const timeZone = await organizationTimeZone(organizationId)
	const market = marketOf(org)
	const today = dayKey(new Date(now), timeZone)
	const horizon = new Date(
		Date.parse(`${today}T00:00:00Z`) + AUTO_SCHEDULE_LEAD_DAYS * 86_400_000,
	)
		.toISOString()
		.slice(0, 10)
	const coming = occasionsBetween(market, today, horizon)

	for (const choice of choices) {
		const occurrence = coming.find((entry) => entry.key === choice.occasionKey)
		if (!occurrence) continue
		const year = occurrence.year
		if (
			choice.dismissedYear === year ||
			choice.scheduledYear === year ||
			choice.skippedYear === year
		) {
			continue
		}
		// Claim the year: only the run that wins this update creates the broadcast.
		const claimed = await db
			.update(MarketingOccasionChoice)
			.set({ scheduledYear: year, skipReason: null })
			.where(
				and(
					eq(MarketingOccasionChoice.id, choice.id),
					or(
						isNull(MarketingOccasionChoice.scheduledYear),
						ne(MarketingOccasionChoice.scheduledYear, year),
					),
					or(
						isNull(MarketingOccasionChoice.dismissedYear),
						ne(MarketingOccasionChoice.dismissedYear, year),
					),
				),
			)
			.returning({ id: MarketingOccasionChoice.id })
		if (claimed.length === 0) continue

		const release = () =>
			db
				.update(MarketingOccasionChoice)
				.set({ scheduledYear: choice.scheduledYear })
				.where(
					and(
						eq(MarketingOccasionChoice.id, choice.id),
						eq(MarketingOccasionChoice.scheduledYear, year),
					),
				)
		const skip = async (reason: string) => {
			await db
				.update(MarketingOccasionChoice)
				.set({
					scheduledYear: choice.scheduledYear,
					skippedYear: year,
					skipReason: reason,
				})
				.where(eq(MarketingOccasionChoice.id, choice.id))
			await deps.notify({
				organization: org,
				kind: 'skipped',
				occasionKey: choice.occasionKey as OccasionKey,
				year,
				campaignId: null,
				reason,
			})
			outcome.skipped++
		}

		try {
			const sendAt = recommendedSendAt(occurrence.sendDate, timeZone, now)
			const message = buildOccasionMessage({
				key: occurrence.key,
				locale: org.siteDefaultLocale || 'en',
				restaurant: org.name,
				siteOrigin: orgSiteUrl(org),
				year,
			})
			const channel = choice.channel === 'sms' ? 'sms' : 'email'
			if (channel === 'sms') {
				const check = await checkSmsSend({ organizationId, startsAtMs: sendAt })
				if (!check.ok) {
					await skip('sms_allowance')
					continue
				}
			}
			let payload: Record<string, unknown>
			if (channel === 'email') {
				const designed = await designEmail({
					organizationId,
					blocks: JSON.stringify(message.blocks),
					subject: message.subject,
					baseUrl: String(ENV.BASE_URL ?? ''),
					offer: null,
				})
				if (!designed.ok) {
					await release()
					outcome.failed++
					continue
				}
				payload = {
					channel,
					subject: message.subject,
					content: designed.text,
					contentHtml: designed.html,
					contentBlocks: JSON.stringify(designed.blocks),
				}
			} else {
				payload = { channel, subject: null, content: message.sms }
			}
			const created = await deps.createCampaign(org, {
				...payload,
				name: message.name,
				audienceId: choice.audienceId || null,
				scheduledAt: new Date(sendAt).toISOString(),
				occasionDate: occurrence.date,
				conflictDays: OCCASION_CONFLICT_DAYS,
			})
			if (created.status === 'conflict') {
				await skip('occasion_conflict')
				continue
			}
			if (created.status === 'failed') {
				// Not claimed after all: the next sweep tries again.
				await release()
				outcome.failed++
				continue
			}
			await db
				.update(MarketingOccasionChoice)
				.set({ campaignId: created.campaignId, skipReason: null })
				.where(eq(MarketingOccasionChoice.id, choice.id))
			if (channel === 'sms') {
				await reserveSmsSend({
					organizationId,
					campaignId: created.campaignId,
					startsAtMs: sendAt,
				})
			}
			await deps.notify({
				organization: org,
				kind: 'scheduled',
				occasionKey: choice.occasionKey as OccasionKey,
				year,
				campaignId: created.campaignId,
				reason: null,
			})
			outcome.scheduled++
		} catch (error) {
			await release()
			outcome.failed++
			console.error('An occasion could not be auto-scheduled', {
				organizationId,
				occasionKey: choice.occasionKey,
				reason: error instanceof Error ? error.name : 'unknown',
			})
		}
	}
	return outcome
}

/** The hour (UTC) the daily occasion job wakes up. */
export const OCCASION_JOB_HOUR_UTC = 6

/** The next daily wake-up: 06:00 UTC, strictly after `now`. */
export function nextOccasionRun(now: number): Date {
	const day = new Date(now)
	let run = Date.UTC(
		day.getUTCFullYear(),
		day.getUTCMonth(),
		day.getUTCDate(),
		OCCASION_JOB_HOUR_UTC,
	)
	if (run <= now) run += 86_400_000
	return new Date(run)
}

/**
 * Asks jobs-cron to wake the job at `runAt` (`step.sleepUntil`): the payload is
 * a time only. The hourly sweep is the fallback when this cannot be started.
 */
export async function wakeOccasionWorkflow(runAt: Date): Promise<boolean> {
	const workerUrl =
		typeof ENV.JOBS_CRON_WORKER_URL === 'string'
			? ENV.JOBS_CRON_WORKER_URL.trim()
			: ''
	if (!workerUrl) return false
	try {
		const response = await fetch(
			`${workerUrl.replace(/\/$/u, '')}/workflows/occasion-schedule/start`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ runAt: runAt.toISOString() }),
				signal: AbortSignal.timeout(5_000),
			},
		)
		return response.ok
	} catch {
		return false
	}
}
