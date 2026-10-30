import { and, count, desc, eq, inArray } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { jwtVerify } from 'jose'
import { randomUUID } from 'node:crypto'
import { brand } from '@repo/config/brand'
import { emailBlocksSchema } from '@repo/common/email-blocks'
import {
	getOciMarketingMetrics,
	isOciEngagementLoggingConfigured,
} from '@repo/email'
import { sendSms } from '@repo/sms'
import {
	customers,
	getTenantDb,
	interpolateMergeTags,
	interpolateMergeTagsHtml,
	marketingCampaigns,
	marketingMessages,
} from '@repo/tenant-db'
import { z } from 'zod'
import { errorLogFields } from '../lib/error-log.ts'
import { checkGlobalSendCap } from '../lib/rate-limit.ts'
import { getBearerToken, getOperatorToken } from '../lib/secrets.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { ensureEmailEngagementSynced } from '../services/email-engagement-sync.ts'
import {
	erasePerson,
	PersonErasureError,
} from '../services/person-erasure-service.ts'
import {
	consentBaseUrl,
	listUnsubscribeHeaders,
	unsubscribeUrl,
} from '../lib/email-consent.ts'
import {
	BROADCAST_TOPIC,
	loadBroadcastAudience,
} from '../services/marketing-audience.ts'
import { inJsonList } from '../lib/chunked-in.ts'
import { insertRowsInChunks } from '../lib/chunked-in.ts'

export const operatorRoutes = new Hono()

const OPERATOR_LIST_LIMIT = 100

// The fallback email body wraps plain text that contains customer-controlled
// merge-tag values (names), so it must be escaped before becoming HTML.
function escapeHtml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

export async function authenticateOperator(
	c: Context,
	scope?: 'mailbox' | 'phone_calls' | 'people',
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
		canUpdate?: boolean
		canDelete?: boolean
		/** `people` scope: holds the Customers (contact, orders, consent) facet. */
		peopleCustomers?: boolean
		/** `people` scope: reservation guest facet, `flags` (counters) or `full`. */
		peopleDining?: string
		/** `people` scope: may edit the dining facet (`update:reservation_guest:any`). */
		canUpdateGuest?: boolean
	}
	try {
		const secret = new TextEncoder().encode(operatorToken)
		const { payload } = await jwtVerify(token, secret, {
			audience: 'tenant-api-operator',
			issuer: brand.shortName,
			algorithms: ['HS256'],
		})
		decoded = payload as typeof decoded
	} catch (error) {
		console.error('Operator token verification failed:', error)
		throw c.json({ error: 'Unauthorized' }, 401)
	}

	if (
		!decoded.orgId ||
		decoded.role !== 'operator' ||
		decoded.scope !== scope
	) {
		throw c.json({ error: 'Unauthorized' }, 401)
	}

	return decoded
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
		auth = await authenticateOperator(c)
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
		auth = await authenticateOperator(c)
	} catch (response) {
		return response as Response
	}

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
		auth = await authenticateOperator(c)
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
				error.status as 400 | 502,
			)
		}
		console.error('Error erasing customer:', errorLogFields(error))
		return c.json({ error: 'Tenant Database unavailable' }, 500)
	}
})

operatorRoutes.get('/marketing/metrics', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c)
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
		auth = await authenticateOperator(c)
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
		auth = await authenticateOperator(c)
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
		auth = await authenticateOperator(c)
	} catch (response) {
		return response as Response
	}

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
		const status = isScheduled ? 'Draft' : 'Processing'

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
		})

		if (!isScheduled) {
			void dispatchCampaign(orgId, campaignId)
		}

		return c.json({ success: true, campaignId, status })
	} catch (error) {
		console.error('Error creating campaign:', error)
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

async function dispatchCampaign(orgId: string, campaignId: string) {
	try {
		const db = await getTenantDb(orgId)
		const campaignArr = await db
			.select()
			.from(marketingCampaigns)
			.where(eq(marketingCampaigns.id, campaignId))
			.all()
		const campaign = campaignArr[0]
		if (!campaign) return

		// 1. Fetch the consented audience (active subscription for this channel
		// and topic; texts also need a verified phone) and apply the rules.
		let rulesAudience: string | undefined
		if (campaign.segmentationRules) {
			try {
				const rules =
					typeof campaign.segmentationRules === 'string'
						? (JSON.parse(campaign.segmentationRules) as {
								audience?: string
							})
						: (campaign.segmentationRules as { audience?: string })
				rulesAudience = rules?.audience
			} catch {
				// Fallback to everyone subscribed
			}
		}
		const targetCustomers = await loadBroadcastAudience(db, {
			channel: campaign.channel === 'sms' ? 'sms' : 'email',
			audience: rulesAudience,
		})

		// Update target audience count
		await db
			.update(marketingCampaigns)
			.set({ targetAudienceCount: targetCustomers.length })
			.where(eq(marketingCampaigns.id, campaignId))

		let hitCap = false
		const BATCH_SIZE = 25

		// The unsubscribe link carries a signed token, so its origin must be the
		// configured one. Without it no email can go out: fail the campaign now,
		// before any per-recipient work, so the operator sees a Failed broadcast
		// instead of a Completed one that delivered nothing. The campaign row has
		// no reason column, so the generic reason goes to the log (ids only).
		const consentOrigin = campaign.channel === 'email' ? consentBaseUrl() : null
		if (campaign.channel === 'email' && !consentOrigin) {
			console.error('Broadcast failed: TENANT_API_URL is not set', {
				orgId,
				campaignId,
			})
			await db
				.update(marketingCampaigns)
				.set({ status: 'Failed' })
				.where(eq(marketingCampaigns.id, campaignId))
			return
		}

		// 2. Dispatch in concurrency batches
		for (let i = 0; i < targetCustomers.length; i += BATCH_SIZE) {
			const chunk = targetCustomers.slice(i, i + BATCH_SIZE)

			// Enforce the global send cap to prevent runaway Twilio/OCI costs.
			const cap = checkGlobalSendCap()
			if (cap.limited) {
				console.warn(
					`Campaign dispatch for ${campaignId} hit the global send cap; stopping early.`,
				)
				hitCap = true
				break
			}

			// Pre-generate message IDs and bulk insert Processing rows
			const chunkItems = chunk.map((customer) => ({
				messageId: randomUUID(),
				customer,
			}))

			await insertRowsInChunks(
				marketingMessages,
				chunkItems.map((item) => ({
					id: item.messageId,
					campaignId,
					customerId: item.customer.id,
					status: 'Processing',
				})),
				(part) => db.insert(marketingMessages).values(part),
			)

			// Process sends concurrently across the batch
			const results = await Promise.allSettled(
				chunkItems.map(async ({ messageId, customer }) => {
					// Templating engine via standard interpolateMergeTags
					const parsedContent = interpolateMergeTags(
						campaign.content,
						customer,
						{},
					)
					const parsedSubject = campaign.subject
						? interpolateMergeTags(campaign.subject, customer, {})
						: ''

					if (campaign.channel === 'email') {
						if (!customer.email) throw new Error('No email address')
						// Every broadcast carries a signed unsubscribe link, in the
						// body and as List-Unsubscribe / one-click headers.
						if (!consentOrigin) throw new Error('TENANT_API_URL is not set')
						const optOutUrl = unsubscribeUrl(consentOrigin, {
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
							context: {
								orgId,
								campaignId,
								customerId: customer.id,
								messageId,
							},
						})
						if (emailRes.status === 'error') {
							throw new Error(emailRes.error.message)
						}
					} else if (campaign.channel === 'sms') {
						if (!customer.phone) throw new Error('No phone number')
						await sendSms({
							to: customer.phone,
							message: parsedContent,
						})
					}
					return messageId
				}),
			)

			const sentIds: string[] = []
			const failedIds: string[] = []

			results.forEach((res, idx) => {
				const id = chunkItems[idx]!.messageId
				if (res.status === 'fulfilled') {
					sentIds.push(id)
				} else {
					console.error(
						`Failed to send to customer ${chunkItems[idx]!.customer.id}`,
						res.reason,
					)
					failedIds.push(id)
				}
			})

			// Bulk update outcomes for the batch
			if (sentIds.length > 0) {
				await db
					.update(marketingMessages)
					.set({ status: 'Sent', sentAt: new Date() })
					.where(inJsonList(marketingMessages.id, sentIds))
			}
			if (failedIds.length > 0) {
				await db
					.update(marketingMessages)
					.set({ status: 'Failed' })
					.where(inJsonList(marketingMessages.id, failedIds))
			}
		}

		// If hit send cap, mark any remaining processing messages as failed
		if (hitCap) {
			await db
				.update(marketingMessages)
				.set({ status: 'Failed' })
				.where(
					and(
						eq(marketingMessages.campaignId, campaignId),
						eq(marketingMessages.status, 'Processing'),
					),
				)
		}

		// Mark status
		await db
			.update(marketingCampaigns)
			.set({ status: hitCap ? 'Failed' : 'Completed' })
			.where(eq(marketingCampaigns.id, campaignId))
	} catch (error) {
		console.error(`Campaign dispatch failed for ${campaignId}`, error)
		try {
			const db = await getTenantDb(orgId)
			await db
				.update(marketingMessages)
				.set({ status: 'Failed' })
				.where(
					and(
						eq(marketingMessages.campaignId, campaignId),
						eq(marketingMessages.status, 'Processing'),
					),
				)
			await db
				.update(marketingCampaigns)
				.set({ status: 'Failed' })
				.where(eq(marketingCampaigns.id, campaignId))
		} catch (cleanupError) {
			console.error(
				'Failed to mark campaign and messages as failed:',
				cleanupError,
			)
		}
	}
}
