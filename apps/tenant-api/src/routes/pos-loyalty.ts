import {
	LoyaltyDomainError,
	loyaltyPosApprovalRequestSchema,
	loyaltyPosIdentifyRequestSchema,
	loyaltyPosOtpVerifyRequestSchema,
	loyaltyPosQuoteRequestSchema,
	type LoyaltyFeatures,
} from '@repo/loyalty'
import { loyaltyApprovals, type TenantDatabase } from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { readJsonBody } from '../lib/http.ts'
import { getLoyaltyFlagState, loyaltyRefusal } from '../lib/loyalty-context.ts'
import {
	loyaltyErrorResponse,
	loyaltyIdempotency,
	loyaltyKillSwitchResponse,
} from '../lib/loyalty-http.ts'
import { enforceLoyaltyLimit } from '../lib/loyalty-rate-limit.ts'
import { authenticatePosDevice } from '../lib/pos-auth.ts'
import { verifyPosStaffSession } from '../lib/pos-staff-session.ts'
import {
	cancelTillApproval,
	identifyMemberByCode,
	quoteForTill,
	readTillApproval,
	readTillMember,
	requestTillApproval,
	revokeTillBinding,
	sendTillApprovalOtp,
	verifyTillApprovalOtp,
	type TillDevice,
} from '../services/loyalty-code-service.ts'

/**
 * Till loyalty routes (`/pos/loyalty/*`), called browser-direct by a paired
 * Station terminal. The device secret authenticates the terminal; when the
 * terminal requires sign-in a staff session is needed too, so a stolen
 * pairing alone cannot move a member's points. A member code only identifies:
 * spending needs the customer's wallet approval or the one-time code sent to
 * their verified phone.
 */
export const posLoyaltyRoutes = new Hono()

type TillPos = {
	orgId: string
	device: TillDevice
	db: TenantDatabase
}

type LoyaltyPos = TillPos & { features: LoyaltyFeatures }

/**
 * The terminal itself: its device secret, and a staff session when it
 * requires sign-in. Enough on its own for the routes that only finish work
 * already in flight (reading or cancelling the terminal's own approval,
 * forgetting a member), which keep working with the flags off and the kill
 * switch on, as the tick and reconciliation do.
 */
async function requireTillDevice(
	c: Context,
): Promise<{ pos: TillPos } | { error: Response }> {
	const auth = await authenticatePosDevice(c)
	if ('error' in auth) return auth
	if (auth.pos.device.signInRequired) {
		const staff = await verifyPosStaffSession(c, auth.pos)
		if ('error' in staff) return staff
	}
	return {
		pos: {
			orgId: auth.pos.orgId,
			device: {
				id: auth.pos.device.id,
				locationId: auth.pos.device.locationId,
			},
			db: auth.pos.db,
		},
	}
}

/** The terminal, plus the kill switch and the organization's flags: new work. */
async function requireLoyaltyPos(
	c: Context,
): Promise<{ pos: LoyaltyPos } | { error: Response }> {
	const till = await requireTillDevice(c)
	if ('error' in till) return till
	const kill = loyaltyKillSwitchResponse()
	if (kill) return { error: kill }
	const flags = await getLoyaltyFlagState(till.pos.orgId)
	const refusal = loyaltyRefusal(flags)
	if (refusal) {
		return { error: loyaltyErrorResponse(new LoyaltyDomainError(refusal)) }
	}
	return { pos: { ...till.pos, features: flags.features } }
}

/** 404 unless the approval exists and was asked for by this terminal. */
async function requireOwnApproval(
	pos: TillPos,
	approvalId: string,
): Promise<void> {
	const row =
		approvalId.length <= 64
			? await pos.db
					.select({ id: loyaltyApprovals.id })
					.from(loyaltyApprovals)
					.where(
						and(
							eq(loyaltyApprovals.id, approvalId),
							eq(loyaltyApprovals.deviceId, pos.device.id),
						),
					)
					.get()
			: undefined
	if (!row) throw new LoyaltyDomainError('approval_not_found')
}

const BINDING_HEADER = 'X-Loyalty-Binding'

function readBinding(c: Context): string | null {
	const binding = c.req.header(BINDING_HEADER)?.trim()
	if (!binding || binding.length > 64) return null
	return binding
}

// ---------------------------------------------------------------------------
// POST /identify — member code -> offline-capable binding (never a spend)
// ---------------------------------------------------------------------------

posLoyaltyRoutes.post('/identify', async (c) => {
	try {
		const gate = await requireLoyaltyPos(c)
		if ('error' in gate) return gate.error
		const body = await readJsonBody(c, loyaltyPosIdentifyRequestSchema)
		if ('error' in body) return body.error
		await enforceLoyaltyLimit(gate.pos.db, 'identify', gate.pos.device.id)
		const result = await identifyMemberByCode(gate.pos.orgId, {
			code: body.data.code,
			device: gate.pos.device,
			features: gate.pos.features,
		})
		return Response.json(result, {
			status: 200,
			headers: { 'Cache-Control': 'private, no-store' },
		})
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})

// ---------------------------------------------------------------------------
// GET /member — re-read the member behind a held binding (sync after offline)
// ---------------------------------------------------------------------------

posLoyaltyRoutes.get('/member', async (c) => {
	try {
		const gate = await requireLoyaltyPos(c)
		if ('error' in gate) return gate.error
		const binding = readBinding(c)
		if (!binding) {
			return loyaltyErrorResponse(
				new LoyaltyDomainError('invalid_request', {
					message: `${BINDING_HEADER} header required`,
				}),
			)
		}
		const result = await readTillMember(gate.pos.orgId, {
			binding,
			device: gate.pos.device,
			features: gate.pos.features,
			db: gate.pos.db,
		})
		return Response.json(result, {
			headers: { 'Cache-Control': 'private, no-store' },
		})
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})

// ---------------------------------------------------------------------------
// POST /member/revoke — forget a binding (member left, or terminal reset)
// ---------------------------------------------------------------------------

const revokeBodySchema = z
	.object({ binding: z.string().min(1).max(64) })
	.strict()

posLoyaltyRoutes.post('/member/revoke', async (c) => {
	try {
		const gate = await requireTillDevice(c)
		if ('error' in gate) return gate.error
		const body = await readJsonBody(c, revokeBodySchema)
		if ('error' in body) return body.error
		await revokeTillBinding(gate.pos.orgId, {
			binding: body.data.binding,
			device: gate.pos.device,
		})
		return Response.json(
			{ ok: true },
			{ headers: { 'Cache-Control': 'private, no-store' } },
		)
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})

// ---------------------------------------------------------------------------
// POST /quote — reprice one reward against the current cart (non-binding)
// ---------------------------------------------------------------------------

posLoyaltyRoutes.post('/quote', async (c) => {
	try {
		const gate = await requireLoyaltyPos(c)
		if ('error' in gate) return gate.error
		const body = await readJsonBody(c, loyaltyPosQuoteRequestSchema)
		if ('error' in body) return body.error
		await enforceLoyaltyLimit(gate.pos.db, 'quote', gate.pos.device.id)
		const result = await quoteForTill(gate.pos.orgId, {
			binding: body.data.binding,
			device: gate.pos.device,
			rewardId: body.data.rewardId,
			cart: body.data.cart,
			targetLineId: body.data.targetLineId,
			features: gate.pos.features,
			db: gate.pos.db,
		})
		return Response.json(result, {
			headers: { 'Cache-Control': 'private, no-store' },
		})
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})

// ---------------------------------------------------------------------------
// POST /approvals — ask the member to approve a spend on this sale
// ---------------------------------------------------------------------------

posLoyaltyRoutes.post('/approvals', async (c) => {
	try {
		const gate = await requireLoyaltyPos(c)
		if ('error' in gate) return gate.error
		const body = await readJsonBody(c, loyaltyPosApprovalRequestSchema)
		if ('error' in body) return body.error
		await enforceLoyaltyLimit(gate.pos.db, 'approval', gate.pos.device.id)
		const idem = loyaltyIdempotency(
			c,
			`till-approval:${gate.pos.device.id}`,
			body.data,
		)
		if ('error' in idem) return idem.error
		const approval = await requestTillApproval(gate.pos.orgId, {
			binding: body.data.binding,
			device: gate.pos.device,
			rewardId: body.data.rewardId,
			rewardVersion: body.data.rewardVersion,
			saleId: body.data.saleId,
			cart: body.data.cart,
			targetLineId: body.data.targetLineId,
			features: gate.pos.features,
			idempotency: idem.idempotency,
		})
		return Response.json(
			{ approval },
			{ status: 201, headers: { 'Cache-Control': 'private, no-store' } },
		)
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})

// ---------------------------------------------------------------------------
// GET /approvals/:approvalId — poll the decision
// ---------------------------------------------------------------------------

posLoyaltyRoutes.get('/approvals/:approvalId', async (c) => {
	try {
		const gate = await requireTillDevice(c)
		if ('error' in gate) return gate.error
		const approval = await readTillApproval(gate.pos.orgId, {
			approvalId: c.req.param('approvalId'),
			device: gate.pos.device,
		})
		return Response.json(
			{ approval },
			{ headers: { 'Cache-Control': 'private, no-store' } },
		)
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})

// ---------------------------------------------------------------------------
// POST /approvals/:approvalId/cancel — withdraw (releases an approved hold)
// ---------------------------------------------------------------------------

posLoyaltyRoutes.post('/approvals/:approvalId/cancel', async (c) => {
	try {
		const gate = await requireTillDevice(c)
		if ('error' in gate) return gate.error
		// Cancelling is naturally idempotent: a second cancel returns the same
		// closed approval, so no Idempotency-Key is required here.
		const approval = await cancelTillApproval(gate.pos.orgId, {
			approvalId: c.req.param('approvalId'),
			device: gate.pos.device,
		})
		return Response.json(
			{ approval },
			{ headers: { 'Cache-Control': 'private, no-store' } },
		)
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})

// ---------------------------------------------------------------------------
// POST /approvals/:approvalId/otp — send the one-time code to the member's
// verified phone (per-approval limit here, per-member limit in the service)
// ---------------------------------------------------------------------------

posLoyaltyRoutes.post('/approvals/:approvalId/otp', async (c) => {
	try {
		const gate = await requireLoyaltyPos(c)
		if ('error' in gate) return gate.error
		if (!gate.pos.features.redemption) {
			throw new LoyaltyDomainError('redemption_disabled')
		}
		const approvalId = c.req.param('approvalId')
		// Ownership first: the id comes from the client, so another terminal
		// must not be able to use up this approval's sends.
		await requireOwnApproval(gate.pos, approvalId)
		await enforceLoyaltyLimit(
			gate.pos.db,
			'otpSend',
			`${gate.pos.device.id}:${approvalId}`,
		)
		const approval = await sendTillApprovalOtp(gate.pos.orgId, {
			approvalId,
			device: gate.pos.device,
			features: gate.pos.features,
		})
		return Response.json(
			{ approval },
			{ headers: { 'Cache-Control': 'private, no-store' } },
		)
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})

// ---------------------------------------------------------------------------
// POST /approvals/:approvalId/otp/verify — the customer reads the code back
// ---------------------------------------------------------------------------

posLoyaltyRoutes.post('/approvals/:approvalId/otp/verify', async (c) => {
	try {
		const gate = await requireLoyaltyPos(c)
		if ('error' in gate) return gate.error
		const body = await readJsonBody(c, loyaltyPosOtpVerifyRequestSchema)
		if ('error' in body) return body.error
		const approval = await verifyTillApprovalOtp(gate.pos.orgId, {
			approvalId: c.req.param('approvalId'),
			device: gate.pos.device,
			otp: body.data.otp,
			features: gate.pos.features,
		})
		return Response.json(
			{ approval },
			{ headers: { 'Cache-Control': 'private, no-store' } },
		)
	} catch (error) {
		return loyaltyErrorResponse(error)
	}
})
