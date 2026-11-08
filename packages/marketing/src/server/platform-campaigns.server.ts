import { createId } from '@paralleldrive/cuid2'
import {
	db,
	desc,
	eq,
	lt,
	Organization,
	PlatformMarketingCampaign,
	PlatformMarketingMessage,
	User,
	UserOrganization,
} from '@repo/database'
import { getEmailProvider, sendEmail } from '@repo/email'
import { buildPlatformMarketingResendTags } from '@repo/config/marketing-email'
import { and } from 'drizzle-orm'
import {
	type CampaignDetail,
	type CampaignListItem,
	type CampaignRecipient,
	type CampaignStatus,
	type MarketingMetrics,
} from '../types/campaign.ts'
import {
	buildRecipientMergeTags,
	escapeHtml,
	interpolateMergeTags,
	interpolateMergeTagsHtml,
} from '../utils/merge-tags.ts'
import {
	createPlatformCampaignSchema,
	type CreatePlatformCampaignInput,
	type PlatformAudience,
} from '../types/platform.ts'
import { ensurePlatformEmailEngagementSynced } from './platform-oci-engagement-sync.server.ts'

async function maybeSyncPlatformEngagement() {
	if (getEmailProvider() === 'oci') {
		await ensurePlatformEmailEngagementSynced()
	}
}

export async function listPlatformCampaigns(): Promise<CampaignListItem[]> {
	const campaigns = await db
		.select()
		.from(PlatformMarketingCampaign)
		.orderBy(desc(PlatformMarketingCampaign.createdAt))

	return campaigns.map((campaign) => ({
		id: campaign.id,
		name: campaign.name,
		status: campaign.status as CampaignStatus,
		channel: campaign.channel as CampaignListItem['channel'],
		targetAudienceCount: campaign.targetAudienceCount,
		createdAt: campaign.createdAt,
		scheduledAt: campaign.scheduledAt,
	}))
}

export async function getPlatformCampaign(
	campaignId: string,
): Promise<CampaignDetail | null> {
	await maybeSyncPlatformEngagement()

	const [campaign] = await db
		.select()
		.from(PlatformMarketingCampaign)
		.where(eq(PlatformMarketingCampaign.id, campaignId))

	if (!campaign) return null

	const messages = await db
		.select({
			id: PlatformMarketingMessage.id,
			status: PlatformMarketingMessage.status,
			sentAt: PlatformMarketingMessage.sentAt,
			openedAt: PlatformMarketingMessage.openedAt,
			clickedAt: PlatformMarketingMessage.clickedAt,
			name: User.name,
			email: User.email,
		})
		.from(PlatformMarketingMessage)
		.innerJoin(User, eq(PlatformMarketingMessage.userId, User.id))
		.where(eq(PlatformMarketingMessage.campaignId, campaignId))

	const recipients: CampaignRecipient[] = messages.map((message) => ({
		id: message.id,
		name: message.name,
		email: message.email,
		status: message.status,
		sentAt: message.sentAt,
		openedAt: message.openedAt,
		clickedAt: message.clickedAt,
	}))

	return {
		id: campaign.id,
		name: campaign.name,
		status: campaign.status as CampaignStatus,
		channel: campaign.channel as CampaignDetail['channel'],
		subject: campaign.subject,
		content: campaign.content,
		contentBlocks: campaign.contentBlocks,
		contentHtml: campaign.contentHtml,
		targetAudienceCount: campaign.targetAudienceCount,
		audience: campaign.audience,
		createdAt: campaign.createdAt,
		scheduledAt: campaign.scheduledAt,
		recipients,
		// Once the campaign is no longer sending, a Processing row is a send
		// whose outcome was never recorded.
		unconfirmedRecipientCount:
			campaign.status === 'Processing'
				? 0
				: recipients.filter((recipient) => recipient.status === 'Processing')
						.length,
	}
}

export async function getPlatformMarketingMetrics(): Promise<MarketingMetrics> {
	await maybeSyncPlatformEngagement()

	const campaigns = await db.select().from(PlatformMarketingCampaign)
	const messages = await db.select().from(PlatformMarketingMessage)

	const emailsSent = messages.filter((message) =>
		['Sent', 'Opened', 'Clicked'].includes(message.status),
	).length
	const openCount = messages.filter((message) =>
		['Opened', 'Clicked'].includes(message.status),
	).length
	const clickCount = messages.filter(
		(message) => message.status === 'Clicked',
	).length
	const activeCampaigns = campaigns.filter((c) =>
		['Processing', 'Scheduled'].includes(c.status),
	).length

	const openRate = emailsSent > 0 ? (openCount / emailsSent) * 100 : 0
	const clickRate = emailsSent > 0 ? (clickCount / emailsSent) * 100 : 0

	return {
		emailsSent,
		openRate: openRate.toFixed(1),
		clickRate: clickRate.toFixed(1),
		activeCampaigns,
	}
}

/**
 * Keeps background work alive after the response. On Workers this is the
 * request's `ctx.waitUntil`; without one (Node) the promise simply runs.
 */
export type RunInBackground = (task: () => Promise<unknown>) => void

const runDetached: RunInBackground = (task) => {
	void task().catch((error: unknown) => {
		console.error('Platform campaign background work failed', error)
	})
}

export async function createPlatformCampaign(
	input: CreatePlatformCampaignInput,
	createdById?: string,
	options: {
		runInBackground?: RunInBackground
		dispatch?: PlatformDispatchOptions
	} = {},
) {
	const parsed = createPlatformCampaignSchema.parse(input)

	if (parsed.channel === 'email' && !parsed.subject) {
		throw new Error('Email campaigns require a subject')
	}

	if (parsed.audience === 'organization' && !parsed.targetOrganizationId) {
		throw new Error('Organization campaigns require a target organization')
	}

	const campaignId = createId()
	await db.insert(PlatformMarketingCampaign).values({
		id: campaignId,
		name: parsed.name,
		channel: parsed.channel,
		subject: parsed.subject || null,
		content: parsed.content,
		contentBlocks: parsed.contentBlocks || null,
		contentHtml: parsed.contentHtml || null,
		status: 'Processing',
		audience: parsed.audience,
		targetOrganizationId: parsed.targetOrganizationId || null,
		segmentationRules: JSON.stringify({ audience: parsed.audience }),
		createdById: createdById || null,
	})

	;(options.runInBackground ?? runDetached)(() =>
		dispatchPlatformCampaign(campaignId, options.dispatch),
	)

	return { campaignId, status: 'Processing' as const }
}

async function resolvePlatformRecipients(
	audience: PlatformAudience,
	targetOrganizationId?: string | null,
) {
	if (audience === 'organization') {
		// Never widen an organization-scoped campaign to every operator.
		if (!targetOrganizationId) return []
		const memberships = await db
			.select({
				userId: UserOrganization.userId,
				email: User.email,
				name: User.name,
				organizationName: Organization.name,
			})
			.from(UserOrganization)
			.innerJoin(User, eq(UserOrganization.userId, User.id))
			.innerJoin(
				Organization,
				eq(UserOrganization.organizationId, Organization.id),
			)
			.where(
				and(
					eq(UserOrganization.organizationId, targetOrganizationId),
					eq(UserOrganization.active, true),
					eq(User.isBanned, false),
				),
			)

		return memberships
	}

	const operators = await db
		.select({
			userId: UserOrganization.userId,
			email: User.email,
			name: User.name,
			organizationName: Organization.name,
		})
		.from(UserOrganization)
		.innerJoin(User, eq(UserOrganization.userId, User.id))
		.innerJoin(
			Organization,
			eq(UserOrganization.organizationId, Organization.id),
		)
		.where(and(eq(UserOrganization.active, true), eq(User.isBanned, false)))

	const uniqueByUser = new Map<string, (typeof operators)[number]>()
	for (const row of operators) {
		if (!uniqueByUser.has(row.userId)) {
			uniqueByUser.set(row.userId, row)
		}
	}

	return [...uniqueByUser.values()]
}

/** Sends in flight at once. Bounded so one campaign cannot exhaust the provider. */
export const PLATFORM_CAMPAIGN_SEND_CONCURRENCY = 5

/**
 * A Processing campaign whose row has not been touched for this long lost its
 * dispatcher (the Worker was cut off, a deploy, a crash). A live dispatch
 * bumps `updatedAt` before each send (at most every
 * `PLATFORM_CAMPAIGN_HEARTBEAT_MS`), and no send waits longer than
 * `PLATFORM_CAMPAIGN_SEND_TIMEOUT_MS`, so its longest silence is about 75
 * seconds and it never looks stale. Admin's cron runs the resume every five
 * minutes (see docs/scheduled-jobs.md).
 */
export const PLATFORM_CAMPAIGN_STALE_MS = 3 * 60 * 1000

/** How long one provider send may take before its outcome counts as unknown. */
export const PLATFORM_CAMPAIGN_SEND_TIMEOUT_MS = 60 * 1000

/** Minimum time between heartbeat writes during a dispatch. */
const PLATFORM_CAMPAIGN_HEARTBEAT_MS = 15 * 1000

export type PlatformDispatchOptions = {
	/** How long one provider send may take (default `PLATFORM_CAMPAIGN_SEND_TIMEOUT_MS`). */
	sendTimeoutMs?: number
	/**
	 * Stop starting new sends after this many milliseconds and hand the rest
	 * to the next resume. Set it where the runtime ends the work at a known
	 * time (a request's `waitUntil`, a cron invocation), so the dispatch stops
	 * between sends instead of being cut off in the middle of one, which would
	 * leave the recipient unconfirmed.
	 */
	budgetMs?: number
}

class SendTimeoutError extends Error {
	constructor(ms: number) {
		super(`Email provider did not answer within ${ms} ms`)
		this.name = 'SendTimeoutError'
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new SendTimeoutError(ms)), ms)
		}),
	]).finally(() => clearTimeout(timer))
}

/**
 * Message statuses that end a recipient's turn. `Processing` is included on
 * purpose: the row is written before the send, so a Processing row left by an
 * interrupted dispatch (or a send that timed out) means the outcome is unknown
 * and the email may well have gone out. Re-sending it would double-mail; it
 * is left for review, and a finished campaign reports it as unconfirmed
 * (`unconfirmedRecipientCount`).
 */
const RECIPIENT_HANDLED_STATUSES = new Set([
	'Processing',
	'Sent',
	'Opened',
	'Clicked',
	'Failed',
])

async function countUnconfirmedMessages(campaignId: string) {
	const rows = await db
		.select({ id: PlatformMarketingMessage.id })
		.from(PlatformMarketingMessage)
		.where(
			and(
				eq(PlatformMarketingMessage.campaignId, campaignId),
				eq(PlatformMarketingMessage.status, 'Processing'),
			),
		)
	return (rows ?? []).length
}

async function touchCampaign(campaignId: string) {
	await db
		.update(PlatformMarketingCampaign)
		.set({ updatedAt: new Date() })
		.where(eq(PlatformMarketingCampaign.id, campaignId))
}

/**
 * Marks a campaign that still has recipients to reach as stale right away, so
 * the next `resumeStalePlatformCampaigns` picks it up without waiting
 * `PLATFORM_CAMPAIGN_STALE_MS`. Only called once this dispatch has stopped.
 */
async function releaseForResume(campaignId: string) {
	await db
		.update(PlatformMarketingCampaign)
		.set({ updatedAt: new Date(0) })
		.where(
			and(
				eq(PlatformMarketingCampaign.id, campaignId),
				eq(PlatformMarketingCampaign.status, 'Processing'),
			),
		)
}

/**
 * Sends a platform campaign. Idempotent per (campaign, user): recipients who
 * already have a message row for this campaign are skipped, so resuming an
 * interrupted dispatch only reaches the users it never got to.
 *
 * Only an error before the first send (loading the campaign or its audience)
 * marks the campaign Failed. Once sending has started, a database error costs
 * at most one recipient: the campaign stays Processing and the stale resume
 * finishes it.
 */
export async function dispatchPlatformCampaign(
	campaignId: string,
	options: PlatformDispatchOptions = {},
) {
	const startedAt = Date.now()
	const sendTimeoutMs =
		options.sendTimeoutMs ?? PLATFORM_CAMPAIGN_SEND_TIMEOUT_MS
	const outOfBudget = () =>
		options.budgetMs !== undefined && Date.now() - startedAt >= options.budgetMs
	let sendingStarted = false
	try {
		const [found] = await db
			.select()
			.from(PlatformMarketingCampaign)
			.where(eq(PlatformMarketingCampaign.id, campaignId))

		if (!found) return
		if (found.status !== 'Processing') return
		// Captured after the check, so the send closure needs no assertion.
		const campaign = found

		const recipients = await resolvePlatformRecipients(
			campaign.audience as PlatformAudience,
			campaign.targetOrganizationId,
		)

		const existingMessages = await db
			.select({
				userId: PlatformMarketingMessage.userId,
				status: PlatformMarketingMessage.status,
			})
			.from(PlatformMarketingMessage)
			.where(eq(PlatformMarketingMessage.campaignId, campaignId))

		// The audience is counted once, when the first dispatch starts. A resume
		// re-reads the audience (to find who was never reached), but that later
		// count is not the audience the campaign was sent to.
		if ((existingMessages ?? []).length === 0) {
			await db
				.update(PlatformMarketingCampaign)
				.set({ targetAudienceCount: recipients.length })
				.where(eq(PlatformMarketingCampaign.id, campaignId))
		}
		const handledUserIds = new Set(
			(existingMessages ?? [])
				.filter((message) => RECIPIENT_HANDLED_STATUSES.has(message.status))
				.map((message) => message.userId),
		)
		const pending = recipients.filter(
			(recipient) => !handledUserIds.has(recipient.userId),
		)

		// Recipients whose message row could not be written. Nothing was sent
		// to them, so the campaign is left for a resume to reach them.
		let unclaimed = 0

		async function sendToRecipient(recipient: (typeof recipients)[number]) {
			const messageId = createId()
			// Written before the send: if the dispatch dies mid-send this row
			// stays Processing and a resume does not send to this user again.
			// The row is unique per (campaign, user): when another dispatch
			// already wrote it, that dispatch owns this recipient.
			let claimed: { id: string }[]
			try {
				claimed = await db
					.insert(PlatformMarketingMessage)
					.values({
						id: messageId,
						campaignId,
						userId: recipient.userId,
						status: 'Processing',
					})
					.onConflictDoNothing()
					.returning({ id: PlatformMarketingMessage.id })
			} catch (error) {
				unclaimed++
				console.error(
					`Platform campaign ${campaignId}: could not claim ${recipient.userId}; a resume will retry`,
					error,
				)
				return
			}
			if (claimed.length === 0) return

			const mergeTags = buildRecipientMergeTags({
				name: recipient.name,
				email: recipient.email,
				organizationName: recipient.organizationName,
			})
			const parsedContent = interpolateMergeTags(campaign.content, mergeTags)

			let deliveryStatus = 'Sent'
			let providerMessageId: string | null = null
			try {
				if (campaign.channel === 'email') {
					if (!recipient.email) throw new Error('No email address')
					const html = campaign.contentHtml
						? interpolateMergeTagsHtml(campaign.contentHtml, mergeTags)
						: `<p>${escapeHtml(parsedContent).replace(/\n/g, '<br/>')}</p>`

					const emailRes = await withTimeout(
						sendEmail({
							to: recipient.email,
							subject: interpolateMergeTags(
								campaign.subject || campaign.name,
								mergeTags,
							),
							text: parsedContent,
							html,
							tags: buildPlatformMarketingResendTags(messageId, campaignId),
						}),
						sendTimeoutMs,
					)
					if (emailRes.status === 'error') {
						throw new Error(emailRes.error.message)
					}
					providerMessageId = emailRes.data.id
				} else {
					deliveryStatus = 'Failed'
				}
			} catch (error) {
				if (error instanceof SendTimeoutError) {
					// The provider may still deliver it: the row stays Processing
					// (outcome unknown), so no resume sends it again.
					console.warn(
						`Platform campaign send to ${recipient.userId} timed out; left as unconfirmed`,
					)
					return
				}
				console.error(
					`Failed to send platform campaign to ${recipient.userId}`,
					error,
				)
				deliveryStatus = 'Failed'
			}

			await db
				.update(PlatformMarketingMessage)
				.set({
					status: deliveryStatus,
					sentAt: deliveryStatus === 'Sent' ? new Date() : null,
					providerMessageId:
						deliveryStatus === 'Sent' ? providerMessageId : null,
				})
				.where(eq(PlatformMarketingMessage.id, messageId))
		}

		// Heartbeat: keeps a live dispatch from looking stale to a resume. It
		// runs before each send, so the longest gap is one send, which the
		// timeout bounds. A failed write is retried before the next send; at
		// worst a resume starts alongside, and the per-user claim keeps that
		// from mailing anyone twice.
		let lastHeartbeat = 0
		async function heartbeat() {
			const now = Date.now()
			if (now - lastHeartbeat < PLATFORM_CAMPAIGN_HEARTBEAT_MS) return
			try {
				await touchCampaign(campaignId)
				lastHeartbeat = now
			} catch (error) {
				console.error(
					`Platform campaign ${campaignId}: heartbeat failed`,
					error,
				)
			}
		}

		// A pool rather than fixed batches: one slow send does not hold up
		// the others. An error is contained to its recipient: a row already
		// written stays Processing (reported as unconfirmed, never re-sent).
		let next = 0
		async function worker() {
			while (next < pending.length && !outOfBudget()) {
				const recipient = pending[next++]!
				await heartbeat()
				try {
					await sendToRecipient(recipient)
				} catch (error) {
					console.error(
						`Platform campaign ${campaignId}: lost the outcome for ${recipient.userId}; left as unconfirmed`,
						error,
					)
				}
			}
		}
		sendingStarted = true
		await Promise.all(
			Array.from(
				{
					length: Math.min(PLATFORM_CAMPAIGN_SEND_CONCURRENCY, pending.length),
				},
				worker,
			),
		)

		if (next < pending.length || unclaimed > 0) {
			console.warn(
				`Platform campaign ${campaignId} stopped with ${pending.length - next + unclaimed} recipient(s) left; handed to the next resume`,
			)
			await releaseForResume(campaignId)
			return
		}

		const unconfirmed = await countUnconfirmedMessages(campaignId)
		if (unconfirmed > 0) {
			console.warn(
				`Platform campaign ${campaignId} finished with ${unconfirmed} unconfirmed recipient(s) (left Processing by an interrupted or timed-out send)`,
			)
		}

		await db
			.update(PlatformMarketingCampaign)
			.set({ status: 'Completed' })
			.where(eq(PlatformMarketingCampaign.id, campaignId))
	} catch (error) {
		if (sendingStarted) {
			// Some recipients may already have the email: leave the campaign
			// Processing, and the stale resume reaches whoever is left.
			console.error(
				`Platform campaign dispatch for ${campaignId} stopped; left Processing for a resume`,
				error,
			)
			return
		}
		console.error(`Platform campaign dispatch failed for ${campaignId}`, error)
		await db
			.update(PlatformMarketingCampaign)
			.set({ status: 'Failed' })
			.where(eq(PlatformMarketingCampaign.id, campaignId))
			.catch((updateError: unknown) => {
				console.error(
					`Could not mark platform campaign ${campaignId} Failed`,
					updateError,
				)
			})
	}
}

/**
 * Restarts dispatch for campaigns stuck in Processing with no heartbeat for
 * `PLATFORM_CAMPAIGN_STALE_MS`. Each campaign is claimed with a conditional
 * update first, so two callers cannot both resume it. Resumed dispatch skips
 * every user who already has a message row, so nobody is mailed twice.
 */
export async function resumeStalePlatformCampaigns(
	options: {
		now?: Date
		runInBackground?: RunInBackground
		dispatch?: PlatformDispatchOptions
	} = {},
) {
	const now = options.now ?? new Date()
	const cutoff = new Date(now.getTime() - PLATFORM_CAMPAIGN_STALE_MS)
	const stale = await db
		.select({ id: PlatformMarketingCampaign.id })
		.from(PlatformMarketingCampaign)
		.where(
			and(
				eq(PlatformMarketingCampaign.status, 'Processing'),
				lt(PlatformMarketingCampaign.updatedAt, cutoff),
			),
		)

	const resumed: string[] = []
	for (const { id } of stale) {
		const claimed = await db
			.update(PlatformMarketingCampaign)
			.set({ updatedAt: now })
			.where(
				and(
					eq(PlatformMarketingCampaign.id, id),
					eq(PlatformMarketingCampaign.status, 'Processing'),
					lt(PlatformMarketingCampaign.updatedAt, cutoff),
				),
			)
			.returning({ id: PlatformMarketingCampaign.id })
		if (claimed.length === 0) continue
		resumed.push(id)
		;(options.runInBackground ?? runDetached)(() =>
			dispatchPlatformCampaign(id, options.dispatch),
		)
	}
	return { resumed }
}
