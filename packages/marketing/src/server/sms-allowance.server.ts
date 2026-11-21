import {
	billingPeriod,
	smsAllowanceFrom,
	smsSendsForPlan,
	type SmsAllowance,
} from '@repo/common/marketing-allowance'
import {
	and,
	db,
	eq,
	inArray,
	MarketingSmsSend,
	MarketingSmsUsage,
	Organization,
	OrganizationLocation,
	sql,
} from '@repo/database'

/**
 * The monthly marketing text allowance (#247), in the control plane as numbers
 * only. One conditional UPDATE is the only thing that spends a send, so two
 * sends racing for the last slot cannot both win. A send is held when it is sent
 * or scheduled (`reserved`), confirmed when the region starts it (`started`),
 * and given back exactly once when it is cancelled, skipped or fails before
 * anything went out (`released`). A broadcast has no location scope: every send
 * reaches every location, so each location's usage is the count of sends.
 */

async function planNameOf(organizationId: string): Promise<string | null> {
	const [org] = await db
		.select({ planName: Organization.planName })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return org?.planName ?? null
}

async function usageRow(organizationId: string, periodKey: string) {
	const [row] = await db
		.select()
		.from(MarketingSmsUsage)
		.where(
			and(
				eq(MarketingSmsUsage.organizationId, organizationId),
				eq(MarketingSmsUsage.periodKey, periodKey),
			),
		)
		.limit(1)
	return row ?? null
}

/** What the organization has left in the billing month that contains `atMs`. */
export async function getSmsAllowance(
	organizationId: string,
	atMs: number = Date.now(),
): Promise<SmsAllowance> {
	const period = billingPeriod(atMs)
	const [planName, usage] = await Promise.all([
		planNameOf(organizationId),
		usageRow(organizationId, period.key),
	])
	return smsAllowanceFrom({
		planName,
		period,
		sends: usage?.sends ?? 0,
		extraSends: usage?.extraSends ?? 0,
	})
}

/**
 * What this broadcast sees on its send step: the month's allowance, with the
 * send it already holds counted as still available to it (editing a scheduled
 * text must not make it compete with itself).
 */
export async function getSmsAllowanceForBroadcast(
	organizationId: string,
	campaignId: string,
	atMs: number = Date.now(),
): Promise<SmsAllowance> {
	const allowance = await getSmsAllowance(organizationId, atMs)
	const [held] = await db
		.select({
			state: MarketingSmsSend.state,
			periodKey: MarketingSmsSend.periodKey,
		})
		.from(MarketingSmsSend)
		.where(
			and(
				eq(MarketingSmsSend.campaignId, campaignId),
				eq(MarketingSmsSend.organizationId, organizationId),
			),
		)
		.limit(1)
	return held &&
		held.state !== 'released' &&
		held.periodKey === allowance.periodKey
		? {
				...allowance,
				used: Math.max(0, allowance.used - 1),
				remaining: allowance.remaining + 1,
			}
		: allowance
}

export type SmsSendCheck =
	{ ok: true; allowance: SmsAllowance } | { ok: false; allowance: SmsAllowance }

/**
 * Whether a send that starts at `startsAtMs` fits the month it falls in. A
 * broadcast that already holds a send of that month is not counted twice.
 */
export async function checkSmsSend(input: {
	organizationId: string
	startsAtMs: number
	campaignId?: string | null
}): Promise<SmsSendCheck> {
	const allowance = await getSmsAllowance(
		input.organizationId,
		input.startsAtMs,
	)
	if (allowance.remaining > 0) return { ok: true, allowance }
	if (input.campaignId) {
		const [held] = await db
			.select({
				state: MarketingSmsSend.state,
				periodKey: MarketingSmsSend.periodKey,
			})
			.from(MarketingSmsSend)
			.where(
				and(
					eq(MarketingSmsSend.campaignId, input.campaignId),
					eq(MarketingSmsSend.organizationId, input.organizationId),
				),
			)
			.limit(1)
		if (
			held &&
			held.state !== 'released' &&
			held.periodKey === allowance.periodKey
		) {
			return { ok: true, allowance }
		}
	}
	return { ok: false, allowance }
}

export type SmsReservation =
	| { ok: true; periodKey: string; alreadyHeld: boolean }
	| { ok: false; reason: 'exhausted'; allowance: SmsAllowance }

/** Spends one send of the month `startsAtMs` falls in, for this broadcast. Idempotent per broadcast. */
export async function reserveSmsSend(input: {
	organizationId: string
	campaignId: string
	startsAtMs: number
}): Promise<SmsReservation> {
	const period = billingPeriod(input.startsAtMs)
	const [existing] = await db
		.select()
		.from(MarketingSmsSend)
		.where(eq(MarketingSmsSend.campaignId, input.campaignId))
		.limit(1)
	if (existing && existing.organizationId !== input.organizationId) {
		// Another organization's broadcast id: never touched.
		return {
			ok: false,
			reason: 'exhausted',
			allowance: await getSmsAllowance(input.organizationId, input.startsAtMs),
		}
	}
	if (existing && existing.state !== 'released') {
		if (existing.periodKey === period.key) {
			return { ok: true, periodKey: period.key, alreadyHeld: true }
		}
		// Rescheduled into another month: the old month gets its send back.
		await releaseSmsSend({
			organizationId: input.organizationId,
			campaignId: input.campaignId,
		})
	}

	await db
		.insert(MarketingSmsUsage)
		.values({ organizationId: input.organizationId, periodKey: period.key })
		.onConflictDoNothing()
	const base = smsSendsForPlan(await planNameOf(input.organizationId))

	// Claim this broadcast's hold first (it is the record a release finds), then
	// spend the send in one conditional statement.
	const claimed = existing
		? await db
				.update(MarketingSmsSend)
				.set({ state: 'pending', periodKey: period.key })
				.where(
					and(
						eq(MarketingSmsSend.campaignId, input.campaignId),
						eq(MarketingSmsSend.state, 'released'),
					),
				)
				.returning({ campaignId: MarketingSmsSend.campaignId })
		: await db
				.insert(MarketingSmsSend)
				.values({
					campaignId: input.campaignId,
					organizationId: input.organizationId,
					periodKey: period.key,
					state: 'pending',
				})
				.onConflictDoNothing()
				.returning({ campaignId: MarketingSmsSend.campaignId })
	if (claimed.length === 0) {
		// A twin of this call got there first: it holds the send.
		return { ok: true, periodKey: period.key, alreadyHeld: true }
	}

	const spent = await db
		.update(MarketingSmsUsage)
		.set({ sends: sql`${MarketingSmsUsage.sends} + 1` })
		.where(
			and(
				eq(MarketingSmsUsage.organizationId, input.organizationId),
				eq(MarketingSmsUsage.periodKey, period.key),
				sql`${MarketingSmsUsage.sends} < ${base} + ${MarketingSmsUsage.extraSends}`,
			),
		)
		.returning({ sends: MarketingSmsUsage.sends })
	if (spent.length === 0) {
		// Nothing left: undo the claim so the broadcast holds no send.
		await db
			.update(MarketingSmsSend)
			.set({ state: 'released' })
			.where(
				and(
					eq(MarketingSmsSend.campaignId, input.campaignId),
					eq(MarketingSmsSend.state, 'pending'),
				),
			)
		return {
			ok: false,
			reason: 'exhausted',
			allowance: await getSmsAllowance(input.organizationId, input.startsAtMs),
		}
	}
	await db
		.update(MarketingSmsSend)
		.set({ state: 'reserved' })
		.where(
			and(
				eq(MarketingSmsSend.campaignId, input.campaignId),
				eq(MarketingSmsSend.state, 'pending'),
			),
		)
	return { ok: true, periodKey: period.key, alreadyHeld: false }
}

/** Gives a broadcast's send back, once. Returns whether anything was given back. */
export async function releaseSmsSend(input: {
	organizationId: string
	campaignId: string
}): Promise<boolean> {
	const released = await db
		.update(MarketingSmsSend)
		.set({ state: 'released' })
		.where(
			and(
				eq(MarketingSmsSend.campaignId, input.campaignId),
				eq(MarketingSmsSend.organizationId, input.organizationId),
				inArray(MarketingSmsSend.state, ['reserved', 'started']),
			),
		)
		.returning({ periodKey: MarketingSmsSend.periodKey })
	const [row] = released
	if (!row) return false
	await db
		.update(MarketingSmsUsage)
		.set({ sends: sql`max(${MarketingSmsUsage.sends} - 1, 0)` })
		.where(
			and(
				eq(MarketingSmsUsage.organizationId, input.organizationId),
				eq(MarketingSmsUsage.periodKey, row.periodKey),
			),
		)
	return true
}

export type SmsStart =
	{ ok: true } | { ok: false; reason: 'exhausted'; resetsAt: number }

/**
 * The region is about to send this broadcast's first text. It holds a send
 * already (reserved when it was sent or scheduled) or gets one now; either way
 * it is marked started, which is what makes a cancel too late to give it back.
 * With nothing left it is refused, and the region puts it off to `resetsAt`.
 */
export async function startSmsSend(input: {
	organizationId: string
	campaignId: string
	now?: number
}): Promise<SmsStart> {
	const now = input.now ?? Date.now()
	const reserved = await reserveSmsSend({
		organizationId: input.organizationId,
		campaignId: input.campaignId,
		startsAtMs: now,
	})
	if (!reserved.ok) {
		return {
			ok: false,
			reason: 'exhausted',
			resetsAt: reserved.allowance.resetsAt,
		}
	}
	await db
		.update(MarketingSmsSend)
		.set({ state: 'started' })
		.where(
			and(
				eq(MarketingSmsSend.campaignId, input.campaignId),
				eq(MarketingSmsSend.organizationId, input.organizationId),
				eq(MarketingSmsSend.state, 'reserved'),
			),
		)
	return { ok: true }
}

export type LocationSmsUsage = {
	locationId: string
	name: string
	used: number
	limit: number
}

/** Billing's view: sends used this month at each location, against its allowance. */
export async function smsUsageByLocation(
	organizationId: string,
	atMs: number = Date.now(),
): Promise<{ allowance: SmsAllowance; locations: LocationSmsUsage[] }> {
	const allowance = await getSmsAllowance(organizationId, atMs)
	const locations = await db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organizationId))
	return {
		allowance,
		locations: locations.map((location) => ({
			locationId: location.id,
			name: location.name,
			// Every send reaches every location, so each used all of them.
			used: allowance.used,
			limit: allowance.limit,
		})),
	}
}

/** Admin: adds extra sends to an organization's allowance for a month. */
export async function grantExtraSmsSends(input: {
	organizationId: string
	extra: number
	atMs?: number
}): Promise<SmsAllowance> {
	const period = billingPeriod(input.atMs ?? Date.now())
	const extra = Math.max(0, Math.min(1000, Math.floor(input.extra)))
	await db
		.insert(MarketingSmsUsage)
		.values({
			organizationId: input.organizationId,
			periodKey: period.key,
			extraSends: extra,
		})
		.onConflictDoUpdate({
			target: [MarketingSmsUsage.organizationId, MarketingSmsUsage.periodKey],
			set: { extraSends: sql`${MarketingSmsUsage.extraSends} + ${extra}` },
		})
	return getSmsAllowance(input.organizationId, input.atMs)
}
