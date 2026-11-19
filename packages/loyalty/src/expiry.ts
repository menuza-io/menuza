import { z } from 'zod'
import { type LoyaltyLedgerType } from './ledger.ts'
import { addCalendarMonths } from './tiers.ts'

export const LOYALTY_EXPIRY_MODES = [
	'never',
	'after_inactivity',
	'after_earn',
] as const
export type LoyaltyExpiryMode = (typeof LOYALTY_EXPIRY_MODES)[number]

export const LOYALTY_EXPIRY_MIN_MONTHS = 3
export const LOYALTY_EXPIRY_MAX_MONTHS = 60
export const LOYALTY_EXPIRY_DEFAULT_MONTHS = 12
export const LOYALTY_EXPIRY_REMINDER_DAYS = [30, 7] as const

const DAY_MS = 24 * 60 * 60_000

const CANADIAN_TIME_ZONES = new Set([
	'America/Atikokan',
	'America/Blanc-Sablon',
	'America/Cambridge_Bay',
	'America/Creston',
	'America/Dawson',
	'America/Dawson_Creek',
	'America/Edmonton',
	'America/Fort_Nelson',
	'America/Glace_Bay',
	'America/Goose_Bay',
	'America/Halifax',
	'America/Inuvik',
	'America/Iqaluit',
	'America/Moncton',
	'America/Montreal',
	'America/Nipigon',
	'America/Pangnirtung',
	'America/Rainy_River',
	'America/Rankin_Inlet',
	'America/Regina',
	'America/Resolute',
	'America/St_Johns',
	'America/Swift_Current',
	'America/Thunder_Bay',
	'America/Toronto',
	'America/Vancouver',
	'America/Whitehorse',
	'America/Winnipeg',
	'America/Yellowknife',
])

const CANADIAN_POSTAL_REGEX =
	/\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\s?\d[ABCEGHJ-NPRSTV-Z]\d\b/i
const CANADIAN_COUNTRY_REGEX = /\bcanada\b/i

export type ExpiryRegionCheckInput = {
	mode: LoyaltyExpiryMode
	country?: string | null
	region?: string | null
	currency?: string | null
	timeZone?: string | null
	addresses?: readonly (string | null | undefined)[]
}

export type ExpiryRegionCheckResult =
	| { allowed: true }
	| { allowed: false; reason: 'ca_expiry_prohibited'; jurisdiction: 'Canada' }

/**
 * Checks jurisdiction restrictions on time-based (`after_earn`) expiry.
 * Canadian consumer protection rules prohibit time-limited point expiry on earn;
 * inactivity-based expiry remains permitted.
 */
export function isTimeExpiryAllowedInRegion(
	input: ExpiryRegionCheckInput,
): ExpiryRegionCheckResult {
	if (input.mode !== 'after_earn') return { allowed: true }
	const country = input.country?.trim().toUpperCase()
	const currency = input.currency?.trim().toUpperCase()
	const timeZone = input.timeZone?.trim()
	const isCanadianAddress = (input.addresses ?? []).some((addr) => {
		if (!addr) return false
		return CANADIAN_COUNTRY_REGEX.test(addr) || CANADIAN_POSTAL_REGEX.test(addr)
	})
	if (
		country === 'CA' ||
		currency === 'CAD' ||
		(timeZone !== undefined &&
			timeZone !== null &&
			(timeZone.startsWith('Canada/') || CANADIAN_TIME_ZONES.has(timeZone))) ||
		isCanadianAddress
	) {
		return {
			allowed: false,
			reason: 'ca_expiry_prohibited',
			jurisdiction: 'Canada',
		}
	}
	return { allowed: true }
}

export const loyaltyExpiryConfigSchema = z
	.object({
		mode: z.enum(LOYALTY_EXPIRY_MODES).default('never'),
		months: z
			.number()
			.int()
			.min(LOYALTY_EXPIRY_MIN_MONTHS)
			.max(LOYALTY_EXPIRY_MAX_MONTHS)
			.default(LOYALTY_EXPIRY_DEFAULT_MONTHS),
		/**
		 * Timestamp when expiry was turned on (or reset from `never`). Points
		 * earned before this moment receive a full `months` period starting from
		 * `enabledAt` instead of expiring immediately.
		 */
		enabledAt: z.number().int().min(0).nullable().default(null),
	})
	.strict()

export type LoyaltyExpiryConfig = z.infer<typeof loyaltyExpiryConfigSchema>

export const DEFAULT_LOYALTY_EXPIRY_CONFIG: Readonly<LoyaltyExpiryConfig> =
	Object.freeze({
		mode: 'never',
		months: LOYALTY_EXPIRY_DEFAULT_MONTHS,
		enabledAt: null,
	})

export const addExpiryMonths = addCalendarMonths

export type ExpiryLedgerEntry = {
	id: string
	type: LoyaltyLedgerType
	delta: number
	createdAt: number
	purchaseId?: string | null
}

export type PointExpiryLot = {
	entryId: string
	earnedAt: number
	expiresAt: number
	remaining: number
	purchaseId: string | null
}

export type ComputePointExpiryInput = {
	config: LoyaltyExpiryConfig
	/** Chronological ledger entries for this member (oldest first). */
	entries: readonly ExpiryLedgerEntry[]
	currentBalance: number
	lastActivityAt: number | null
	now: number
}

export type ComputePointExpiryResult = {
	expiredDue: number
	nextExpiryAt: number | null
	nextExpiryPoints: number
	expiringWithin30d: number
	expiringWithin7d: number
	lots: PointExpiryLot[]
}

const CREDIT_TYPES = new Set<LoyaltyLedgerType>([
	'earn',
	'welcome',
	'referral',
	'redeem_restore',
	'adjust',
])

const REVERSAL_TYPES = new Set<LoyaltyLedgerType>([
	'earn_reversal',
	'welcome_reversal',
	'referral_reversal',
])

/**
 * Pure FIFO expiry evaluator.
 * - Positive entries create lots decaying after `months` (clamping `earnedAt`
 *   to `enabledAt` so pre-existing balances receive one full period on switch-on).
 * - Redemptions, expirations, and negative adjustments consume oldest lots first.
 * - Reversals drain their linked `purchaseId` lot first if present, then FIFO.
 * - Final sum of active lots is reconciled against `currentBalance` so expired
 *   totals never exceed spendable points.
 */
export function computePointExpiry(
	input: ComputePointExpiryInput,
): ComputePointExpiryResult {
	const balance = Math.max(0, Math.floor(input.currentBalance))
	const { config, now } = input
	if (config.mode === 'never' || balance === 0) {
		return {
			expiredDue: 0,
			nextExpiryAt: null,
			nextExpiryPoints: 0,
			expiringWithin30d: 0,
			expiringWithin7d: 0,
			lots: [],
		}
	}

	if (config.mode === 'after_inactivity') {
		const firstEntryAt = input.entries[0]?.createdAt ?? now
		const activityBase = input.lastActivityAt ?? firstEntryAt
		const effectiveActivity =
			config.enabledAt !== null
				? Math.max(activityBase, config.enabledAt)
				: activityBase
		const expiresAt = addExpiryMonths(effectiveActivity, config.months)
		if (expiresAt <= now) {
			return {
				expiredDue: balance,
				nextExpiryAt: null,
				nextExpiryPoints: 0,
				expiringWithin30d: 0,
				expiringWithin7d: 0,
				lots: [
					{
						entryId: 'inactivity',
						earnedAt: effectiveActivity,
						expiresAt,
						remaining: balance,
						purchaseId: null,
					},
				],
			}
		}
		const remainingMs = expiresAt - now
		return {
			expiredDue: 0,
			nextExpiryAt: expiresAt,
			nextExpiryPoints: balance,
			expiringWithin30d: remainingMs <= 30 * DAY_MS ? balance : 0,
			expiringWithin7d: remainingMs <= 7 * DAY_MS ? balance : 0,
			lots: [
				{
					entryId: 'inactivity',
					earnedAt: effectiveActivity,
					expiresAt,
					remaining: balance,
					purchaseId: null,
				},
			],
		}
	}

	// `after_earn` FIFO lot tracking.
	const lots: PointExpiryLot[] = []
	const sorted = [...input.entries].sort(
		(a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
	)

	const drainFifo = (amount: number): void => {
		let left = amount
		for (const lot of lots) {
			if (left <= 0) break
			if (lot.remaining <= 0) continue
			const take = Math.min(lot.remaining, left)
			lot.remaining -= take
			left -= take
		}
	}

	for (const entry of sorted) {
		if (entry.delta > 0 && CREDIT_TYPES.has(entry.type)) {
			const effectiveEarned =
				config.enabledAt !== null
					? Math.max(entry.createdAt, config.enabledAt)
					: entry.createdAt
			lots.push({
				entryId: entry.id,
				earnedAt: effectiveEarned,
				expiresAt: addExpiryMonths(effectiveEarned, config.months),
				remaining: entry.delta,
				purchaseId: entry.purchaseId ?? null,
			})
			continue
		}
		if (entry.delta < 0) {
			let toDrain = -entry.delta
			if (entry.purchaseId && REVERSAL_TYPES.has(entry.type)) {
				for (const lot of lots) {
					if (toDrain <= 0) break
					if (lot.purchaseId === entry.purchaseId && lot.remaining > 0) {
						const take = Math.min(lot.remaining, toDrain)
						lot.remaining -= take
						toDrain -= take
					}
				}
			}
			if (toDrain > 0) drainFifo(toDrain)
		}
	}

	let activeLots = lots.filter((lot) => lot.remaining > 0)
	const lotSum = activeLots.reduce((sum, lot) => sum + lot.remaining, 0)
	if (lotSum > balance) {
		// Drain excess oldest-first so remaining lots equal currentBalance.
		let excess = lotSum - balance
		for (const lot of activeLots) {
			if (excess <= 0) break
			const drop = Math.min(lot.remaining, excess)
			lot.remaining -= drop
			excess -= drop
		}
		activeLots = activeLots.filter((lot) => lot.remaining > 0)
	} else if (lotSum < balance) {
		// Edge fallback if ledger history had missing/synthetic credits: attach remainder to latest expiry window.
		const deficit = balance - lotSum
		const baseEarned = config.enabledAt ?? now
		activeLots.push({
			entryId: 'balance_remainder',
			earnedAt: baseEarned,
			expiresAt: addExpiryMonths(baseEarned, config.months),
			remaining: deficit,
			purchaseId: null,
		})
	}

	activeLots.sort((a, b) => a.expiresAt - b.expiresAt)

	let expiredDue = 0
	let nextExpiryAt: number | null = null
	let nextExpiryPoints = 0
	let expiringWithin30d = 0
	let expiringWithin7d = 0

	for (const lot of activeLots) {
		if (lot.expiresAt <= now) {
			expiredDue += lot.remaining
			continue
		}
		if (nextExpiryAt === null) {
			nextExpiryAt = lot.expiresAt
		}
		if (lot.expiresAt === nextExpiryAt) {
			nextExpiryPoints += lot.remaining
		}
		const remainingMs = lot.expiresAt - now
		if (remainingMs <= 30 * DAY_MS) expiringWithin30d += lot.remaining
		if (remainingMs <= 7 * DAY_MS) expiringWithin7d += lot.remaining
	}

	return {
		expiredDue: Math.min(balance, expiredDue),
		nextExpiryAt,
		nextExpiryPoints,
		expiringWithin30d,
		expiringWithin7d,
		lots: activeLots,
	}
}
