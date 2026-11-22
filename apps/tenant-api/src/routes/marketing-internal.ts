import { randomUUID } from 'node:crypto'
import { and, gte, inArray, lte } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import {
	DEFAULT_LATE_AFTER_MINUTES,
	MAX_LATE_AFTER_MINUTES,
	MIN_LATE_AFTER_MINUTES,
} from '@repo/common/broadcast-checks'
import { emailBlocksSchema } from '@repo/common/email-blocks'
import {
	getTenantDb,
	marketingCampaigns,
	TENANT_ORG_ID_PATTERN,
} from '@repo/tenant-db'
import { errorLogFields } from '../lib/error-log.ts'
import { orgMatchesNodeRegion } from '../lib/region.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { getAudience } from '../services/marketing-audience-service.ts'

/**
 * `POST /api/marketing/campaigns/auto-schedule` (#152): the App's daily
 * occasion job creates a Scheduled broadcast here, authenticated with the
 * internal token (there is no operator in a job). The region checks, in one
 * place, that no other broadcast is scheduled or sending within 2 days of the
 * occasion or of the planned send (`occasion_conflict`: nothing is created) and
 * that a saved audience still exists; then it writes the Scheduled row, which
 * the operator can edit or cancel until the tick starts it. Guests are never
 * read or returned: only a campaign id and a code.
 */
export const marketingInternalRoutes = new Hono()

const DAY_MS = 24 * 60 * 60 * 1000

const bodySchema = z
	.object({
		orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
		name: z.string().trim().min(1).max(200),
		channel: z.enum(['email', 'sms']),
		subject: z.string().max(300).nullable().optional(),
		content: z.string().min(1).max(20_000),
		contentBlocks: z.string().max(500_000).nullable().optional(),
		contentHtml: z.string().max(500_000).nullable().optional(),
		/** A saved audience (#98); empty is everyone subscribed. */
		audienceId: z.string().min(1).max(100).nullable().optional(),
		scheduledAt: z.string().datetime(),
		lateAfterMinutes: z
			.number()
			.int()
			.min(MIN_LATE_AFTER_MINUTES)
			.max(MAX_LATE_AFTER_MINUTES)
			.optional(),
		/** The occasion's own date (`YYYY-MM-DD`) and how close another broadcast may be. */
		occasionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
		conflictDays: z.number().int().min(0).max(14).default(2),
	})
	.strict()

function unauthorized(c: Context) {
	const internalToken = getInternalCommandToken()
	if (internalToken.length < 16) {
		return c.json({ error: 'not_configured' }, 503)
	}
	const presented = getBearerToken(c.req.header('Authorization'))
	if (!presented || !timingSafeEqualString(presented, internalToken)) {
		return c.json({ error: 'Unauthorized' }, 401)
	}
	return null
}

marketingInternalRoutes.post('/campaigns/auto-schedule', async (c) => {
	const denied = unauthorized(c)
	if (denied) return denied
	const parsed = bodySchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
	const body = parsed.data

	const organization = await findActiveOrganizationById(body.orgId)
	if (!organization || !orgMatchesNodeRegion(organization.dataRegion)) {
		return c.json({ error: 'org_not_found' }, 404)
	}
	const scheduledAt = new Date(body.scheduledAt)
	if (scheduledAt.getTime() <= Date.now()) {
		return c.json({ error: 'scheduled_in_past' }, 400)
	}
	let blocks: unknown = null
	if (body.contentBlocks) {
		try {
			blocks = emailBlocksSchema.parse(JSON.parse(body.contentBlocks))
		} catch {
			return c.json({ error: 'invalid_request' }, 400)
		}
	}
	try {
		const db = await getTenantDb(body.orgId)
		let audienceVersion: number | undefined
		if (body.audienceId) {
			const audience = await getAudience(db, body.audienceId)
			if (!audience) return c.json({ error: 'audience_not_found' }, 404)
			audienceVersion = audience.version
		}

		// Conflict: another broadcast scheduled (or sending) within the window of
		// the occasion's day or of the planned send.
		const occasionMs = Date.parse(`${body.occasionDate}T12:00:00Z`)
		const window = body.conflictDays * DAY_MS
		const near = await db
			.select({ id: marketingCampaigns.id, at: marketingCampaigns.scheduledAt })
			.from(marketingCampaigns)
			.where(
				and(
					inArray(marketingCampaigns.status, ['Scheduled', 'Processing']),
					gte(
						marketingCampaigns.scheduledAt,
						new Date(Math.min(occasionMs, scheduledAt.getTime()) - window),
					),
					lte(
						marketingCampaigns.scheduledAt,
						new Date(Math.max(occasionMs, scheduledAt.getTime()) + window),
					),
				),
			)
			.all()
		const conflicting = near.filter((row) => {
			const at = row.at?.getTime()
			if (at === undefined) return false
			return (
				Math.abs(at - occasionMs) <= window ||
				Math.abs(at - scheduledAt.getTime()) <= window
			)
		})
		if (conflicting.length > 0) {
			return c.json({ error: 'occasion_conflict' }, 409)
		}

		const campaignId = randomUUID()
		await db.insert(marketingCampaigns).values({
			id: campaignId,
			name: body.name,
			channel: body.channel,
			subject: body.subject || null,
			content: body.content,
			contentBlocks: blocks ? JSON.stringify(blocks) : null,
			contentHtml: body.contentHtml || null,
			status: 'Scheduled',
			segmentationRules: JSON.stringify({
				audience: 'all',
				...(body.audienceId
					? { audienceId: body.audienceId, audienceVersion }
					: {}),
			}),
			scheduledAt,
			lateAfterMinutes: body.lateAfterMinutes ?? DEFAULT_LATE_AFTER_MINUTES,
		})
		return c.json({ campaignId }, 201)
	} catch (error) {
		console.error(
			'Occasion broadcast could not be scheduled',
			errorLogFields(error),
		)
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})
