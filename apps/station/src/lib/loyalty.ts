import { POS_STAFF_SESSION_HEADER } from '@repo/common/pos-orders'
import { allocateProportionally } from '@repo/discounts'
import { z } from 'zod'
import { noteServerDate } from './clock.ts'
import { type PosSettings } from './config.ts'
import {
	lineUnitCents,
	lineTotalCents,
	type Adjustment,
	type CartLine,
} from './pricing.ts'
import { type Session } from './signin.ts'

/**
 * The till's client for the regional loyalty routes (`/pos/loyalty/*`,
 * `docs/loyalty.md`). The paired device secret authenticates the terminal and,
 * on a terminal that requires sign-in, the person's server session goes with
 * it. A member code or a phone number only identifies; spending needs the
 * member's approval (their wallet, or a one-time code on their verified phone).
 *
 * Nothing here is stored: the binding and the member live in memory with the
 * sale (see `loyalty-store.ts`). Nothing is logged: no phone number, no code.
 *
 * The response schemas mirror `@repo/loyalty/src/schemas/pos.ts` in the
 * fields the till reads. They are lenient on purpose (extra fields are
 * ignored) so a region that starts sending more never breaks a till.
 */

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

const balanceSchema = z.object({
	points: z.number().int(),
	reserved: z.number().int().nonnegative(),
	/** Spendable now. Negative while the member owes points. */
	available: z.number().int(),
})
export type LoyaltyBalance = z.infer<typeof balanceSchema>

const rewardSchema = z.object({
	id: z.string().min(1).max(64),
	version: z.number().int().min(1),
	name: z.string(),
	description: z.string().nullable().default(null),
	pointsCost: z.number().int().min(1),
	kind: z.string(),
	currency: z.string(),
})
export type LoyaltyReward = z.infer<typeof rewardSchema>

/** A reward this till cannot read is left out, never a reason to fail the answer. */
const rewardsSchema = z.array(z.unknown()).transform((items) =>
	items.flatMap((item) => {
		const parsed = rewardSchema.safeParse(item)
		return parsed.success ? [parsed.data] : []
	}),
)

const memberSchema = z.object({
	binding: z.string().min(1).max(200),
	bindingExpiresAt: z.number().int().nonnegative(),
	/** First name only, for the cashier to greet. */
	firstName: z.string().nullable(),
	unitLabel: z.string(),
	balance: balanceSchema,
})

const identificationSchema = z.object({
	member: memberSchema,
	rewards: rewardsSchema,
	redemptionEnabled: z.boolean(),
})

const joinedSchema = identificationSchema.extend({
	/** True when this call opened the points account. */
	joined: z.boolean().default(false),
})

const joinSentSchema = z.object({
	sent: z.literal(true),
	expiresAt: z.number().int().nonnegative(),
})

const quoteSchema = z.object({
	quote: z.object({
		rewardId: z.string(),
		rewardVersion: z.number().int().min(1),
		applicable: z.boolean(),
		/** Why it does not apply, or cannot be afforded; null when it does. */
		code: z.string().nullable(),
		discountMinor: z.number().int().nonnegative(),
		pointsCost: z.number().int().min(1),
		affordable: z.boolean(),
		targetLineId: z.string().nullable().default(null),
	}),
	availableAfter: z.number().int(),
})
export type LoyaltyQuote = z.infer<typeof quoteSchema>

const approvalSchema = z.object({
	id: z.string().min(1).max(64),
	status: z.enum(['pending', 'approved', 'declined', 'expired', 'cancelled']),
	saleId: z.string(),
	rewardId: z.string(),
	rewardVersion: z.number().int().min(1),
	rewardName: z.string(),
	pointsCost: z.number().int().min(1),
	discountMinor: z.number().int().nonnegative(),
	lines: z.array(
		z.object({
			lineId: z.string(),
			discountMinor: z.number().int().nonnegative(),
			rewardUnits: z.number().int().nonnegative().default(0),
		}),
	),
	redemptionId: z.string().nullable(),
	expiresAt: z.number().int().nonnegative(),
	/** A one-time code can be sent to the member's verified phone. */
	otpAvailable: z.boolean(),
	otpSentAt: z.number().int().nonnegative().nullable(),
})
export type LoyaltyApproval = z.infer<typeof approvalSchema>

const approvalEnvelope = z.object({ approval: approvalSchema })

export type LoyaltyMember = z.infer<typeof memberSchema> & {
	rewards: LoyaltyReward[]
	redemptionEnabled: boolean
	/** True when the till just opened this person's points account. */
	joined: boolean
}

/** What the till shows after a member code or a phone join. */
function toMember(
	parsed: z.infer<typeof identificationSchema>,
	joined = false,
): LoyaltyMember {
	return {
		...parsed.member,
		rewards: parsed.rewards,
		redemptionEnabled: parsed.redemptionEnabled,
		joined,
	}
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Codes that say loyalty is not on for this restaurant (or not right now). */
const UNAVAILABLE_CODES = new Set([
	'loyalty_disabled',
	'loyalty_unavailable',
	'program_not_found',
	'program_inactive',
])

/** The server refused, or could not be reached (`status` 0). */
export class LoyaltyApiError extends Error {
	readonly status: number
	readonly code: string
	readonly retryAfterSeconds: number | null

	constructor(
		status: number,
		code: string,
		retryAfterSeconds: number | null = null,
	) {
		super(code)
		this.name = 'LoyaltyApiError'
		this.status = status
		this.code = code
		this.retryAfterSeconds = retryAfterSeconds
	}

	/** No answer: offline, a timeout or a captive portal. */
	get offline(): boolean {
		return this.status === 0
	}

	/** Loyalty is off for this restaurant, has no active program, or is paused on the node. */
	get unavailable(): boolean {
		return UNAVAILABLE_CODES.has(this.code)
	}

	/** Earning works but spending is off. */
	get redemptionOff(): boolean {
		return this.code === 'redemption_disabled'
	}

	/** The person must sign in again (an offline sign-in has no server session). */
	get needsSignIn(): boolean {
		return (
			this.code === 'staff_session_required' ||
			this.code === 'staff_session_invalid'
		)
	}

	/** This terminal was removed or its secret is not recognised. */
	get deviceProblem(): boolean {
		return this.code === 'invalid_device' || this.code === 'device_revoked'
	}

	get rateLimited(): boolean {
		return this.code === 'rate_limited' || this.status === 429
	}
}

const errorBodySchema = z
	.object({
		error: z.string().optional(),
		code: z.string().optional(),
		retryAfterSeconds: z.number().optional(),
	})
	.loose()

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 8_000
export const BINDING_HEADER = 'X-Loyalty-Binding'

export type LoyaltyApi = ReturnType<typeof createLoyaltyApi>

/**
 * `settings` and `session` are read per call (pass getters) so a re-pairing or
 * a new sign-in is used straight away.
 */
export function createLoyaltyApi(
	deps: {
		settings: () => PosSettings
		session: () => Session | null
	},
	fetchImpl: typeof fetch = (...args) => fetch(...args),
) {
	async function call<T>(
		method: 'GET' | 'POST',
		path: string,
		schema: z.ZodType<T, unknown>,
		options: {
			body?: unknown
			binding?: string
			idempotencyKey?: string
		} = {},
	): Promise<T> {
		const settings = deps.settings()
		if (!settings.deviceToken || !settings.tenantApiUrl) {
			throw new LoyaltyApiError(401, 'invalid_device')
		}
		const session = deps.session()
		const sentAt = Date.now()
		let response: Response
		try {
			response = await fetchImpl(
				`${settings.tenantApiUrl.replace(/\/+$/, '')}/pos/loyalty${path}`,
				{
					method,
					cache: 'no-store',
					credentials: 'omit',
					headers: {
						Authorization: `Bearer ${settings.deviceToken}`,
						...(options.body !== undefined
							? { 'Content-Type': 'application/json' }
							: {}),
						...(options.binding ? { [BINDING_HEADER]: options.binding } : {}),
						...(options.idempotencyKey
							? { 'Idempotency-Key': options.idempotencyKey }
							: {}),
						...(session?.serverSession
							? { [POS_STAFF_SESSION_HEADER]: session.serverSession.token }
							: {}),
					},
					...(options.body !== undefined
						? { body: JSON.stringify(options.body) }
						: {}),
					signal: AbortSignal.timeout(TIMEOUT_MS),
				},
			)
		} catch (error) {
			const timedOut =
				error instanceof DOMException && error.name === 'TimeoutError'
			throw new LoyaltyApiError(0, timedOut ? 'timeout' : 'network_unavailable')
		}
		noteServerDate(response, sentAt)
		const raw: unknown = await response.json().catch(() => null)
		if (!response.ok) {
			const body = errorBodySchema.safeParse(raw)
			const code =
				(body.success && (body.data.code ?? body.data.error)) ||
				`http_${response.status}`
			throw new LoyaltyApiError(
				response.status,
				code,
				body.success ? (body.data.retryAfterSeconds ?? null) : null,
			)
		}
		const parsed = schema.safeParse(raw)
		// A 200 that is not the region's answer (a captive portal, a proxy) decides nothing.
		if (!parsed.success) throw new LoyaltyApiError(502, 'malformed_response')
		return parsed.data
	}

	return {
		/** A member code from the wallet. It is used up: a binding for this terminal comes back. */
		async identify(code: string): Promise<LoyaltyMember> {
			const result = await call('POST', '/identify', identificationSchema, {
				body: { code: code.trim() },
			})
			return toMember(result)
		},
		/** Texts a one-time code to the guest's phone (joining or finding them). */
		joinSend: (phone: string) =>
			call('POST', '/join/send', joinSentSchema, {
				body: { phone: phone.trim() },
			}),
		/** The guest reads the code back: their phone is verified and they are a member. */
		async joinVerify(phone: string, code: string): Promise<LoyaltyMember> {
			const result = await call('POST', '/join/verify', joinedSchema, {
				body: { phone: phone.trim(), code: code.trim() },
			})
			return toMember(result, result.joined)
		},
		/** Re-reads the member behind a binding held from earlier (balance, rewards). */
		async member(binding: string): Promise<LoyaltyMember> {
			return toMember(
				await call('GET', '/member', identificationSchema, { binding }),
			)
		},
		/** The till forgets a member (end of sale, or the wrong person). */
		revoke: (binding: string) =>
			call('POST', '/member/revoke', z.object({ ok: z.boolean() }), {
				body: { binding },
			}),
		quote: (input: {
			binding: string
			rewardId: string
			cart: LoyaltyCart
			targetLineId?: string | null
		}) =>
			call('POST', '/quote', quoteSchema, {
				body: { ...input, targetLineId: input.targetLineId ?? null },
			}),
		async requestApproval(input: {
			binding: string
			rewardId: string
			rewardVersion: number
			saleId: string
			cart: LoyaltyCart
			targetLineId?: string | null
			idempotencyKey?: string
		}): Promise<LoyaltyApproval> {
			const { idempotencyKey, ...body } = input
			const result = await call('POST', '/approvals', approvalEnvelope, {
				body: { ...body, targetLineId: body.targetLineId ?? null },
				idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
			})
			return result.approval
		},
		async approval(id: string): Promise<LoyaltyApproval> {
			return (
				await call(
					'GET',
					`/approvals/${encodeURIComponent(id)}`,
					approvalEnvelope,
				)
			).approval
		},
		/** Withdraws a request; once approved, the points go back to the member. */
		async cancelApproval(id: string): Promise<LoyaltyApproval> {
			return (
				await call(
					'POST',
					`/approvals/${encodeURIComponent(id)}/cancel`,
					approvalEnvelope,
					{ body: {} },
				)
			).approval
		},
		/** Texts the member a one-time code to approve this spend. */
		async sendOtp(id: string): Promise<LoyaltyApproval> {
			return (
				await call(
					'POST',
					`/approvals/${encodeURIComponent(id)}/otp`,
					approvalEnvelope,
					{ body: {} },
				)
			).approval
		},
		/** The member reads the code back. */
		async verifyOtp(id: string, otp: string): Promise<LoyaltyApproval> {
			return (
				await call(
					'POST',
					`/approvals/${encodeURIComponent(id)}/otp/verify`,
					approvalEnvelope,
					{ body: { otp: otp.trim() } },
				)
			).approval
		},
	}
}

// ---------------------------------------------------------------------------
// The cart the region prices a reward against
// ---------------------------------------------------------------------------

export type LoyaltyCartLine = {
	lineId: string
	itemId: string
	variantId: string | null
	categoryIds: string[]
	quantity: number
	unitBaseMinor: number
	unitMinor: number
	discountedMinor: number
}
export type LoyaltyCart = { currency: string; lines: LoyaltyCartLine[] }

/**
 * The sale as the region's loyalty cart (`tillLoyaltyCart` in
 * `apps/tenant-api/src/restaurant/pos-loyalty-source.ts` builds the same one
 * from the uploaded sale, and re-checks the approved discount against it, so
 * the two must agree line by line).
 *
 * A till discount that says which line took what comes off those lines (never
 * more than the line cost); what no line claims is spread over what is left in
 * proportion to value. A reward applies to what remains after all of it.
 * Loyalty rows are not discounts here: a reward never sits under itself.
 */
export function buildLoyaltyCart(input: {
	currency: string
	lines: readonly CartLine[]
	adjustments: readonly Adjustment[]
	categoryIdsByItem: ReadonlyMap<string, readonly string[]>
}): LoyaltyCart {
	const lines = input.lines.map((line) => ({
		lineId: line.id,
		itemId: line.itemId,
		variantId: line.variantId,
		categoryIds: [...(input.categoryIdsByItem.get(line.itemId) ?? [])].slice(
			0,
			50,
		),
		quantity: line.quantity,
		unitBaseMinor: line.baseCents,
		unitMinor: lineUnitCents(line),
	}))
	const totals = input.lines.map(lineTotalCents)
	const discounts = input.adjustments.filter((row) => row.kind === 'discount')
	const named = new Map<string, number>()
	for (const row of discounts) {
		for (const [lineId, amount] of Object.entries(row.lineAmounts ?? {})) {
			if (Number.isSafeInteger(amount) && amount > 0) {
				named.set(lineId, (named.get(lineId) ?? 0) + amount)
			}
		}
	}
	const perLine = lines.map((line, index) =>
		Math.min(named.get(line.lineId) ?? 0, totals[index] ?? 0),
	)
	const saleDiscount = discounts.reduce(
		(sum, row) =>
			Number.isSafeInteger(row.amountCents) && row.amountCents > 0
				? sum + row.amountCents
				: sum,
		0,
	)
	const taken = perLine.reduce((sum, value) => sum + value, 0)
	const rest = Math.max(0, saleDiscount - taken)
	const left = totals.map((total, index) => total - perLine[index]!)
	const leftTotal = left.reduce((sum, value) => sum + value, 0)
	const shares =
		rest > 0 && lines.length > 0
			? allocateProportionally(Math.min(rest, leftTotal), left)
			: lines.map(() => 0)
	return {
		currency: input.currency,
		lines: lines.map((line, index) => ({
			...line,
			discountedMinor: perLine[index]! + (shares[index] ?? 0),
		})),
	}
}

// ---------------------------------------------------------------------------
// Reward on the sale
// ---------------------------------------------------------------------------

/** Prefix of the adjustment id of an approved reward; the rest is the approval id. */
export const LOYALTY_ADJUSTMENT_PREFIX = 'loyalty:'

export const isLoyaltyAdjustment = (row: Pick<Adjustment, 'kind'>): boolean =>
	row.kind === 'loyalty'

/** The approval a loyalty adjustment was made from. */
export const approvalIdOf = (row: Pick<Adjustment, 'id'>): string | null =>
	row.id.startsWith(LOYALTY_ADJUSTMENT_PREFIX)
		? row.id.slice(LOYALTY_ADJUSTMENT_PREFIX.length)
		: null

/**
 * The reward the member approved, as the `loyalty` adjustment the sale
 * carries. The region matches it to the redemption by sale id and re-prices it
 * on the uploaded lines; `lineAmounts` is the split the approval gave.
 */
export function rewardAdjustment(approval: LoyaltyApproval): Adjustment {
	const lineAmounts = Object.fromEntries(
		approval.lines
			.filter((line) => line.discountMinor > 0)
			.map((line) => [line.lineId, line.discountMinor]),
	)
	return {
		id: `${LOYALTY_ADJUSTMENT_PREFIX}${approval.id}`,
		kind: 'loyalty',
		label: approval.rewardName,
		amountCents: approval.discountMinor,
		...(Object.keys(lineAmounts).length > 0 ? { lineAmounts } : {}),
	}
}

// ---------------------------------------------------------------------------
// What the sale carries so the member earns
// ---------------------------------------------------------------------------

/**
 * The loyalty block kept on the stored sale (`PosOrder.loyalty`) and uploaded
 * as `loyalty` (contract 5, `posOrderLoyaltySchema`): the opaque binding, never
 * a phone number, plus each line's categories for category earning.
 */
export type SaleLoyalty = {
	binding: string
	categories: Record<string, string[]>
}

export function saleLoyalty(input: {
	binding: string
	lines: readonly CartLine[]
	categoryIdsByItem: ReadonlyMap<string, readonly string[]>
}): SaleLoyalty {
	return {
		binding: input.binding,
		categories: Object.fromEntries(
			input.lines.map((line) => [
				line.id,
				[...(input.categoryIdsByItem.get(line.itemId) ?? [])].slice(0, 50),
			]),
		),
	}
}

/** The wire block: `{ binding, lines: [{ id, categoryIds }] }`. Absent when there is no member. */
export function toWireLoyalty(
	loyalty: SaleLoyalty | null | undefined,
	lines: readonly Pick<CartLine, 'id'>[],
) {
	if (!loyalty) return null
	return {
		binding: loyalty.binding,
		lines: lines.slice(0, 50).map((line) => ({
			id: line.id,
			categoryIds: loyalty.categories[line.id] ?? [],
		})),
	}
}

// ---------------------------------------------------------------------------
// Offline rules and display helpers
// ---------------------------------------------------------------------------

/** A binding is good for 12 hours; a till clock a few minutes off must not refuse one. */
export const BINDING_SKEW_MS = 5 * 60_000

export function bindingUsable(
	member: Pick<LoyaltyMember, 'bindingExpiresAt'>,
	now: number,
): boolean {
	return member.bindingExpiresAt + BINDING_SKEW_MS > now
}

/**
 * Whether the cashier may offer a reward now. Earning needs only the held
 * binding and works with no connection; spending needs the region (it holds
 * the points and asks the member), so it is never offered offline. A terminal
 * that requires sign-in also needs the person's server session, which an
 * offline sign-in does not have.
 */
export function spendingAllowed(input: {
	online: boolean
	member: Pick<LoyaltyMember, 'redemptionEnabled' | 'bindingExpiresAt'> | null
	signInRequired: boolean
	session: Pick<Session, 'serverSession'> | null
	now: number
}): { ok: true } | { ok: false; reason: SpendRefusal } {
	if (!input.member) return { ok: false, reason: 'no_member' }
	if (!input.member.redemptionEnabled)
		return { ok: false, reason: 'spending_off' }
	if (!input.online) return { ok: false, reason: 'offline' }
	if (!bindingUsable(input.member, input.now))
		return { ok: false, reason: 'binding_expired' }
	if (input.signInRequired && !input.session?.serverSession)
		return { ok: false, reason: 'sign_in_again' }
	return { ok: true }
}
export type SpendRefusal =
	'no_member' | 'spending_off' | 'offline' | 'binding_expired' | 'sign_in_again'

/** The cheapest reward the member cannot afford yet, and how far along they are. */
export function nextReward(
	rewards: readonly LoyaltyReward[],
	available: number,
): { reward: LoyaltyReward; needed: number; progress: number } | null {
	const ahead = rewards
		.filter((reward) => reward.pointsCost > available)
		.sort((a, b) => a.pointsCost - b.pointsCost)[0]
	if (!ahead) return null
	const have = Math.max(0, available)
	return {
		reward: ahead,
		needed: ahead.pointsCost - have,
		progress: Math.min(1, have / ahead.pointsCost),
	}
}

/** Digits only, for a phone typed with spaces, dashes or Arabic-Indic digits. */
export function foldPhoneInput(raw: string): string {
	return raw
		.replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
		.replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
		.replace(/[^\d+]/g, '')
}

/** A phone worth sending: the region decides, this only stops obvious typos. */
export const plausiblePhone = (raw: string): boolean =>
	/^\+?\d{7,15}$/.test(foldPhoneInput(raw))

/** The six digits a guest reads out, folded to ASCII. */
export function foldCodeInput(raw: string): string {
	return foldPhoneInput(raw).replace(/\D/g, '')
}
