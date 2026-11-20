import { marketingPushContentSchema } from '@repo/common/push'
import { pushGate } from '../services/push-service.ts'
import { count, desc, eq, inArray } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { jwtVerify } from 'jose'
import { randomUUID } from 'node:crypto'
import { brand } from '@repo/config/brand'
import { emailBlocksSchema } from '@repo/common/email-blocks'
import {
	DEFAULT_LATE_AFTER_MINUTES,
	MAX_LATE_AFTER_MINUTES,
	MIN_LATE_AFTER_MINUTES,
} from '@repo/common/broadcast-checks'
import {
	UNSUBSCRIBE_PREVIEW_HREF,
	withUnsubscribeFooter,
} from '@repo/common/email-unsubscribe'
import {
	discountUsedInQuerySchema,
	marketingOfferSchema,
	parseMarketingOffer,
	usesCouponCodeTag,
} from '@repo/discounts'
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
import { runInBackground } from '../lib/background.ts'
import { errorLogFields } from '../lib/error-log.ts'
import { getBearerToken, getOperatorToken } from '../lib/secrets.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import {
	audienceIdRule,
	audienceRule,
	broadcastLease,
	dispatchBroadcast,
} from '../services/broadcast-dispatch.ts'
import {
	cancelCampaign,
	deleteCampaign,
	duplicateCampaign,
	reserveTestSend,
	retargetCampaign,
	updateCampaign,
	type CampaignActionError,
} from '../services/campaign-actions.ts'
import { ensureEmailEngagementSynced } from '../services/email-engagement-sync.ts'
import { findDiscountUsedIn } from '../services/discount-used-in.ts'
import { loadBroadcastAudience } from '../services/marketing-audience.ts'
import { audienceOutOfScope } from '../services/marketing-audience-rules.ts'
import {
	getAudience,
	resolveAudienceWhere,
} from '../services/marketing-audience-service.ts'
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
export type OperatorArea = 'marketing' | 'customers' | 'automations'

export async function authenticateOperator(
	c: Context,
	scope?: 'mailbox' | 'phone_calls' | 'people' | 'funnel',
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
		/** `people` scope: holds the Customers (contact, orders, consent) facet. */
		peopleCustomers?: boolean
		/** `people` scope: reservation guest facet, `flags` (counters) or `full`. */
		peopleDining?: string
		/** `people` scope: may edit the dining facet (`update:reservation_guest:any`). */
		canUpdateGuest?: boolean
		/** `people` scope: may record a guest's marketing consent (`update:marketing_consent:any`). */
		canUpdateMarketingConsent?: boolean
		/** Marketing test send: the operator's own address / number, server-minted only. */
		testEmail?: string
		testPhone?: string
		/** Location-scoped operators: the only places their audiences may look at. */
		locationIds?: string[]
		/**
		 * Minted only for members holding `read:form_restricted:any` (#357): may
		 * read, export and unrestrict responses of a restricted form.
		 */
		restrictedForms?: boolean
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

/**
 * The campaign without its recipients: no customer name, email or phone. The
 * App server reads this (for the coupon description and the breadcrumb); the
 * recipient list is read by the browser from the detail route below.
 */
operatorRoutes.get('/marketing/campaigns/:campaignId/summary', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}

	try {
		const db = await getTenantDb(auth.orgId)
		const [campaign] = await db
			.select({
				id: marketingCampaigns.id,
				name: marketingCampaigns.name,
				discountOffer: marketingCampaigns.discountOffer,
			})
			.from(marketingCampaigns)
			.where(eq(marketingCampaigns.id, c.req.param('campaignId')))

		if (!campaign) {
			return c.json({ error: 'Campaign not found' }, 404)
		}

		return c.json({
			campaign: {
				id: campaign.id,
				name: campaign.name,
				discountOffer: parseMarketingOffer(campaign.discountOffer),
			},
		})
	} catch (error) {
		console.error('Error fetching marketing campaign summary:', error)
		return c.json({ error: 'Tenant Database unavailable' }, 500)
	}
})

/**
 * The message and its settings, never a recipient (#101): what the App reads to
 * prefill the edit page and to build a re-send. Separate from the summary above,
 * whose shape is pinned to id, name and coupon.
 */
operatorRoutes.get('/marketing/campaigns/:campaignId/message', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}

	try {
		const db = await getTenantDb(auth.orgId)
		const [campaign] = await db
			.select()
			.from(marketingCampaigns)
			.where(eq(marketingCampaigns.id, c.req.param('campaignId')))
		if (!campaign) {
			return c.json({ error: 'Campaign not found' }, 404)
		}
		const retargetedBy = await db
			.select({ id: marketingCampaigns.id })
			.from(marketingCampaigns)
			.where(eq(marketingCampaigns.retargetOfCampaignId, campaign.id))
			.get()
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
				discountOffer: parseMarketingOffer(campaign.discountOffer),
				pushImageUrl: campaign.pushImageUrl,
				pushLink: campaign.pushLink,
				audience: audienceRule(campaign.segmentationRules) ?? 'all',
				audienceId: audienceIdRule(campaign.segmentationRules) ?? null,
				scheduledAt: campaign.scheduledAt,
				lateAfterMinutes: campaign.lateAfterMinutes,
				retargetOfCampaignId: campaign.retargetOfCampaignId,
				retargetedByCampaignId: retargetedBy?.id ?? null,
				updatedAt: campaign.updatedAt,
			},
		})
	} catch (error) {
		console.error('Error fetching marketing campaign message:', error)
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

		const retargetedBy = await db
			.select({ id: marketingCampaigns.id })
			.from(marketingCampaigns)
			.where(eq(marketingCampaigns.retargetOfCampaignId, campaign.id))
			.get()

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
				discountOffer: parseMarketingOffer(campaign.discountOffer),
				targetAudienceCount: campaign.targetAudienceCount,
				audience: audienceRule(campaign.segmentationRules) ?? 'all',
				audienceId: audienceIdRule(campaign.segmentationRules) ?? null,
				createdAt: campaign.createdAt,
				scheduledAt: campaign.scheduledAt,
				lateAfterMinutes: campaign.lateAfterMinutes,
				retargetOfCampaignId: campaign.retargetOfCampaignId,
				retargetedByCampaignId: retargetedBy?.id ?? null,
				updatedAt: campaign.updatedAt,
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
	channel: z.enum(['email', 'sms', 'push']),
	audience: z.enum(['all', 'verified', 'unverified']).default('all'),
	/** A saved audience (#98): narrows the consented guests, never widens them. */
	audienceId: z.string().min(1).max(100).optional().nullable(),
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
	/**
	 * The coupon `{{couponCode}}` shows. The App checks the discount belongs to
	 * the organization and takes codes before it sends this.
	 */
	discountOffer: marketingOfferSchema.optional().nullable(),
	/** Push (#105): the image and the site page a tap opens. `subject` is the title. */
	pushImageUrl: z.string().max(600).optional().nullable(),
	pushLink: z.string().max(300).optional().nullable(),
	scheduledAt: z.string().datetime().optional().nullable(),
	/** Keep it as a Draft: nothing is scheduled or sent (#101). */
	saveAsDraft: z.boolean().optional(),
	/** "Don't send if more than N minutes late" (#232), 1 to 72 hours. */
	lateAfterMinutes: z
		.number()
		.int()
		.min(MIN_LATE_AFTER_MINUTES)
		.max(MAX_LATE_AFTER_MINUTES)
		.optional(),
})

/** What the browser reads for a refused campaign action (the App maps the code). */
const ACTION_STATUS: Record<CampaignActionError, 400 | 404 | 409> = {
	not_found: 404,
	campaign_already_sending: 409,
	campaign_not_editable: 409,
	campaign_not_cancellable: 409,
	campaign_not_deletable: 409,
	scheduled_in_past: 400,
	retarget_not_supported: 400,
	campaign_not_completed: 409,
	retarget_too_early: 409,
	already_retargeted: 409,
}

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
	if (channel === 'push') {
		// A push holds no personal data and goes only to guests who opted in to
		// Offers and news in the app (#105): flag `marketing.push`, words written
		// once for everyone, no merge tags, no coupon, no phone-based audience.
		const gate = await pushGate(orgId, { marketing: true })
		if (!gate.ok) return c.json({ error: gate.code }, 409)
		const content_ = marketingPushContentSchema.safeParse({
			title: subject ?? '',
			body: content,
			imageUrl: body.pushImageUrl || undefined,
			link: body.pushLink || undefined,
		})
		if (!content_.success) {
			return c.json(
				{ error: content_.error.issues[0]?.message ?? 'Invalid push' },
				400,
			)
		}
		if (audience !== 'all') {
			return c.json({ error: 'push_audience_not_supported' }, 400)
		}
		if (body.discountOffer) {
			return c.json({ error: 'merge_tags_not_allowed' }, 400)
		}
	}
	if (channel === 'sms' && audience === 'unverified') {
		return c.json(
			{ error: 'SMS campaigns can only target verified customers' },
			400,
		)
	}
	const offer = body.discountOffer ?? null
	const usesTag = usesCouponCodeTag(
		content,
		channel === 'email' ? subject : null,
		channel === 'email' ? body.contentHtml : null,
	)
	if (usesTag && !offer) {
		return c.json(
			{ error: 'Choose a discount for the {{couponCode}} tag' },
			400,
		)
	}
	if (offer && !usesTag) {
		return c.json(
			{ error: 'Add the {{couponCode}} tag so customers see their code' },
			400,
		)
	}

	try {
		const db = await getTenantDb(orgId)
		const campaignId = randomUUID()
		let savedAudience: { id: string; version: number } | null = null
		if (body.audienceId) {
			const found = await getAudience(db, body.audienceId)
			if (!found) return c.json({ error: 'audience_not_found' }, 404)
			if (audienceOutOfScope(found.definition, auth.locationIds)) {
				return c.json({ error: 'location_out_of_scope' }, 403)
			}
			savedAudience = { id: found.id, version: found.version }
		}
		if (scheduledAt && new Date(scheduledAt).getTime() <= Date.now()) {
			return c.json({ error: 'scheduled_in_past' }, 400)
		}
		const isScheduled = Boolean(scheduledAt) && !body.saveAsDraft
		// A scheduled broadcast is started by the regional tick once it is due;
		// a Draft is never sent until the operator schedules or sends it.
		const status = body.saveAsDraft
			? 'Draft'
			: isScheduled
				? 'Scheduled'
				: 'Processing'
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
			discountOffer: offer ? JSON.stringify(offer) : null,
			pushImageUrl: channel === 'push' ? body.pushImageUrl || null : null,
			pushLink: channel === 'push' ? body.pushLink || null : null,
			status,
			segmentationRules: JSON.stringify({
				audience,
				...(savedAudience
					? {
							audienceId: savedAudience.id,
							audienceVersion: savedAudience.version,
						}
					: {}),
			}),
			scheduledAt: isScheduled ? new Date(scheduledAt!) : null,
			lateAfterMinutes: body.lateAfterMinutes ?? DEFAULT_LATE_AFTER_MINUTES,
			updatedAt: lease,
		})

		if (status === 'Processing') {
			// Kept alive past the response with the platform's waitUntil; the tick
			// resumes it if this isolate stops mid-send.
			startDispatch(orgId, campaignId, lease)
		}

		return c.json({ success: true, campaignId, status })
	} catch (error) {
		console.error('Error creating campaign:', error)
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

/** The two rules a message must hold to carry a coupon, as create checks them. */
function offerPairingError(input: {
	channel: 'email' | 'sms' | 'push'
	subject: string | null
	content: string
	contentHtml: string | null
	hasOffer: boolean
}) {
	const usesTag = usesCouponCodeTag(
		input.content,
		input.channel === 'email' ? input.subject : null,
		input.channel === 'email' ? input.contentHtml : null,
	)
	if (usesTag && !input.hasOffer) {
		return 'Choose a discount for the {{couponCode}} tag'
	}
	if (input.hasOffer && !usesTag) {
		return 'Add the {{couponCode}} tag so customers see their code'
	}
	return null
}

const updateCampaignSchema = z
	.object({
		name: z.string().trim().min(1).max(200).optional(),
		audience: z.enum(['all', 'verified', 'unverified']).optional(),
		/** A saved audience (#98); null goes back to the audience rule above. */
		audienceId: z.string().min(1).max(100).nullable().optional(),
		subject: z.string().max(300).nullable().optional(),
		content: z.string().min(1).max(20_000).optional(),
		contentBlocks: createCampaignSchema.shape.contentBlocks,
		contentHtml: z.string().max(500_000).nullable().optional(),
		discountOffer: marketingOfferSchema.nullable().optional(),
		pushImageUrl: z.string().max(600).nullable().optional(),
		pushLink: z.string().max(300).nullable().optional(),
		/** A future time schedules it; null makes it a Draft again. */
		scheduledAt: z.string().datetime().nullable().optional(),
		lateAfterMinutes: z
			.number()
			.int()
			.min(MIN_LATE_AFTER_MINUTES)
			.max(MAX_LATE_AFTER_MINUTES)
			.optional(),
		/** Start the send now (Draft or Scheduled becomes Processing). */
		sendNow: z.boolean().optional(),
	})
	.strict()

/**
 * Edit a Draft or Scheduled broadcast (#101). A campaign the tick has claimed
 * is refused `campaign_already_sending`; the write is one compare-and-set on
 * the status that was read, so it cannot race the tick.
 */
operatorRoutes.patch('/marketing/campaigns/:campaignId', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canUpdate')
	if (denied) return denied

	const { orgId } = auth
	const campaignId = c.req.param('campaignId')
	let body: z.infer<typeof updateCampaignSchema>
	try {
		body = updateCampaignSchema.parse(await c.req.json())
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
		const current = await db
			.select()
			.from(marketingCampaigns)
			.where(eq(marketingCampaigns.id, campaignId))
			.get()
		if (!current) return c.json({ error: 'not_found' }, 404)

		// Judge the message as it will be after the edit.
		const channel =
			current.channel === 'sms'
				? 'sms'
				: current.channel === 'push'
					? 'push'
					: 'email'
		const audience =
			body.audience ?? audienceRule(current.segmentationRules) ?? 'all'
		if (channel === 'sms' && audience === 'unverified') {
			return c.json(
				{ error: 'SMS campaigns can only target verified customers' },
				400,
			)
		}
		const offer =
			body.discountOffer === undefined
				? parseMarketingOffer(current.discountOffer)
				: body.discountOffer
		const pairing = offerPairingError({
			channel,
			subject: body.subject === undefined ? current.subject : body.subject,
			content: body.content ?? current.content,
			contentHtml:
				body.contentHtml === undefined ? current.contentHtml : body.contentHtml,
			hasOffer: Boolean(offer),
		})
		if (pairing) return c.json({ error: pairing }, 400)

		let audienceRef: { id: string; version: number } | null | undefined
		if (body.audienceId === null) audienceRef = null
		else if (body.audienceId) {
			const found = await getAudience(db, body.audienceId)
			if (!found) return c.json({ error: 'audience_not_found' }, 404)
			if (audienceOutOfScope(found.definition, auth.locationIds)) {
				return c.json({ error: 'location_out_of_scope' }, 403)
			}
			audienceRef = { id: found.id, version: found.version }
		}

		const result = await updateCampaign(db, campaignId, {
			name: body.name,
			audience: body.audience,
			audienceRef,
			subject: body.subject,
			content: body.content,
			contentBlocks:
				body.contentBlocks === undefined
					? undefined
					: body.contentBlocks
						? JSON.stringify(body.contentBlocks)
						: null,
			contentHtml: body.contentHtml,
			discountOffer:
				body.discountOffer === undefined
					? undefined
					: body.discountOffer
						? JSON.stringify(body.discountOffer)
						: null,
			pushImageUrl: body.pushImageUrl,
			pushLink: body.pushLink,
			scheduledAt:
				body.scheduledAt === undefined
					? undefined
					: body.scheduledAt
						? new Date(body.scheduledAt)
						: null,
			lateAfterMinutes: body.lateAfterMinutes,
			sendNow: body.sendNow,
		})
		if (!result.ok) {
			return c.json({ error: result.error }, ACTION_STATUS[result.error])
		}
		if (result.value.status === 'Processing' && result.value.lease) {
			// Kept alive past the response with the platform's waitUntil; the tick
			// resumes it if this isolate stops mid-send.
			startDispatch(orgId, campaignId, result.value.lease)
		}
		return c.json({
			success: true,
			campaignId,
			status: result.value.status,
		})
	} catch (error) {
		console.error('Error updating campaign:', errorLogFields(error))
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

/** Stop a Draft or Scheduled broadcast before the tick claims it. */
operatorRoutes.post('/marketing/campaigns/:campaignId/cancel', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canUpdate')
	if (denied) return denied
	try {
		const db = await getTenantDb(auth.orgId)
		const result = await cancelCampaign(db, c.req.param('campaignId'))
		return result.ok
			? c.json({ success: true, status: result.value.status })
			: c.json({ error: result.error }, ACTION_STATUS[result.error])
	} catch (error) {
		console.error('Error cancelling campaign:', errorLogFields(error))
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

/** Delete a Draft or Cancelled broadcast. Needs the delete claim. */
operatorRoutes.delete('/marketing/campaigns/:campaignId', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canDelete')
	if (denied) return denied
	try {
		const db = await getTenantDb(auth.orgId)
		const result = await deleteCampaign(db, c.req.param('campaignId'))
		return result.ok
			? c.json({ success: true })
			: c.json({ error: result.error }, ACTION_STATUS[result.error])
	} catch (error) {
		console.error('Error deleting campaign:', errorLogFields(error))
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

/** A new Draft with the same message and audience. */
operatorRoutes.post('/marketing/campaigns/:campaignId/duplicate', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canUpdate')
	if (denied) return denied
	try {
		const db = await getTenantDb(auth.orgId)
		const result = await duplicateCampaign(db, c.req.param('campaignId'))
		return result.ok
			? c.json({ success: true, campaignId: result.value.campaignId })
			: c.json({ error: result.error }, ACTION_STATUS[result.error])
	} catch (error) {
		console.error('Error duplicating campaign:', errorLogFields(error))
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

/**
 * Re-send to non-openers: a linked Draft of a Completed email broadcast, once,
 * after 48 hours. The recipients are picked when it is sent.
 */
operatorRoutes.post('/marketing/campaigns/:campaignId/retarget', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canUpdate')
	if (denied) return denied
	let subject: string | null = null
	try {
		const parsed = z
			.object({ subject: z.string().max(300).nullable().optional() })
			.strict()
			.parse(await c.req.json().catch(() => ({})))
		subject = parsed.subject ?? null
	} catch {
		return c.json({ error: 'Invalid request body' }, 400)
	}
	try {
		const db = await getTenantDb(auth.orgId)
		const result = await retargetCampaign(db, c.req.param('campaignId'), {
			subject,
		})
		return result.ok
			? c.json({ success: true, campaignId: result.value.campaignId })
			: c.json({ error: result.error }, ACTION_STATUS[result.error])
	} catch (error) {
		console.error('Error re-sending campaign:', errorLogFields(error))
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})

/**
 * How many customers a broadcast would reach now: a count, never a customer.
 * The App reads it for the pre-send check ("an audience of zero").
 */
operatorRoutes.get('/marketing/audience-count', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const query = z
		.object({
			channel: z.enum(['email', 'sms', 'push']),
			audience: z.enum(['all', 'verified', 'unverified']).default('all'),
			audienceId: z.string().min(1).max(100).optional(),
			retargetOf: z.string().min(1).max(100).optional(),
		})
		.safeParse({
			channel: c.req.query('channel'),
			audience: c.req.query('audience') || undefined,
			audienceId: c.req.query('audienceId') || undefined,
			retargetOf: c.req.query('retargetOf') || undefined,
		})
	if (!query.success) return c.json({ error: 'Invalid request' }, 400)
	try {
		const db = await getTenantDb(auth.orgId)
		const resolved = query.data.audienceId
			? await resolveAudienceWhere(db, query.data.audienceId)
			: null
		if (query.data.audienceId && !resolved) {
			return c.json({ error: 'audience_not_found' }, 404)
		}
		const audience = await loadBroadcastAudience(db, {
			channel: query.data.channel,
			audience: query.data.audience,
			retargetOf: query.data.retargetOf,
			audienceWhere: resolved?.where,
		})
		return c.json({ count: audience.length })
	} catch (error) {
		console.error('Error counting audience:', errorLogFields(error))
		return c.json({ error: 'Tenant Database unavailable' }, 500)
	}
})

/**
 * Where a discount is promised (#236), for the App's server when it pauses what
 * a discount would break. The same lookup the browser reads with the discounts
 * token (`GET /operator/discounts/used-in`), behind the server-side operator
 * token only: a token bound to an area is refused, so no browser reaches it.
 */
operatorRoutes.get('/marketing/discount-used-in', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c)
	} catch (response) {
		return response as Response
	}
	const query = discountUsedInQuerySchema.safeParse({
		discountId: c.req.query('discountId') ?? '',
	})
	if (!query.success) return c.json({ error: 'Invalid request' }, 400)
	try {
		const db = await getTenantDb(auth.orgId)
		return c.json(await findDiscountUsedIn(db, query.data.discountId))
	} catch (error) {
		console.error('Error reading discount usage:', errorLogFields(error))
		return c.json({ error: 'Tenant Database unavailable' }, 500)
	}
})

const testSendSchema = z
	.object({
		channel: z.enum(['email', 'sms']),
		subject: z.string().max(300).nullable().optional(),
		content: z.string().min(1).max(20_000),
		contentHtml: z.string().max(500_000).nullable().optional(),
	})
	.strict()

/**
 * Where a test goes: the operator's own address or verified number, read by the
 * App from their control-plane account and signed into a server-only token
 * (`testEmail` / `testPhone`). The body never names a recipient, so a browser
 * holding its own area token cannot aim a test at anyone. It is used for this
 * one send and never stored in the region.
 */
const testRecipientSchema = {
	email: z.string().email().max(320),
	sms: z.string().regex(/^\+[1-9]\d{6,14}$/),
}

/**
 * Starts a claimed broadcast and keeps it alive past the response where the
 * platform allows it (Workers `waitUntil`); a failure is logged with ids only.
 */
function startDispatch(orgId: string, campaignId: string, lease: Date) {
	runInBackground(
		dispatchBroadcast(orgId, campaignId, lease).catch((error) => {
			console.error('Broadcast dispatch failed', {
				orgId,
				campaignId,
				reason: error instanceof Error ? error.name : 'unknown',
			})
		}),
	)
}

/** Sample values for merge tags in a test: nothing real, no coupon is minted. */
const TEST_SAMPLE = { name: 'Alex Sample' } as const
const TEST_COUPON_CODE = 'SAMPLE-CODE'

function escapeText(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/**
 * "Send a test" (#101): the operator's own inbox or phone, sample merge values
 * and a "[Test]" prefix. It creates no `marketing_messages` row, so it never
 * counts toward metrics, the frequency cap or a recipient list, and it is
 * limited to 10 per operator per hour (`test_send_limit`).
 */
operatorRoutes.post('/marketing/test-send', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c, undefined, 'marketing')
	} catch (response) {
		return response as Response
	}
	const denied = requireOperatorClaim(c, auth, 'canUpdate')
	if (denied) return denied
	if (!auth.sub) return c.json({ error: 'Unauthorized' }, 401)

	let body: z.infer<typeof testSendSchema>
	try {
		body = testSendSchema.parse(await c.req.json())
	} catch {
		return c.json({ error: 'Invalid request body' }, 400)
	}
	const claimed = body.channel === 'email' ? auth.testEmail : auth.testPhone
	const recipient = testRecipientSchema[body.channel].safeParse(claimed)
	// A token without the signed recipient (every browser token) cannot test.
	if (!recipient.success) return c.json({ error: 'Forbidden' }, 403)
	const to = recipient.data

	try {
		const db = await getTenantDb(auth.orgId)
		if (!(await reserveTestSend(db, auth.sub, body.channel))) {
			return c.json({ error: 'test_send_limit' }, 429)
		}

		const sample = {
			...TEST_SAMPLE,
			email: body.channel === 'email' ? to : undefined,
			phone: body.channel === 'sms' ? to : undefined,
		}
		const merge = { couponCode: TEST_COUPON_CODE }
		const content = interpolateMergeTags(body.content, sample, merge)

		if (body.channel === 'sms') {
			const sent = await sendSms({ to, message: `[Test] ${content}` })
			if (sent && sent.success === false) {
				return c.json({ error: 'test_send_failed' }, 502)
			}
			return c.json({ success: true })
		}

		const subject = body.subject
			? interpolateMergeTags(body.subject, sample, merge)
			: ''
		const bodyHtml = body.contentHtml
			? interpolateMergeTagsHtml(body.contentHtml, sample, merge)
			: `<p>${escapeText(content)}</p>`
		const result = await sendTenantEmail({
			to,
			toName: TEST_SAMPLE.name,
			// A test shows the operator the sender name and reply-to guests will see.
			orgId: auth.orgId,
			subject: `[Test] ${subject || 'Notification'}`,
			text: content,
			// A test is not a campaign message: no signed unsubscribe link, the
			// same placeholder the designer preview shows.
			html: withUnsubscribeFooter(bodyHtml, UNSUBSCRIBE_PREVIEW_HREF),
		})
		if (result.status === 'error') {
			return c.json({ error: 'test_send_failed' }, 502)
		}
		return c.json({ success: true })
	} catch (error) {
		console.error('Error sending test:', errorLogFields(error))
		return c.json({ error: 'Internal Server Error' }, 500)
	}
})
