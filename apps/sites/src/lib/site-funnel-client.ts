import {
	assignArm,
	classifyDevice,
	classifyEntry,
	readStoredArm,
	SITE_ENTRIES,
	type ExperimentArm,
	type SiteEntry,
	type SiteEventName,
} from '@repo/common/site-funnel'
import { CART_ADD_EVENT } from '~/lib/ordering/cart-store'

/**
 * The browser half of the funnel (#179) and of A/B tests (#338). It sends
 * counts to the regional tenant-api: an event name, a device class (from the
 * window width), how the visit started and, in a test, the arm. A visit and
 * each later step are sent once per browser session (`sessionStorage`), so the
 * server needs no visitor id and keeps none. A visitor's test arm is kept in
 * `localStorage` so a returning visitor sees the same version. Nothing is sent
 * while the App says the funnel is off.
 */

const SESSION_PREFIX = 'menuza:funnel:'
const ARM_PREFIX = 'menuza:exp:'
/** The tests this visitor has been assigned in this session: `id:arm`. */
const ASSIGNED_KEY = 'menuza:funnel:variants'

function storage(kind: 'local' | 'session'): Storage | null {
	try {
		return kind === 'local'
			? globalThis.localStorage
			: globalThis.sessionStorage
	} catch {
		return null
	}
}

/** True the first time a key is seen in this session; false after. */
function firstThisSession(key: string): boolean {
	const session = storage('session')
	if (!session) return true
	try {
		if (session.getItem(SESSION_PREFIX + key)) return false
		session.setItem(SESSION_PREFIX + key, '1')
		return true
	} catch {
		return true
	}
}

/** The arm for a test: the stored one, or a fresh even split that is then stored. */
export function armFor(experimentId: string): ExperimentArm {
	const local = storage('local')
	let stored: string | null = null
	try {
		stored = local?.getItem(ARM_PREFIX + experimentId) ?? null
	} catch {
		stored = null
	}
	const existing = readStoredArm(stored)
	if (existing) return existing
	const arm = assignArm()
	try {
		local?.setItem(ARM_PREFIX + experimentId, arm)
	} catch {
		/* private mode: the visitor may see the other arm next time */
	}
	return arm
}

export function rememberAssignment(experimentId: string, arm: ExperimentArm) {
	const session = storage('session')
	try {
		const list = new Set<string>(
			JSON.parse(session?.getItem(ASSIGNED_KEY) || '[]') as string[],
		)
		list.add(`${experimentId}:${arm}`)
		session?.setItem(ASSIGNED_KEY, JSON.stringify([...list]))
	} catch {
		/* ignored */
	}
}

function assignedVariants(): string[] {
	try {
		const parsed: unknown = JSON.parse(
			storage('session')?.getItem(ASSIGNED_KEY) || '[]',
		)
		return Array.isArray(parsed)
			? parsed.filter((v): v is string => typeof v === 'string')
			: []
	} catch {
		return []
	}
}

const ENTRY_KEY = 'menuza:funnel:entry'

/**
 * How this session started, read from the landing page's own address and then
 * kept for the session, so a later step (the order confirmation has no `src` in
 * its address) is credited to the poster, table QR or campaign that brought the
 * visitor.
 */
function sessionEntry(): SiteEntry {
	const session = storage('session')
	try {
		const stored = session?.getItem(ENTRY_KEY)
		if ((SITE_ENTRIES as readonly string[]).includes(stored ?? '')) {
			return stored as SiteEntry
		}
	} catch {
		/* falls through */
	}
	const entry = classifyEntry(location.search)
	try {
		session?.setItem(ENTRY_KEY, entry)
	} catch {
		/* ignored */
	}
	return entry
}

type Context = {
	tenantApiUrl: string
	orgSlug?: string
	customHost?: string
	locationId?: string
}

function post(context: Context, event: SiteEventName, variant: string) {
	const body = JSON.stringify({
		slug: context.orgSlug || undefined,
		host: context.customHost || undefined,
		event,
		device: classifyDevice(window.innerWidth),
		entry: sessionEntry(),
		locationId: context.locationId || undefined,
		variant: variant || undefined,
	})
	const url = `${context.tenantApiUrl}/forms/site-events`
	try {
		// `fetch` with keepalive survives a page change; the answer is never read.
		void fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body,
			keepalive: true,
			credentials: 'omit',
		}).catch(() => {})
	} catch {
		/* the beacon is best effort */
	}
}

/**
 * Counts one funnel step, once per session. It is counted for the site as a
 * whole, and again for each test arm this visitor is in, so a test has its own
 * visits and orders without double counting the funnel.
 */
export function countStep(
	context: Context,
	event: SiteEventName,
	once: string = event,
) {
	if (!firstThisSession(once)) return
	post(context, event, '')
	for (const variant of assignedVariants()) post(context, event, variant)
}

/** Which funnel steps the page the visitor is on stands for. */
export function stepsForPath(pathname: string): SiteEventName[] {
	const segments = pathname.split('/').filter(Boolean)
	const trimmed = /^[a-z]{2}(-[a-z]{2})?$/i.test(segments[0] ?? '')
		? segments.slice(1)
		: segments
	if (trimmed[0] !== 'menu') return []
	if (trimmed[1] === 'checkout') return ['checkout']
	if (trimmed[1] === 'success') return ['order']
	return ['menu_view']
}

export function initSiteFunnel(context: Context) {
	if (!context.tenantApiUrl) return
	// Respect a visitor who asks not to be tracked, even for counts.
	if (globalThis.navigator?.doNotTrack === '1') return
	countStep(context, 'visit')
	for (const step of stepsForPath(location.pathname)) {
		// One order per confirmation page: a reload does not count it twice.
		const key =
			step === 'order'
				? `order:${new URLSearchParams(location.search).get('order') ?? ''}`
				: step
		countStep(context, step, key)
	}
	window.addEventListener(CART_ADD_EVENT, () =>
		countStep(context, 'add_to_cart'),
	)
}
