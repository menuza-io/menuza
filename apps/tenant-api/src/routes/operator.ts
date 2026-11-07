import { count, desc, eq, inArray } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { jwtVerify } from 'jose'
import { randomUUID } from 'node:crypto'
import { brand } from '@repo/config/brand'
import { emailBlocksSchema } from '@repo/common/email-blocks'
import {
	getOciMarketingMetrics,
	isOciEngagementLoggingConfigured,
} from '@repo/email'
import {
	customers,
	getTenantDb,
	marketingCampaigns,
	marketingMessages,
} from '@repo/tenant-db'
import { z } from 'zod'
import { getBearerToken, getOperatorToken } from '../lib/secrets.ts'
import {
	broadcastLease,
	dispatchBroadcast,
} from '../services/broadcast-dispatch.ts'
import { ensureEmailEngagementSynced } from '../services/email-engagement-sync.ts'
import {
	erasePerson,
	PersonErasureError,
} from '../services/person-erasure-service.ts'

export const operatorRoutes = new Hono()

const OPERATOR_LIST_LIMIT = 100

/**
 * Browser-held operator tokens name the one area they were minted for (the
 * App checks a different permission per page). A token with an `area` is
 * accepted only by routes that pass that same area, so the weakest page's
 * permission cannot unlock another area's routes. Tokens without an `area` are
 * the server-side ones App signs per request and never hands to a browser.
 *
 * This is the only verifier for `tenant-api-operator` tokens: every
 * `/operator/*` route except the staffing ones (their own audience, see
 * `lib/staff-auth.ts`) must authenticate here, so a token bound to an area or
 * a scope is refused by default on any route that does not name it
 * (`operator.area-binding.test.ts` walks every route).
 */
export type OperatorArea = 'marketing' | 'customers'

export async function authenticateOperator(
	c: Context,
	scope?: 'mailbox' | 'phone_calls',
	area?: OperatorArea,
) {
	const token = getBearerToken(c.req.header('Authorization')) || null
	if (!token) {
		throw c.json({ error: 'Unauthorized' }, 401)
	}

	const operatorToken = getOperatorToken()
	if (operatorToken.length < 16) {
		throw c.json({ error: 'Not configured' }, 503)
	}

	let decoded: {
		orgId: string
		role: string
		sub?: string
		scope?: string
		area?: string
		canUpdate?: boolean
		canDelete?: boolean
	}
	try {
		const secret = new TextEncoder().encode(operatorToken)
		const { payload } = await jwtVerify(token, secret, {
			audience: 'tenant-api-operator',
			issuer: brand.shortName,
			algorithms: ['HS256'],
			requiredClaims: ['exp'],
		})
		decoded = payload as typeof decoded
	} catch (error) {
		console.error('Operator token verification failed:', error)
		throw c.json({ error: 'Unauthorized' }, 401)
	}

	if (
		!decoded.orgId ||
		decoded.role !== 'operator' ||
		decoded.scope !== scope ||
		(decoded.area !== undefined && decoded.area !== area)
	) {
		throw c.json({ error: 'Unauthorized' }, 401)
	}

	return decoded
}

/**
 * Refuses a write unless the token carries the claim App mints only for people
 * who hold the matching update or delete permission. A token without it (the
 * read-only one a browser may hold) can list but not change anything.
 */
export function requireOperatorClaim(
	c: Context,
	auth: { canUpdate?: boolean; canDelete?: boolean },
	claim: 'canUpdate' | 'canDelete',
) {
	return auth[claim] === true ? null : c.json({ error: 'Forbidden' }, 403)
}

const updateCustomerSchema = z.object({
	name: z.string().min(1, 'Name is required').max(100, 'Name is too long'),
	email: z
		.string()
		.email('Invalid email address')
		.nullable()
		.optional()
		.transform((val) => val || null),
})

operatorRoutes.get('/customers', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'customers')
	} catch (response) {
		return response as Response
	}

	const { orgId } = auth
	try {
		const db = await getTenantDb(orgId)
		const page = Math.max(
			1,
			Number.parseInt(c.req.query('page') || '1', 10) || 1,
		)
		const limit = Math.min(
			500,
			Math.max(1, Number.parseInt(c.req.query('limit') || '100', 10) || 100),
		)
		const offset = (page - 1) * limit

		const [totalCountResult] = await db
			.select({ value: count() })
			.from(customers)
		const orgCustomers = await db
			.select({
				id: customers.id,
				name: customers.name,
				email: customers.email,
				phone: customers.phone,
				phoneVerified: customers.phoneVerified,
				createdAt: customers.createdAt,
				updatedAt: customers.updatedAt,
			})
			.from(customers)
			.orderBy(desc(customers.createdAt), desc(customers.id))
			.limit(limit)
			.offset(offset)
			.all()

		return c.json({
			customers: orgCustomers,
			total: totalCountResult?.value ?? orgCustomers.length,
			page,
			limit,
		})
	} catch (error) {
		console.error('Error fetching customers:', error)
		return c.json({ error: 'Tenant Database unavailable' }, 500)
	}
})

operatorRoutes.patch('/customers/:customerId', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'customers')
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canUpdate')
	if (denied) return denied

	const { orgId } = auth
	const customerId = c.req.param('customerId')

	let body: z.infer<typeof updateCustomerSchema>
	try {
		body = updateCustomerSchema.parse(await c.req.json())
	} catch (error) {
		if (error instanceof z.ZodError) {
			return c.json(
				{ error: error.issues[0]?.message ?? 'Invalid request body' },
				400,
			)
		}
		return c.json({ error: 'Invalid request body' }, 400)
	}

	try {
		const db = await getTenantDb(orgId)
		const [updated] = await db
			.update(customers)
			.set({
				name: body.name,
				email: body.email,
				updatedAt: new Date(),
			})
			.where(eq(customers.id, customerId))
			.returning({
				id: customers.id,
				name: customers.name,
				email: customers.email,
				phone: customers.phone,
				phoneVerified: customers.phoneVerified,
				createdAt: customers.createdAt,
				updatedAt: customers.updatedAt,
			})

		if (!updated) {
			return c.json({ error: 'Customer not found' }, 404)
		}

		return c.json({ customer: updated })
	} catch (error) {
		console.error('Error updating customer:', error)
		return c.json({ error: 'Tenant Database unavailable' }, 500)
	}
})

/**
 * Erase everything the regional database holds about one customer (sessions,
 * subscriptions, saved cards, journeys, messages, calls, and the order and
 * form links). Needs a token minted with `canDelete`. Idempotent: an unknown or
 * already-erased customer answers 200 with `alreadyErased: true`, so the call
 * cannot be used to probe for ids.
 */
operatorRoutes.post('/customers/:customerId/erase', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'customers')
	} catch (response) {
		return response as Response
	}
	if (auth.canDelete !== true) {
		return c.json({ error: 'Forbidden' }, 403)
	}

	try {
		const db = await getTenantDb(auth.orgId)
		const result = await erasePerson(
			db,
			{ customerId: c.req.param('customerId') },
			{ actorId: auth.sub ?? 'operator' },
		)
		return c.json({ success: true, ...result })
	} catch (error) {
		if (error instanceof PersonErasureError) {
			return c.json(
				{ error: error.message, code: error.code, erased: error.erased },
				error.status,
			)
		}
		console.error('Error erasing customer:', error)
		return c.json({ error: 'Tenant Database unavailable' }, 500)
	}
})

operatorRoutes.get('/marketing/metrics', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}

	const { orgId } = auth
	try {
		await ensureEmailEngagementSynced(orgId)
		const db = await getTenantDb(orgId)

		// SQL aggregation using indexed marketing_messages.status column
		const [sentResult, openedResult, clickedResult, activeCampaigns] =
			await Promise.all([
				db
					.select({ count: count() })
					.from(marketingMessages)
					.where(
						inArray(marketingMessages.status, ['Sent', 'Opened', 'Clicked']),
					)
					.all(),
				db
					.select({ count: count() })
					.from(marketingMessages)
					.where(inArray(marketingMessages.status, ['Opened', 'Clicked']))
					.all(),
				db
					.select({ count: count() })
					.from(marketingMessages)
					.where(eq(marketingMessages.status, 'Clicked'))
					.all(),
				db
					.select({ count: count() })
					.from(marketingCampaigns)
					.where(eq(marketingCampaigns.status, 'Processing'))
					.all(),
			])

		const emailsSent = sentResult[0]?.count || 0
		const openCount = openedResult[0]?.count || 0
		const clickCount = clickedResult[0]?.count || 0

		let openRate = emailsSent > 0 ? (openCount / emailsSent) * 100 : 0
		let clickRate = emailsSent > 0 ? (clickCount / emailsSent) * 100 : 0
		let reportedEmailsSent = emailsSent

		const ociMetrics = await getOciMarketingMetrics()
		if (ociMetrics && !isOciEngagementLoggingConfigured()) {
			reportedEmailsSent = ociMetrics.emailsSent
			openRate = Number.parseFloat(ociMetrics.openRate)
			clickRate = Number.parseFloat(ociMetrics.clickRate)
		}

		return c.json({
			metrics: {
				emailsSent: reportedEmailsSent,
				openRate: openRate.toFixed(1),
				clickRate: clickRate.toFixed(1),
				activeCampaigns: activeCampaigns[0]?.count || 0,
			},
		})
	} catch (error) {
		console.error('Error fetching marketing metrics:', error)
		return c.json({ error: 'Tenant Database unavailable' }, 500)
	}
})

operatorRoutes.get('/marketing/campaigns', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}

	const { orgId } = auth
	try {
		const db = await getTenantDb(orgId)
		const [totalRow] = await db
			.select({ total: count() })
			.from(marketingCampaigns)
		const total = totalRow?.total ?? 0
		const campaigns = await db
			.select()
			.from(marketingCampaigns)
			.orderBy(desc(marketingCampaigns.createdAt))
			.limit(OPERATOR_LIST_LIMIT)
			.all()
		return c.json({
			campaigns,
			pagination: {
				limit: OPERATOR_LIST_LIMIT,
				total,
				truncated: total > OPERATOR_LIST_LIMIT,
			},
		})
	} catch (error) {
		console.error('Error fetching marketing campaigns:', error)
		return c.json({ error: 'Tenant Database unavailable' }, 500)
	}
})

operatorRoutes.get('/marketing/campaigns/:campaignId', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}

	const { orgId } = auth
	const campaignId = c.req.param('campaignId')

	try {
		await ensureEmailEngagementSynced(orgId)
		const db = await getTenantDb(orgId)
		const [campaign] = await db
			.select()
			.from(marketingCampaigns)
			.where(eq(marketingCampaigns.id, campaignId))

		if (!campaign) {
			return c.json({ error: 'Campaign not found' }, 404)
		}

		const recipients = await db
			.select({
				id: marketingMessages.id,
				status: marketingMessages.status,
				sentAt: marketingMessages.sentAt,
				openedAt: marketingMessages.openedAt,
				clickedAt: marketingMessages.clickedAt,
				name: customers.name,
				email: customers.email,
				phone: customers.phone,
			})
			.from(marketingMessages)
			.innerJoin(customers, eq(marketingMessages.customerId, customers.id))
			.where(eq(marketingMessages.campaignId, campaignId))
			.orderBy(desc(marketingMessages.sentAt))
			.limit(OPERATOR_LIST_LIMIT)

		const [recipientTotalRow] = await db
			.select({ total: count() })
			.from(marketingMessages)
			.where(eq(marketingMessages.campaignId, campaignId))
		const recipientTotal = recipientTotalRow?.total ?? 0

		const segmentationRules = campaign.segmentationRules as
			{ audience?: string } | null | undefined

		return c.json({
			campaign: {
				id: campaign.id,
				name: campaign.name,
				status: campaign.status,
				channel: campaign.channel,
				subject: campaign.subject,
				content: campaign.content,
				contentBlocks: campaign.contentBlocks,
				contentHtml: campaign.contentHtml,
				targetAudienceCount: campaign.targetAudienceCount,
				audience: segmentationRules?.audience ?? 'all',
				createdAt: campaign.createdAt,
				scheduledAt: campaign.scheduledAt,
				recipients,
				recipientsPagination: {
					limit: OPERATOR_LIST_LIMIT,
					total: recipientTotal,
					truncated: recipientTotal > OPERATOR_LIST_LIMIT,
				},
			},
		})
	} catch (error) {
		console.error('Error fetching marketing campaign:', error)
		return c.json({ error: 'Tenant Database unavailable' }, 500)
	}
})

const createCampaignSchema = z.object({
	name: z.string().trim().min(1, 'Name is required').max(200),
	channel: z.enum(['email', 'sms']),
	audience: z.enum(['all', 'verified', 'unverified']).default('all'),
	subject: z.string().max(300).optional(),
	content: z.string().min(1, 'Content is required').max(20_000),
	/** JSON array of email designer blocks (source of truth for re-editing). */
	contentBlocks: z
		.string()
		.transform((value, context) => {
			try {
				return emailBlocksSchema.parse(JSON.parse(value))
			} catch {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'Invalid email blocks',
				})
				return z.NEVER
			}
		})
		.optional()
		.nullable(),
	/** Design-time rendered HTML for email broadcasts. */
	contentHtml: z.string().max(500_000).optional().nullable(),
	scheduledAt: z.string().datetime().optional().nullable(),
})

operatorRoutes.post('/marketing/campaigns', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canUpdate')
	if (denied) return denied

	const { orgId } = auth
	let body: z.infer<typeof createCampaignSchema>
	try {
		body = createCampaignSchema.parse(await c.req.json())
	} catch (error) {
		if (error instanceof z.ZodError) {
			return c.json(
				{ error: error.issues[0]?.message ?? 'Invalid request body' },
				400,
			)
		}
		return c.json({ error: 'Invalid request body' }, 400)
	}

	const { name, channel, audience, subject, content, scheduledAt } = body
	if (channel === 'sms' && audience === 'unverified') {
		return c.json(
			{ error: 'SMS campaigns can only target verified customers' },
			400,
		)
	}

	try {
		const db = await getTenantDb(orgId)
		const campaignId = randomUUID()
		const isScheduled = scheduledAt && new Date(scheduledAt) > new Date()
		// A scheduled broadcast is started by the regional tick once it is due.
		const status = isScheduled ? 'Scheduled' : 'Processing'
		const lease = broadcastLease(Date.now())

		await db.insert(marketingCampaigns).values({
			id: campaignId,
			name,
			channel,
			subject: subject || null,
			content,
			contentBlocks: body.contentBlocks
				? JSON.stringify(body.contentBlocks)
				: null,
			contentHtml: body.contentHtml || null,
			status,
			segmentationRules: JSON.stringify({ audience }),
			scheduledAt: isScheduled ? new Date(scheduledAt) : null,
			updatedAt: lease,
		})

		if (!isScheduled) {
			// The tick resumes it if this isolate stops mid-send.
			void dispatchBroadcast(orgId, campaignId, lease)
		}

		return c.json({ success: true, campaignId, status })
	} catch (error) {
		console.error('Error creating campaign:', error)
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})
