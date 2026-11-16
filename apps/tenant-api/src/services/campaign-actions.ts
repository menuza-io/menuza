import { randomUUID } from 'node:crypto'
import { and, count, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import {
	marketingCampaigns,
	marketingTestSends,
	type TenantDatabase,
} from '@repo/tenant-db'
import { broadcastLease } from './broadcast-dispatch.ts'

/**
 * What an operator can do with a broadcast after it exists (#101). Every status
 * change is one compare-and-set UPDATE on the status it expects, so it cannot
 * race the regional tick: a campaign the tick claimed (`Processing`) matches no
 * row, and the answer is `campaign_already_sending`, never a half-applied edit.
 * No mid-send stop: a `Processing` campaign cannot be edited, cancelled or
 * deleted.
 */

type Db = TenantDatabase

export type CampaignActionError =
	| 'not_found'
	| 'campaign_already_sending'
	| 'campaign_not_editable'
	| 'campaign_not_cancellable'
	| 'campaign_not_deletable'
	| 'scheduled_in_past'
	| 'retarget_not_supported'
	| 'campaign_not_completed'
	| 'retarget_too_early'
	| 'already_retargeted'

export type ActionResult<T> =
	{ ok: true; value: T } | { ok: false; error: CampaignActionError }

const fail = (error: CampaignActionError) => ({ ok: false as const, error })

/** A re-send to non-openers waits this long after the original finished. */
export const RETARGET_MIN_AGE_MS = 48 * 60 * 60 * 1000
/** Test sends per operator per rolling hour. */
export const TEST_SEND_LIMIT = { max: 10, windowMs: 60 * 60 * 1000 } as const

const EDITABLE = ['Draft', 'Scheduled'] as const
const DELETABLE = ['Draft', 'Cancelled'] as const

async function statusOf(db: Db, id: string) {
	const row = await db
		.select({ status: marketingCampaigns.status })
		.from(marketingCampaigns)
		.where(eq(marketingCampaigns.id, id))
		.get()
	return row?.status ?? null
}

/** Why a compare-and-set matched nothing. */
function refusal(
	status: string | null,
	fallback: CampaignActionError,
): CampaignActionError {
	if (status === null) return 'not_found'
	// The tick claimed it (or it is still sending): the one the operator can act on.
	return status === 'Processing' ? 'campaign_already_sending' : fallback
}

function isUniqueViolation(error: unknown) {
	const text = `${(error as Error)?.message ?? ''} ${(error as { cause?: Error })?.cause?.message ?? ''}`
	return /UNIQUE constraint failed/i.test(text)
}

export async function cancelCampaign(
	db: Db,
	id: string,
	now = Date.now(),
): Promise<ActionResult<{ status: 'Cancelled' }>> {
	const rows = await db
		.update(marketingCampaigns)
		.set({ status: 'Cancelled', updatedAt: new Date(now) })
		.where(
			and(
				eq(marketingCampaigns.id, id),
				inArray(marketingCampaigns.status, [...EDITABLE]),
			),
		)
		.returning({ id: marketingCampaigns.id })
	if (rows.length > 0) return { ok: true, value: { status: 'Cancelled' } }
	return fail(refusal(await statusOf(db, id), 'campaign_not_cancellable'))
}

export async function deleteCampaign(
	db: Db,
	id: string,
): Promise<ActionResult<true>> {
	const rows = await db
		.delete(marketingCampaigns)
		.where(
			and(
				eq(marketingCampaigns.id, id),
				inArray(marketingCampaigns.status, [...DELETABLE]),
			),
		)
		.returning({ id: marketingCampaigns.id })
	if (rows.length > 0) return { ok: true, value: true }
	return fail(refusal(await statusOf(db, id), 'campaign_not_deletable'))
}

/** A new Draft with the same message and audience; nothing scheduled, nothing linked. */
export async function duplicateCampaign(
	db: Db,
	id: string,
): Promise<ActionResult<{ campaignId: string }>> {
	const source = await db
		.select()
		.from(marketingCampaigns)
		.where(eq(marketingCampaigns.id, id))
		.get()
	if (!source) return fail('not_found')
	const campaignId = randomUUID()
	await db.insert(marketingCampaigns).values({
		id: campaignId,
		name: `${source.name} (copy)`.slice(0, 200),
		status: 'Draft',
		channel: source.channel,
		subject: source.subject,
		content: source.content,
		contentBlocks: source.contentBlocks,
		contentHtml: source.contentHtml,
		discountOffer: source.discountOffer,
		segmentationRules: source.segmentationRules,
		lateAfterMinutes: source.lateAfterMinutes,
		scheduledAt: null,
	})
	return { ok: true, value: { campaignId } }
}

/**
 * Re-send to non-openers: a linked Draft of a Completed email broadcast, once,
 * after 48 hours. The audience is not frozen here: the dispatcher picks the
 * customers with no open and no click who are still subscribed when it sends
 * (`loadBroadcastAudience` with `retargetOf`). SMS has no open signal, so no
 * re-send.
 */
export async function retargetCampaign(
	db: Db,
	id: string,
	options: { subject?: string | null; now?: number } = {},
): Promise<ActionResult<{ campaignId: string }>> {
	const now = options.now ?? Date.now()
	const source = await db
		.select()
		.from(marketingCampaigns)
		.where(eq(marketingCampaigns.id, id))
		.get()
	if (!source) return fail('not_found')
	if (source.channel !== 'email') return fail('retarget_not_supported')
	if (source.status !== 'Completed') return fail('campaign_not_completed')
	const finishedAt = source.updatedAt?.getTime() ?? now
	if (now - finishedAt < RETARGET_MIN_AGE_MS) return fail('retarget_too_early')

	const existing = await db
		.select({ id: marketingCampaigns.id })
		.from(marketingCampaigns)
		.where(eq(marketingCampaigns.retargetOfCampaignId, id))
		.get()
	if (existing) return fail('already_retargeted')

	const campaignId = randomUUID()
	try {
		await db.insert(marketingCampaigns).values({
			id: campaignId,
			name: `${source.name} (re-send)`.slice(0, 200),
			status: 'Draft',
			channel: 'email',
			subject: options.subject?.trim() || source.subject,
			content: source.content,
			contentBlocks: source.contentBlocks,
			contentHtml: source.contentHtml,
			discountOffer: source.discountOffer,
			segmentationRules: source.segmentationRules,
			lateAfterMinutes: source.lateAfterMinutes,
			retargetOfCampaignId: id,
			scheduledAt: null,
		})
	} catch (error) {
		// Two clicks at once: the unique index lets exactly one through.
		if (isUniqueViolation(error)) return fail('already_retargeted')
		throw error
	}
	return { ok: true, value: { campaignId } }
}

export type CampaignPatch = {
	name?: string
	audience?: 'all' | 'verified' | 'unverified'
	subject?: string | null
	content?: string
	contentBlocks?: string | null
	contentHtml?: string | null
	discountOffer?: string | null
	/** A future time schedules; null makes it a Draft again. */
	scheduledAt?: Date | null
	lateAfterMinutes?: number
	/** Start now: Draft or Scheduled becomes `Processing` under a new lease. */
	sendNow?: boolean
}

export type UpdatedCampaign = {
	status: 'Draft' | 'Scheduled' | 'Processing'
	/** The lease to dispatch under when `sendNow` started it. */
	lease: Date | null
}

/**
 * Edits a Draft or Scheduled campaign. The write and the status change are one
 * UPDATE guarded by the status that was read, so a tick that claims the
 * campaign in between makes this a no-op answered `campaign_already_sending`.
 */
export async function updateCampaign(
	db: Db,
	id: string,
	patch: CampaignPatch,
	now = Date.now(),
	hooks: {
		/** Test seam: runs between the read and the write, where the tick can strike. */
		afterRead?: () => Promise<void>
	} = {},
): Promise<ActionResult<UpdatedCampaign>> {
	const row = await db
		.select({
			status: marketingCampaigns.status,
			segmentationRules: marketingCampaigns.segmentationRules,
		})
		.from(marketingCampaigns)
		.where(eq(marketingCampaigns.id, id))
		.get()
	if (!row) return fail('not_found')
	if (row.status === 'Processing') return fail('campaign_already_sending')
	if (row.status !== 'Draft' && row.status !== 'Scheduled') {
		return fail('campaign_not_editable')
	}
	await hooks.afterRead?.()

	if (patch.scheduledAt && patch.scheduledAt.getTime() <= now) {
		return fail('scheduled_in_past')
	}

	let status: UpdatedCampaign['status'] = row.status
	let lease: Date | null = null
	if (patch.sendNow) {
		status = 'Processing'
		lease = broadcastLease(now)
	} else if (patch.scheduledAt) {
		status = 'Scheduled'
	} else if (patch.scheduledAt === null) {
		status = 'Draft'
	}

	const set: Partial<typeof marketingCampaigns.$inferInsert> = {
		status,
		updatedAt: lease ?? new Date(now),
	}
	if (patch.name !== undefined) set.name = patch.name
	if (patch.subject !== undefined) set.subject = patch.subject || null
	if (patch.content !== undefined) set.content = patch.content
	if (patch.contentBlocks !== undefined) set.contentBlocks = patch.contentBlocks
	if (patch.contentHtml !== undefined) set.contentHtml = patch.contentHtml
	if (patch.discountOffer !== undefined) set.discountOffer = patch.discountOffer
	if (patch.lateAfterMinutes !== undefined) {
		set.lateAfterMinutes = patch.lateAfterMinutes
	}
	if (patch.audience !== undefined) {
		// A JSON column: write the object, not a string of it.
		set.segmentationRules = { audience: patch.audience }
	}
	if (patch.sendNow) set.scheduledAt = null
	else if (patch.scheduledAt !== undefined) set.scheduledAt = patch.scheduledAt

	const rows = await db
		.update(marketingCampaigns)
		.set(set)
		.where(
			and(
				eq(marketingCampaigns.id, id),
				// Compare-and-set: still the status we read.
				eq(marketingCampaigns.status, row.status),
			),
		)
		.returning({ id: marketingCampaigns.id })
	if (rows.length === 0) {
		return fail(refusal(await statusOf(db, id), 'campaign_not_editable'))
	}
	return { ok: true, value: { status, lease } }
}

/**
 * Reserves one test send for an operator: refused at 10 in the last hour. One
 * INSERT ... SELECT guarded by the count, so two parallel sends at 9 cannot
 * both pass. The unit stays counted whether the send then works or not. The row
 * holds the control-plane user id, the channel and the time: never the address
 * or number the test goes to. Rows older than a day are pruned.
 */
export async function reserveTestSend(
	db: Db,
	operatorId: string,
	channel: 'email' | 'sms',
	now = Date.now(),
): Promise<boolean> {
	const { max, windowMs } = TEST_SEND_LIMIT
	const id = randomUUID()
	const sentAt = Math.floor(now / 1000)
	const cutoff = Math.floor((now - windowMs) / 1000)
	await db.run(sql`
		INSERT INTO marketing_test_sends (id, operator_id, channel, sent_at)
		SELECT ${id}, ${operatorId}, ${channel}, ${sentAt}
		WHERE (
			SELECT COUNT(*) FROM marketing_test_sends
			WHERE operator_id = ${operatorId} AND sent_at > ${cutoff}
		) < ${max}
	`)
	const reserved = await db
		.select({ id: marketingTestSends.id })
		.from(marketingTestSends)
		.where(eq(marketingTestSends.id, id))
		.get()
	// Housekeeping only; never fails the send.
	await db
		.delete(marketingTestSends)
		.where(lt(marketingTestSends.sentAt, new Date(now - 24 * 60 * 60 * 1000)))
		.catch(() => undefined)
	return Boolean(reserved)
}

/** Test sends this operator made in the last hour (for the tests and the UI hint). */
export async function testSendsInWindow(
	db: Db,
	operatorId: string,
	now = Date.now(),
): Promise<number> {
	const [row] = await db
		.select({ n: count() })
		.from(marketingTestSends)
		.where(
			and(
				eq(marketingTestSends.operatorId, operatorId),
				gt(marketingTestSends.sentAt, new Date(now - TEST_SEND_LIMIT.windowMs)),
			),
		)
	return row?.n ?? 0
}
