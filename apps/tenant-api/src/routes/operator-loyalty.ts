import {
	LOYALTY_ADJUSTMENT_REASONS,
	LOYALTY_MAX_ADJUSTMENT_DELTA,
	LOYALTY_PERMISSIONS,
	LOYALTY_PURCHASE_SOURCES,
	LoyaltyDomainError,
	loyaltyCreateRewardRequestSchema,
	loyaltyProgramStatusRequestSchema,
	loyaltyRecordRefundRequestSchema,
	loyaltyReportQuerySchema,
	loyaltyResolvePurchaseRequestSchema,
	loyaltyResolveRedemptionRequestSchema,
	loyaltyRewardStatusRequestSchema,
	loyaltySaveProgramRequestSchema,
	loyaltyUpdateRewardRequestSchema,
} from '@repo/loyalty'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { z } from 'zod'
import { json, readJsonBody, readQuery } from '../lib/http.ts'
import { getLoyaltyAuth, loyaltyGuard } from '../lib/loyalty-guard.ts'
import {
	loyaltyErrorResponse,
	loyaltyIdempotency,
} from '../lib/loyalty-http.ts'
import { requireLoyaltyLocation } from '../lib/loyalty-auth.ts'
import { withLoyaltyWrite } from '../lib/loyalty-write.ts'
import {
	getLoyaltyReviewQueue,
	listLoyaltyActivity,
} from '../services/loyalty-activity-service.ts'
import { recordLoyaltyAudit } from '../services/loyalty-audit.ts'
import {
	findBalanceMismatches,
	repairMemberBalanceInTx,
} from '../services/loyalty-ledger.ts'
import {
	adjustMemberPoints,
	getMemberDetail,
	getMemberForCustomer,
	setMemberStatus,
} from '../services/loyalty-member-service.ts'
import {
	createReward,
	getOperatorProgram,
	listOperatorRewards,
	saveProgram,
	setProgramStatus,
	setRewardStatus,
	updateReward,
} from '../services/loyalty-program-service.ts'
import {
	requeueLoyaltySource,
	resolvePurchase,
} from '../services/loyalty-purchase-service.ts'
import { resolveRedemption } from '../services/loyalty-redemption-service.ts'
import { recordLoyaltyRefund } from '../services/loyalty-refund-service.ts'
import { getLoyaltyReport } from '../services/loyalty-report-service.ts'

/**
 * Operator loyalty routes (`/operator/loyalty/*`), called from the App in the
 * operator's browser with a short-lived `lty+jwt` (see `loyaltyGuard`).
 * Configuration writes send `expectedVersion` (409 `stale_version`); every
 * mutation needs an `Idempotency-Key`. Review, refunds, requeues and balance
 * repair are reconciliation: they keep working with the flags off, so a
 * switched-off program never strands a sale or a redemption already in flight.
 */
export const operatorLoyaltyRoutes = new Hono()

const READ = LOYALTY_PERMISSIONS.READ_LOYALTY
const PROGRAM = LOYALTY_PERMISSIONS.UPDATE_LOYALTY_PROGRAM
const POINTS = LOYALTY_PERMISSIONS.UPDATE_LOYALTY_POINTS
const REDEMPTION = LOYALTY_PERMISSIONS.UPDATE_LOYALTY_REDEMPTION
const REPORT = LOYALTY_PERMISSIONS.READ_LOYALTY_REPORT

const idParamSchema = /^[A-Za-z0-9_-]{1,64}$/

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

operatorLoyaltyRoutes.get(
	'/program',
	loyaltyGuard({ scope: ['read', 'setup'], grant: READ, read: true }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const program = await getOperatorProgram(await getTenantDb(ctx.orgId))
			return json({ program })
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

operatorLoyaltyRoutes.put(
	'/program',
	loyaltyGuard({ scope: 'setup', grant: PROGRAM }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const body = await readJsonBody(c, loyaltySaveProgramRequestSchema)
			if ('error' in body) return body.error
			const idem = loyaltyIdempotency(c, 'program:save', body.data)
			if ('error' in idem) return idem.error
			const program = await saveProgram(ctx.orgId, {
				expectedVersion: body.data.expectedVersion,
				config: body.data.config,
				actorId: ctx.userId,
				idempotency: idem.idempotency,
			})
			return json({ program })
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

operatorLoyaltyRoutes.post(
	'/program/status',
	loyaltyGuard({ scope: 'setup', grant: PROGRAM }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const body = await readJsonBody(c, loyaltyProgramStatusRequestSchema)
			if ('error' in body) return body.error
			const idem = loyaltyIdempotency(c, 'program:status', body.data)
			if ('error' in idem) return idem.error
			const program = await setProgramStatus(ctx.orgId, {
				expectedVersion: body.data.expectedVersion,
				status: body.data.status,
				actorId: ctx.userId,
				idempotency: idem.idempotency,
			})
			return json({ program })
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

operatorLoyaltyRoutes.get(
	'/rewards',
	loyaltyGuard({ scope: ['read', 'setup'], grant: READ, read: true }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const rewards = await listOperatorRewards(await getTenantDb(ctx.orgId))
			return json({ rewards })
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

operatorLoyaltyRoutes.post(
	'/rewards',
	loyaltyGuard({ scope: 'setup', grant: PROGRAM }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const body = await readJsonBody(c, loyaltyCreateRewardRequestSchema)
			if ('error' in body) return body.error
			const idem = loyaltyIdempotency(c, 'reward:create', body.data)
			if ('error' in idem) return idem.error
			const reward = await createReward(ctx.orgId, {
				definition: body.data.definition,
				actorId: ctx.userId,
				idempotency: idem.idempotency,
			})
			return json({ reward }, 201)
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

operatorLoyaltyRoutes.put(
	'/rewards/:rewardId',
	loyaltyGuard({ scope: 'setup', grant: PROGRAM }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const rewardId = c.req.param('rewardId')
			const body = await readJsonBody(c, loyaltyUpdateRewardRequestSchema)
			if ('error' in body) return body.error
			const idem = loyaltyIdempotency(c, `reward:update:${rewardId}`, body.data)
			if ('error' in idem) return idem.error
			const reward = await updateReward(ctx.orgId, {
				rewardId,
				expectedVersion: body.data.expectedVersion,
				definition: body.data.definition,
				actorId: ctx.userId,
				idempotency: idem.idempotency,
			})
			return json({ reward })
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

operatorLoyaltyRoutes.post(
	'/rewards/:rewardId/status',
	loyaltyGuard({ scope: 'setup', grant: PROGRAM }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const rewardId = c.req.param('rewardId')
			const body = await readJsonBody(c, loyaltyRewardStatusRequestSchema)
			if ('error' in body) return body.error
			const idem = loyaltyIdempotency(c, `reward:status:${rewardId}`, body.data)
			if ('error' in idem) return idem.error
			const reward = await setRewardStatus(ctx.orgId, {
				rewardId,
				expectedVersion: body.data.expectedVersion,
				status: body.data.status,
				actorId: ctx.userId,
				idempotency: idem.idempotency,
			})
			return json({ reward })
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

operatorLoyaltyRoutes.get(
	'/members/customer/:customerId',
	loyaltyGuard({
		scope: ['read', 'members', 'reconcile'],
		grant: READ,
		read: true,
	}),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const customerId = c.req.param('customerId')
			if (!idParamSchema.test(customerId)) {
				return json({ error: 'invalid_request', code: 'invalid_request' }, 400)
			}
			const member = await getMemberForCustomer(
				await getTenantDb(ctx.orgId),
				customerId,
				ctx.locationIdList,
			)
			return json({ member })
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

operatorLoyaltyRoutes.get(
	'/members/:memberId',
	loyaltyGuard({
		scope: ['read', 'members', 'reconcile'],
		grant: READ,
		read: true,
	}),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const memberId = c.req.param('memberId')
			const detail = await getMemberDetail(await getTenantDb(ctx.orgId), {
				memberId,
				locationIds: ctx.locationIdList,
			})
			if (!detail) {
				return json(
					{ error: 'member_not_found', code: 'member_not_found' },
					404,
				)
			}
			return json(detail)
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

const adjustBodySchema = z
	.object({
		delta: z
			.number()
			.int()
			.min(-LOYALTY_MAX_ADJUSTMENT_DELTA)
			.max(LOYALTY_MAX_ADJUSTMENT_DELTA)
			.refine((v) => v !== 0, {
				message: 'A nonzero delta is required',
			}),
		reason: z.enum(LOYALTY_ADJUSTMENT_REASONS),
		note: z.string().trim().min(3).max(280),
	})
	.strict()

operatorLoyaltyRoutes.post(
	'/members/:memberId/adjust',
	loyaltyGuard({ scope: 'members', grant: POINTS }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const memberId = c.req.param('memberId')
			// A balance is organization-wide; a location-scoped token cannot
			// express which members it may adjust, so it cannot adjust at all.
			if (ctx.locationIdList !== null) {
				throw new LoyaltyDomainError('location_forbidden')
			}
			const body = await readJsonBody(c, adjustBodySchema)
			if ('error' in body) return body.error
			const idem = loyaltyIdempotency(c, `adjust:${memberId}`, body.data)
			if ('error' in idem) return idem.error
			const result = await adjustMemberPoints(ctx.orgId, {
				memberId,
				delta: body.data.delta,
				reason: body.data.reason,
				note: body.data.note,
				actorId: ctx.userId,
				idempotencyKey: idem.idempotency.key,
				idempotency: idem.idempotency,
			})
			return json(result)
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

const memberStatusBodySchema = z
	.object({ status: z.enum(['active', 'suspended']) })
	.strict()

operatorLoyaltyRoutes.post(
	'/members/:memberId/status',
	loyaltyGuard({ scope: 'members', grant: POINTS }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const memberId = c.req.param('memberId')
			// Membership status is organization-wide, like the balance.
			if (ctx.locationIdList !== null) {
				throw new LoyaltyDomainError('location_forbidden')
			}
			const body = await readJsonBody(c, memberStatusBodySchema)
			if ('error' in body) return body.error
			const idem = loyaltyIdempotency(c, `member-status:${memberId}`, body.data)
			if ('error' in idem) return idem.error
			const member = await setMemberStatus(ctx.orgId, {
				memberId,
				status: body.data.status,
				actorId: ctx.userId,
				idempotency: idem.idempotency,
			})
			return json({ member })
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

const activityQuerySchema = z.object({
	locationId: z.string().max(64).optional(),
	cursor: z.string().max(200).optional(),
	limit: z.coerce.number().int().min(1).max(50).optional(),
})

operatorLoyaltyRoutes.get(
	'/activity',
	loyaltyGuard({
		scope: ['read', 'members', 'reconcile'],
		grant: READ,
		read: true,
	}),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const query = readQuery(c, activityQuerySchema)
			if ('error' in query) return query.error
			if (query.data.locationId) {
				const location = requireLoyaltyLocation(ctx, query.data.locationId)
				if (!location.ok) return location.response
			}
			const page = await listLoyaltyActivity(await getTenantDb(ctx.orgId), {
				locationIds: ctx.locationIdList,
				locationId: query.data.locationId ?? null,
				cursor: query.data.cursor ?? null,
				limit: query.data.limit,
			})
			return json(page)
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

// ---------------------------------------------------------------------------
// Review queue and resolutions (reconciliation: no feature gate)
// ---------------------------------------------------------------------------

operatorLoyaltyRoutes.get(
	'/review',
	loyaltyGuard({ scope: ['read', 'reconcile'], grant: READ, reconcile: true }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const queue = await getLoyaltyReviewQueue(await getTenantDb(ctx.orgId), {
				locationIds: ctx.locationIdList,
			})
			return json(queue)
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

operatorLoyaltyRoutes.post(
	'/redemptions/:redemptionId/resolve',
	loyaltyGuard({ scope: 'reconcile', grant: REDEMPTION, reconcile: true }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const redemptionId = c.req.param('redemptionId')
			const body = await readJsonBody(c, loyaltyResolveRedemptionRequestSchema)
			if ('error' in body) return body.error
			const idem = loyaltyIdempotency(
				c,
				`resolve-redemption:${redemptionId}`,
				body.data,
			)
			if ('error' in idem) return idem.error
			const redemption = await resolveRedemption(ctx.orgId, {
				redemptionId,
				action: body.data.action,
				note: body.data.note,
				actorId: ctx.userId,
				locationIds: ctx.locationIdList,
				idempotency: idem.idempotency,
			})
			return json({ redemption })
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

operatorLoyaltyRoutes.post(
	'/purchases/:purchaseId/resolve',
	loyaltyGuard({ scope: 'reconcile', grant: REDEMPTION, reconcile: true }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const purchaseId = c.req.param('purchaseId')
			const body = await readJsonBody(c, loyaltyResolvePurchaseRequestSchema)
			if ('error' in body) return body.error
			const idem = loyaltyIdempotency(
				c,
				`resolve-purchase:${purchaseId}`,
				body.data,
			)
			if ('error' in idem) return idem.error
			const purchase = await resolvePurchase(ctx.orgId, {
				purchaseId,
				action: body.data.action,
				note: body.data.note,
				actorId: ctx.userId,
				locationIds: ctx.locationIdList,
				idempotency: idem.idempotency,
			})
			return json({ purchase })
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

operatorLoyaltyRoutes.post(
	'/refunds',
	loyaltyGuard({ scope: 'reconcile', grant: REDEMPTION, reconcile: true }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const body = await readJsonBody(c, loyaltyRecordRefundRequestSchema)
			if ('error' in body) return body.error
			const idem = loyaltyIdempotency(c, `refund:${ctx.userId}`, body.data)
			if ('error' in idem) return idem.error
			const result = await recordLoyaltyRefund(ctx.orgId, {
				source: body.data.source,
				amountMinor: body.data.amountMinor,
				full: body.data.full,
				note: body.data.note,
				actorId: ctx.userId,
				locationIds: ctx.locationIdList,
				idempotencyKey: idem.idempotency.key,
			})
			return json(result, 201)
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

const requeueBodySchema = z
	.object({
		source: z
			.object({
				type: z.enum(LOYALTY_PURCHASE_SOURCES),
				id: z.string().min(1).max(64),
			})
			.strict(),
	})
	.strict()

operatorLoyaltyRoutes.post(
	'/requeue',
	loyaltyGuard({ scope: 'reconcile', grant: REDEMPTION, reconcile: true }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const body = await readJsonBody(c, requeueBodySchema)
			if ('error' in body) return body.error
			const result = await requeueLoyaltySource(ctx.orgId, {
				source: body.data.source,
				actorId: ctx.userId,
				locationIds: ctx.locationIdList,
			})
			return json(result)
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

// ---------------------------------------------------------------------------
// Balance rebuild (reconciliation: no feature gate)
// ---------------------------------------------------------------------------

const balanceCheckQuerySchema = z.object({
	after: z.string().max(64).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
})

operatorLoyaltyRoutes.get(
	'/balances/check',
	loyaltyGuard({ scope: 'reconcile', grant: REDEMPTION, reconcile: true }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			// Balances are organization-wide, like adjustments: a
			// location-scoped token can neither list nor rebuild them.
			if (ctx.locationIdList !== null) {
				throw new LoyaltyDomainError('location_forbidden')
			}
			const query = readQuery(c, balanceCheckQuerySchema)
			if ('error' in query) return query.error
			const result = await findBalanceMismatches(await getTenantDb(ctx.orgId), {
				afterMemberId: query.data.after ?? null,
				limit: query.data.limit,
			})
			return json(result)
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

operatorLoyaltyRoutes.post(
	'/balances/:memberId/repair',
	loyaltyGuard({ scope: 'reconcile', grant: REDEMPTION, reconcile: true }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			if (ctx.locationIdList !== null) {
				throw new LoyaltyDomainError('location_forbidden')
			}
			const memberId = c.req.param('memberId')
			if (!idParamSchema.test(memberId)) {
				return json({ error: 'invalid_request', code: 'invalid_request' }, 400)
			}
			const idem = loyaltyIdempotency(c, `balance-repair:${memberId}`, {
				memberId,
			})
			if ('error' in idem) return idem.error
			const check = await withLoyaltyWrite(
				{ orgId: ctx.orgId, idempotency: idem.idempotency },
				async (tx, writeCtx) => {
					writeCtx.linkMember(memberId)
					const result = await repairMemberBalanceInTx(
						tx,
						memberId,
						writeCtx.now,
					)
					if (!result.matches) {
						await recordLoyaltyAudit(tx, {
							actorKind: 'operator',
							actorId: ctx.userId,
							action: 'balance.repaired',
							entityType: 'balance',
							entityId: memberId,
							changes: {
								points: result.rebuilt.points,
								reserved: result.rebuilt.reserved,
							},
							at: writeCtx.now,
						})
					}
					return result
				},
			)
			return json({ check })
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

operatorLoyaltyRoutes.get(
	'/reports',
	loyaltyGuard({ scope: 'reports', grant: REPORT, read: true }),
	async (c) => {
		try {
			const ctx = getLoyaltyAuth(c)
			const query = readQuery(c, loyaltyReportQuerySchema)
			if ('error' in query) return query.error
			const report = await getLoyaltyReport(
				await getTenantDb(ctx.orgId),
				query.data,
				{ locationIds: ctx.locationIdList },
			)
			return json({ report })
		} catch (error) {
			return loyaltyErrorResponse(error)
		}
	},
)
