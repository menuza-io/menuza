import { z } from 'zod'

/**
 * First-party funnel counts for the public site (#179) and the per-arm counts
 * of A/B tests (#338). Counts only: a beacon names an event, a device class,
 * how the visit started and, in a test, the arm. No visitor id, no address, no
 * user agent leaves the browser or is stored. A visit is counted once per
 * browser session by the browser itself (`sessionStorage`), never by the server.
 */

export const SITE_EVENT_NAMES = [
	'visit',
	'menu_view',
	'add_to_cart',
	'checkout',
	'order',
] as const
export type SiteEventName = (typeof SITE_EVENT_NAMES)[number]

export const SITE_DEVICES = ['phone', 'tablet', 'desktop'] as const
export type SiteDevice = (typeof SITE_DEVICES)[number]

export const SITE_ENTRIES = [
	'qr_poster',
	'qr_table',
	'direct',
	'marketing',
] as const
export type SiteEntry = (typeof SITE_ENTRIES)[number]

/** `<experiment id>:a` or `:b`, or empty outside a test. */
export const siteVariantSchema = z
	.string()
	.max(80)
	.regex(/^([A-Za-z0-9_-]{1,64}:[ab])?$/)

export const siteEventBodySchema = z
	.object({
		slug: z.string().max(100).optional(),
		host: z.string().max(255).optional(),
		event: z.enum(SITE_EVENT_NAMES),
		device: z.enum(SITE_DEVICES),
		entry: z.enum(SITE_ENTRIES),
		locationId: z
			.string()
			.max(64)
			.regex(/^[A-Za-z0-9_-]*$/)
			.optional(),
		variant: siteVariantSchema.optional(),
	})
	.strict()
export type SiteEventBody = z.infer<typeof siteEventBodySchema>

/** Device class from the viewport width in CSS pixels. */
export function classifyDevice(viewportWidth: number): SiteDevice {
	if (viewportWidth < 640) return 'phone'
	if (viewportWidth < 1024) return 'tablet'
	return 'desktop'
}

/**
 * How a visit started, from its own address and referrer (read in the browser,
 * never stored): a printed table QR carries `src=qr_table`, a poster QR
 * `src=qr_poster`; any campaign tag (`utm_*`, `coupon`) or a marketing source
 * (`src=email|sms|social|marketing`) is marketing; the rest is direct.
 */
export function classifyEntry(search: string): SiteEntry {
	const params = new URLSearchParams(search)
	const source = (params.get('src') ?? params.get('source') ?? '')
		.trim()
		.toLowerCase()
	if (source === 'qr_table' || source === 'table') return 'qr_table'
	if (source === 'qr_poster' || source === 'poster' || source === 'qr') {
		return 'qr_poster'
	}
	if (
		['email', 'sms', 'social', 'marketing', 'campaign'].includes(source) ||
		[...params.keys()].some((key) => key.startsWith('utm_')) ||
		params.has('coupon')
	) {
		return 'marketing'
	}
	return 'direct'
}

/** The order of the funnel; a count is compared with the step before it. */
export const FUNNEL_STEPS: readonly SiteEventName[] = SITE_EVENT_NAMES

export type FunnelRow = {
	event: SiteEventName
	count: number
}

export type FunnelStep = {
	event: SiteEventName
	count: number
	/** Share of the previous step, 0 to 1; null for the first step or an empty one. */
	rateFromPrevious: number | null
	/** Share of the first step, 0 to 1; null while there are no visits. */
	rateFromStart: number | null
}

export function buildFunnel(rows: readonly FunnelRow[]): FunnelStep[] {
	const totals = new Map<SiteEventName, number>()
	for (const row of rows) {
		totals.set(row.event, (totals.get(row.event) ?? 0) + row.count)
	}
	const start = totals.get('visit') ?? 0
	let previous: number | null = null
	return FUNNEL_STEPS.map((event) => {
		const count = totals.get(event) ?? 0
		const step: FunnelStep = {
			event,
			count,
			rateFromPrevious:
				previous !== null && previous > 0 ? count / previous : null,
			rateFromStart: start > 0 ? count / start : null,
		}
		previous = count
		return step
	})
}

/**
 * Change of a rate against the previous period, in percentage points, or null
 * when either side has no base to speak of.
 */
export function changeInPoints(
	current: number | null,
	previous: number | null,
): number | null {
	if (current === null || previous === null) return null
	return Math.round((current - previous) * 1000) / 10
}

export type FunnelPeriods = { from: string; to: string }

/** The same number of days directly before `[from, to]` (both `YYYY-MM-DD`, inclusive). */
export function previousPeriod({ from, to }: FunnelPeriods): FunnelPeriods {
	const start = Date.parse(`${from}T00:00:00Z`)
	const end = Date.parse(`${to}T00:00:00Z`)
	const days = Math.round((end - start) / 86_400_000) + 1
	const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
	return {
		from: iso(start - days * 86_400_000),
		to: iso(start - 86_400_000),
	}
}

// ---------------------------------------------------------------------------
// A/B tests (#338)
// ---------------------------------------------------------------------------

/** A test ends by itself after this many days. */
export const EXPERIMENT_MAX_DAYS = 60
/** …or when it has seen this many visitors in total (visits counted per session). */
export const EXPERIMENT_VISITOR_CAP = 50_000
/** Below this many visits per arm the result is "not enough data". */
export const EXPERIMENT_MIN_VISITS_PER_ARM = 100
/** Two-sided 95%. */
const Z_95 = 1.96

export type ExperimentArm = 'a' | 'b'

/** A fresh visitor's arm: an even split. `random` is injected in tests. */
export function assignArm(random: () => number = Math.random): ExperimentArm {
	return random() < 0.5 ? 'a' : 'b'
}

export function armFromVariant(variant: string): ExperimentArm | null {
	const arm = variant.split(':')[1]
	return arm === 'a' || arm === 'b' ? arm : null
}

/** The arm a returning visitor keeps; anything unreadable gets a new assignment. */
export function readStoredArm(
	stored: string | null | undefined,
): ExperimentArm | null {
	return stored === 'a' || stored === 'b' ? stored : null
}

export type ArmCounts = { visits: number; orders: number }

export type ExperimentResult = {
	a: ArmCounts & { rate: number | null }
	b: ArmCounts & { rate: number | null }
	/** Relative change of B against A, or null. */
	lift: number | null
	status: 'not_enough_data' | 'no_clear_winner' | 'a_wins' | 'b_wins'
}

/**
 * The result of a test on order conversion (orders per visit): a two-sided
 * two-proportion z-test at 95%. Under `EXPERIMENT_MIN_VISITS_PER_ARM` visits in
 * either arm it says so instead of naming a winner.
 */
export function experimentResult(a: ArmCounts, b: ArmCounts): ExperimentResult {
	const rate = (arm: ArmCounts) =>
		arm.visits > 0 ? arm.orders / arm.visits : null
	const rateA = rate(a)
	const rateB = rate(b)
	const lift =
		rateA !== null && rateB !== null && rateA > 0
			? (rateB - rateA) / rateA
			: null
	const base = {
		a: { ...a, rate: rateA },
		b: { ...b, rate: rateB },
		lift,
	}
	if (
		a.visits < EXPERIMENT_MIN_VISITS_PER_ARM ||
		b.visits < EXPERIMENT_MIN_VISITS_PER_ARM
	) {
		return { ...base, status: 'not_enough_data' }
	}
	const pooled = (a.orders + b.orders) / (a.visits + b.visits)
	const error = Math.sqrt(pooled * (1 - pooled) * (1 / a.visits + 1 / b.visits))
	if (error === 0) return { ...base, status: 'no_clear_winner' }
	const z = (rateB! - rateA!) / error
	if (z >= Z_95) return { ...base, status: 'b_wins' }
	if (z <= -Z_95) return { ...base, status: 'a_wins' }
	return { ...base, status: 'no_clear_winner' }
}

/** Whether a running test must end now, and why. */
export function experimentShouldEnd(input: {
	expiresAt: number
	totalVisits: number
	now: number
}): 'expired' | 'visitor_cap' | null {
	if (input.now >= input.expiresAt) return 'expired'
	if (input.totalVisits >= EXPERIMENT_VISITOR_CAP) return 'visitor_cap'
	return null
}
