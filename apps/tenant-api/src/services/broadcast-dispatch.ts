import { randomUUID } from 'node:crypto'
import {
	and,
	count,
	eq,
	gte,
	isNotNull,
	lt,
	lte,
	min,
	or,
	sql,
} from 'drizzle-orm'
import { sendSms } from '@repo/sms'
import {
	getTenantDb,
	interpolateMergeTags,
	interpolateMergeTagsHtml,
	marketingCampaigns,
	marketingMessages,
	type Customer,
	type TenantDatabase,
} from '@repo/tenant-db'
import { insertRowsInChunks, inJsonList } from '../lib/chunked-in.ts'
import {
	consentBaseUrl,
	listUnsubscribeHeaders,
	unsubscribeUrl,
} from '../lib/email-consent.ts'
import { getBroadcastHourlyCap } from '../lib/rate-limit.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { BROADCAST_TOPIC, loadBroadcastAudience } from './marketing-audience.ts'

/**
 * Broadcast dispatch, resumable and safe to drive from more than one place.
 *
 * - The campaign row is the lease: `status = 'Processing'` plus `updated_at`,
 *   which the running dispatch refreshes before every batch (compare-and-set
 *   on the value it last wrote). A dispatch whose heartbeat no longer matches
 *   was taken over and stops.
 * - A message row per (campaign, customer) is written before the send, so a
 *   resumed dispatch sends only to audience members without one. The row is
 *   unique, and a dispatch sends only to the recipients whose row it inserted,
 *   so two dispatches running at once never both send to someone. Rows left
 *   `Processing` by a dispatch that died are marked `Unknown`, never resent.
 * - Consent is re-checked per batch, so an unsubscribe during a long send is
 *   honoured.
 * - Every recipient counts against an hourly per-organization ceiling read
 *   from `marketing_messages` (durable across isolates and restarts). At the
 *   ceiling the campaign stays `Processing` and the tick resumes it later.
 * - The regional tick resumes stale `Processing` campaigns and starts
 *   scheduled ones that are due (`runBroadcastTick`).
 */

export const BROADCAST_BATCH_SIZE = 25
/** A `Processing` campaign with no heartbeat for this long is resumed. */
export const BROADCAST_STALE_MS = 10 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
/**
 * Dispatch attempts in a row that may end in an unexpected error before the
 * campaign is marked `Failed`. Each retry waits for the lease to go stale
 * (`BROADCAST_STALE_MS`), so this is roughly an hour of failures; a batch that
 * goes out resets the count.
 */
export const BROADCAST_MAX_FAILURES = 6
/** Campaigns claimed per organization per tick. */
const MAX_CAMPAIGNS_PER_TICK = 3

type Db = TenantDatabase

function toLease(ms: number) {
	// `updated_at` is stored in whole seconds.
	return new Date(Math.floor(ms / 1000) * 1000)
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

function audienceRule(segmentationRules: unknown): string | undefined {
	if (!segmentationRules) return undefined
	try {
		const rules =
			typeof segmentationRules === 'string'
				? (JSON.parse(segmentationRules) as { audience?: string })
				: (segmentationRules as { audience?: string })
		return rules?.audience
	} catch {
		return undefined
	}
}

/** Messages of this channel the organization sent (or attempted) in the last hour. */
export async function broadcastSendsInWindow(
	db: Db,
	channel: 'email' | 'sms',
	now: number,
) {
	const [row] = await db
		.select({ n: count() })
		.from(marketingMessages)
		.where(
			and(
				eq(marketingMessages.channel, channel),
				gte(marketingMessages.sentAt, new Date(now - HOUR_MS)),
			),
		)
	return row?.n ?? 0
}

/**
 * Refreshes the lease. Returns the new lease, or null when the campaign is no
 * longer ours (another dispatch took it over, or it left `Processing`).
 */
async function heartbeat(db: Db, campaignId: string, lease: Date, now: number) {
	const next = toLease(now)
	const rows = await db
		.update(marketingCampaigns)
		.set({ updatedAt: next })
		.where(
			and(
				eq(marketingCampaigns.id, campaignId),
				eq(marketingCampaigns.status, 'Processing'),
				eq(marketingCampaigns.updatedAt, lease),
			),
		)
		.returning({ id: marketingCampaigns.id })
	return rows.length > 0 ? next : null
}

/** The campaign is still `Processing` under this dispatcher's lease. */
function holdsLease(campaignId: string, lease: Date) {
	return and(
		eq(marketingCampaigns.id, campaignId),
		eq(marketingCampaigns.status, 'Processing'),
		eq(marketingCampaigns.updatedAt, lease),
	)
}

async function finish(
	db: Db,
	campaignId: string,
	lease: Date,
	status: 'Completed' | 'Failed',
) {
	await db
		.update(marketingCampaigns)
		.set({ status, updatedAt: new Date() })
		.where(
			and(
				eq(marketingCampaigns.id, campaignId),
				eq(marketingCampaigns.status, 'Processing'),
				eq(marketingCampaigns.updatedAt, lease),
			),
		)
}

export type BroadcastDispatchOptions = {
	now?: () => number
}

export type BroadcastDispatchOutcome =
	'completed' | 'failed' | 'retry' | 'throttled' | 'lost_lease' | 'missing'

/**
 * Sends a `Processing` campaign the caller holds (it created it or claimed it
 * with `lease` as its `updated_at`).
 */
export async function dispatchBroadcast(
	orgId: string,
	campaignId: string,
	lease: Date,
	options: BroadcastDispatchOptions = {},
): Promise<BroadcastDispatchOutcome> {
	const clock = options.now ?? (() => Date.now())
	let db: Db | undefined
	let currentLease = lease
	try {
		db = await getTenantDb(orgId)
		const campaign = await db
			.select()
			.from(marketingCampaigns)
			.where(eq(marketingCampaigns.id, campaignId))
			.get()
		if (!campaign) return 'missing'
		const channel: 'email' | 'sms' =
			campaign.channel === 'sms' ? 'sms' : 'email'
		const audience = audienceRule(campaign.segmentationRules)

		// The unsubscribe link carries a signed token, so its origin must be the
		// configured one. Without it no email can go out: fail the campaign now,
		// before any per-recipient work. Ids only in the log.
		const consentOrigin = channel === 'email' ? consentBaseUrl() : null
		if (channel === 'email' && !consentOrigin) {
			console.error('Broadcast failed: TENANT_API_URL is not set', {
				orgId,
				campaignId,
			})
			await finish(db, campaignId, currentLease, 'Failed')
			return 'failed'
		}

		const targets = await loadBroadcastAudience(db, { channel, audience })
		const alreadyMessaged = new Set(
			(
				await db
					.select({ customerId: marketingMessages.customerId })
					.from(marketingMessages)
					.where(eq(marketingMessages.campaignId, campaignId))
					.all()
			).map((row) => row.customerId),
		)
		await db
			.update(marketingCampaigns)
			.set({
				targetAudienceCount: Math.max(
					targets.length,
					campaign.targetAudienceCount ?? 0,
				),
			})
			.where(eq(marketingCampaigns.id, campaignId))

		const pending = targets.filter((c) => !alreadyMessaged.has(c.id))
		const cap = getBroadcastHourlyCap(channel)
		let failuresReset = false

		for (let i = 0; i < pending.length; i += BROADCAST_BATCH_SIZE) {
			const next = await heartbeat(db, campaignId, currentLease, clock())
			if (!next) return 'lost_lease'
			currentLease = next

			const room = cap - (await broadcastSendsInWindow(db, channel, clock()))
			if (room <= 0) {
				console.warn('Broadcast reached the hourly send cap; will resume', {
					orgId,
					campaignId,
				})
				return 'throttled'
			}

			const batchIds = pending
				.slice(i, i + BROADCAST_BATCH_SIZE)
				.map((c) => c.id)
			// Consent and contact details as they are now, not at the start.
			const fresh = await loadBroadcastAudience(db, {
				channel,
				audience,
				customerIds: batchIds,
			})
			const chunk = fresh.slice(0, room)
			const capReached = fresh.length > room
			if (chunk.length === 0) continue
			const sentAt = new Date(clock())

			const candidates = chunk.map((customer) => ({
				messageId: randomUUID(),
				customer,
			}))
			// One row per (campaign, customer), enforced by a unique index. A
			// recipient whose row another dispatcher already wrote is theirs:
			// only the rows this run inserted are sent.
			const inserted = await insertRowsInChunks(
				marketingMessages,
				candidates.map((item) => ({
					id: item.messageId,
					campaignId,
					customerId: item.customer.id,
					channel,
					status: 'Processing',
					sentAt,
				})),
				(part) =>
					db!
						.insert(marketingMessages)
						.values(part)
						.onConflictDoNothing()
						.returning({ id: marketingMessages.id }),
			)
			const insertedIds = new Set(inserted.map((row) => row.id))
			const items = candidates.filter((item) => insertedIds.has(item.messageId))

			const results = await Promise.allSettled(
				items.map(({ messageId, customer }) =>
					sendOne({
						orgId,
						campaignId,
						campaign,
						channel,
						consentOrigin,
						messageId,
						customer,
					}),
				),
			)

			const sentIds: string[] = []
			const failedIds: string[] = []
			results.forEach((res, idx) => {
				const id = items[idx]!.messageId
				if (res.status === 'fulfilled') {
					sentIds.push(id)
				} else {
					console.error('Broadcast send failed', {
						orgId,
						campaignId,
						customerId: items[idx]!.customer.id,
						reason:
							res.reason instanceof Error ? res.reason.message : 'unknown',
					})
					failedIds.push(id)
				}
			})

			// Only from Processing: engagement sync may already have moved a row
			// to Opened or Clicked, which must not be overwritten.
			if (sentIds.length > 0) {
				await db
					.update(marketingMessages)
					.set({ status: 'Sent', sentAt: new Date(clock()) })
					.where(
						and(
							inJsonList(marketingMessages.id, sentIds),
							eq(marketingMessages.status, 'Processing'),
						),
					)
			}
			if (failedIds.length > 0) {
				await db
					.update(marketingMessages)
					.set({ status: 'Failed' })
					.where(
						and(
							inJsonList(marketingMessages.id, failedIds),
							eq(marketingMessages.status, 'Processing'),
						),
					)
			}
			// A batch went out and was recorded: earlier failed attempts were
			// transient. Only while we hold the lease (like `heartbeat` and
			// `finish`).
			if (
				!failuresReset &&
				sentIds.length > 0 &&
				campaign.dispatchFailures > 0
			) {
				await db
					.update(marketingCampaigns)
					.set({ dispatchFailures: 0 })
					.where(holdsLease(campaignId, currentLease))
				failuresReset = true
			}
			if (capReached) {
				console.warn('Broadcast reached the hourly send cap; will resume', {
					orgId,
					campaignId,
				})
				return 'throttled'
			}
		}

		await finish(db, campaignId, currentLease, 'Completed')
		return 'completed'
	} catch (error) {
		console.error('Broadcast dispatch failed', {
			orgId,
			campaignId,
			reason: error instanceof Error ? error.message : 'unknown',
		})
		// An unexpected error (a database or storage blip) is usually
		// transient: leave the campaign `Processing`, so its lease goes stale
		// and a later tick resumes it. Message rows already written are never
		// resent. After `BROADCAST_MAX_FAILURES` failed attempts in a row the
		// campaign is marked `Failed`, so an error that never clears stops.
		try {
			const handle = db ?? (await getTenantDb(orgId))
			const [row] = await handle
				.update(marketingCampaigns)
				.set({
					dispatchFailures: sql`${marketingCampaigns.dispatchFailures} + 1`,
				})
				// A dispatcher that lost its lease must not count against the
				// campaign another one now holds.
				.where(holdsLease(campaignId, currentLease))
				.returning({ failures: marketingCampaigns.dispatchFailures })
			if (!row) return 'lost_lease'
			if (row.failures >= BROADCAST_MAX_FAILURES) {
				await finish(handle, campaignId, currentLease, 'Failed')
				return 'failed'
			}
		} catch {
			// The tick resumes a campaign left Processing.
		}
		return 'retry'
	}
}

async function sendOne(params: {
	orgId: string
	campaignId: string
	campaign: typeof marketingCampaigns.$inferSelect
	channel: 'email' | 'sms'
	consentOrigin: string | null
	messageId: string
	customer: Customer
}) {
	const { orgId, campaignId, campaign, customer, messageId } = params
	const parsedContent = interpolateMergeTags(campaign.content, customer, {})
	const parsedSubject = campaign.subject
		? interpolateMergeTags(campaign.subject, customer, {})
		: ''

	if (params.channel === 'email') {
		if (!customer.email) throw new Error('No email address')
		if (!params.consentOrigin) throw new Error('TENANT_API_URL is not set')
		// Every broadcast carries a signed unsubscribe link, in the body and as
		// List-Unsubscribe / one-click headers.
		const optOutUrl = unsubscribeUrl(params.consentOrigin, {
			orgId,
			customerId: customer.id,
			topic: BROADCAST_TOPIC,
		})
		const bodyHtml = campaign.contentHtml
			? interpolateMergeTagsHtml(campaign.contentHtml, customer, {})
			: `<p>${escapeHtml(parsedContent)}</p>`
		const emailRes = await sendTenantEmail({
			to: customer.email,
			toName: customer.name,
			subject: parsedSubject || 'Notification',
			text: `${parsedContent}\n\nUnsubscribe: ${optOutUrl}`,
			html: `${bodyHtml}<p style="font-size:12px;color:#666"><a href="${optOutUrl}">Unsubscribe</a></p>`,
			extraHeaders: listUnsubscribeHeaders(optOutUrl),
			context: { orgId, campaignId, customerId: customer.id, messageId },
		})
		if (emailRes.status === 'error') {
			throw new Error(emailRes.error.message)
		}
		return
	}
	if (!customer.phone) throw new Error('No phone number')
	await sendSms({ to: customer.phone, message: parsedContent })
}

/**
 * Claims a campaign for this dispatcher: a stale `Processing` one (its
 * dispatcher died or was throttled), or a scheduled one that is due. Returns
 * the lease, or null when someone else got it first.
 */
export async function claimBroadcast(
	db: Db,
	campaignId: string,
	now: number,
): Promise<Date | null> {
	const lease = toLease(now)
	const rows = await db
		.update(marketingCampaigns)
		.set({ status: 'Processing', updatedAt: lease })
		.where(
			and(
				eq(marketingCampaigns.id, campaignId),
				or(
					and(
						eq(marketingCampaigns.status, 'Processing'),
						lt(
							marketingCampaigns.updatedAt,
							new Date(now - BROADCAST_STALE_MS),
						),
					),
					and(
						eq(marketingCampaigns.status, 'Scheduled'),
						isNotNull(marketingCampaigns.scheduledAt),
						lte(marketingCampaigns.scheduledAt, new Date(now)),
					),
				),
			),
		)
		.returning({ id: marketingCampaigns.id })
	if (rows.length === 0) return null
	// A dispatch that died between writing a row and recording the outcome may
	// have sent it: never resend, record that the outcome is unknown.
	await db
		.update(marketingMessages)
		.set({ status: 'Unknown' })
		.where(
			and(
				eq(marketingMessages.campaignId, campaignId),
				eq(marketingMessages.status, 'Processing'),
			),
		)
	return lease
}

/**
 * Claims what the tick should send for an organization: stale `Processing`
 * broadcasts (their dispatcher died or was throttled) and scheduled ones that
 * are due, at most `MAX_CAMPAIGNS_PER_TICK`. Each returned lease is ours.
 */
export async function claimDueBroadcasts(db: Db, now: number) {
	const candidates = await db
		.select({ id: marketingCampaigns.id })
		.from(marketingCampaigns)
		.where(
			or(
				and(
					eq(marketingCampaigns.status, 'Processing'),
					lt(marketingCampaigns.updatedAt, new Date(now - BROADCAST_STALE_MS)),
				),
				and(
					eq(marketingCampaigns.status, 'Scheduled'),
					isNotNull(marketingCampaigns.scheduledAt),
					lte(marketingCampaigns.scheduledAt, new Date(now)),
				),
			),
		)
		.limit(MAX_CAMPAIGNS_PER_TICK)
		.all()

	const claimed: Array<{ id: string; lease: Date }> = []
	for (const { id } of candidates) {
		const lease = await claimBroadcast(db, id, now)
		if (lease) claimed.push({ id, lease })
	}
	return claimed
}

/**
 * One pass for an organization: resume stale `Processing` broadcasts and start
 * scheduled ones that are due, waiting for every dispatch to finish.
 */
export async function runBroadcastTick(
	orgId: string,
	db: Db,
	now: number,
	options: BroadcastDispatchOptions = {},
) {
	const outcomes: BroadcastDispatchOutcome[] = []
	for (const { id, lease } of await claimDueBroadcasts(db, now)) {
		outcomes.push(await dispatchBroadcast(orgId, id, lease, options))
	}
	return { claimed: outcomes.length, outcomes }
}

/**
 * When the tick next has broadcast work for this organization: the earliest
 * future `scheduledAt`, or when a `Processing` campaign's lease goes stale (a
 * throttled or interrupted send is resumed then; a live one keeps pushing its
 * lease forward and is simply checked again). Null when there is none. The
 * Durable Object runtime arms its alarm by it, so a scheduled broadcast does
 * not wait for the hourly cron.
 */
export async function nextBroadcastWakeAt(
	db: Db,
	now: number,
): Promise<number | null> {
	const [scheduled] = await db
		.select({ at: min(marketingCampaigns.scheduledAt) })
		.from(marketingCampaigns)
		.where(
			and(
				eq(marketingCampaigns.status, 'Scheduled'),
				isNotNull(marketingCampaigns.scheduledAt),
			),
		)
	const [processing] = await db
		.select({ at: min(marketingCampaigns.updatedAt) })
		.from(marketingCampaigns)
		.where(eq(marketingCampaigns.status, 'Processing'))
	const times = [
		scheduled?.at ? scheduled.at.getTime() : null,
		// One second past the stale line, so `claimBroadcast` sees it as stale.
		processing?.at ? processing.at.getTime() + BROADCAST_STALE_MS + 1000 : null,
	].filter((at): at is number => at !== null)
	if (times.length === 0) return null
	// Something already due (a claim lost to another dispatcher, or more than
	// `MAX_CAMPAIGNS_PER_TICK` due at once) is looked at again shortly.
	return Math.max(Math.min(...times), now + 1000)
}

export { toLease as broadcastLease }

/**
 * The broadcast pass of the regional tick for one organization. It only claims
 * the work: each claimed dispatch runs detached through `runDetached`
 * (`waitUntil` where the runtime has one), so one large campaign does not hold
 * the staff tick or the fan-out slot it runs in. A dispatch that dies with its
 * isolate is resumed by a later tick once its lease goes stale.
 *
 * Never throws: a broadcast failure must not stop the staff tick next to it.
 * Ids only in logs. Returns the number claimed and when to look again (see
 * `nextBroadcastWakeAt`), or null when the pass failed.
 */
export async function startBroadcastTickForOrg(
	orgId: string,
	options: {
		now?: number
		runDetached?: (task: Promise<unknown>) => void
	} = {},
): Promise<{ claimed: number; nextAt: number | null } | null> {
	const now = options.now ?? Date.now()
	try {
		const db = await getTenantDb(orgId)
		const claimed = await claimDueBroadcasts(db, now)
		for (const { id, lease } of claimed) {
			const task = dispatchBroadcast(orgId, id, lease).catch((error) => {
				console.error('Broadcast dispatch failed', {
					orgId,
					campaignId: id,
					reason: error instanceof Error ? error.name : 'unknown',
				})
			})
			options.runDetached?.(task)
		}
		return {
			claimed: claimed.length,
			nextAt: await nextBroadcastWakeAt(db, now),
		}
	} catch (error) {
		console.error('Broadcast tick failed', {
			orgId,
			reason: error instanceof Error ? error.name : 'unknown',
		})
		return null
	}
}
