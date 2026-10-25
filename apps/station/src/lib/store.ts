import { t } from '@lingui/macro'
import { create } from 'zustand'
import {
	expirePunches,
	flushPunches,
	punchQueue,
} from '../apps/timeclock/clock.ts'
import { touch } from './activity.ts'
import {
	buildCategories,
	loadCachedCatalog,
	pickLocation,
	refreshCatalog,
} from './catalog.ts'
import {
	isConfigured,
	loadSettings,
	saveSettings,
	type PosSettings,
} from './config.ts'
import { type OrderType, type PosOrder } from './db.ts'
import { adoptServerChain } from './fiscal.ts'
import { decodedLine, renameLine } from './line-names.ts'
import { effectiveLocale } from './locale.ts'
import { localizeMenu, menuText, recordLocale } from './menu-text.ts'
import {
	adoptTab,
	canAdoptTab,
	markTransferredAway,
	type ServerTab,
} from './orders.ts'
import { checkDeviceDetailed, flushOutbox } from './outbox.ts'
import {
	pairTerminal,
	parsePairingInput,
	serversProblem,
	withPairing,
} from './pairing.ts'
import { type PhonePickup } from './pickup.ts'
import { lineSignature, type Adjustment, type CartLine } from './pricing.ts'
import {
	approveAsManager,
	attemptSignIn,
	forgetCachedStaff,
	type ApprovalOutcome,
	type Session,
	type SignInOutcome,
} from './signin.ts'
import { applyTheme } from './theme.ts'
import {
	type CatalogSnapshot,
	type MenuCategory,
	type MenuItem,
	type MenuLocation,
	type MenuPayload,
} from './types.ts'
import { forgetZatcaUnit, syncZatcaUnit } from './zatca.ts'

type CatalogStatus = 'loading' | 'ready' | 'empty' | 'error'

export type PosState = {
	settings: PosSettings
	snapshot: CatalogSnapshot | null
	categories: MenuCategory[]
	/** Menu items in the restaurant's default language: what order lines record. */
	recordItems: Map<string, MenuItem>
	/** Menu items in this till's language: what it shows. */
	shownItems: Map<string, MenuItem>
	location: MenuLocation | null
	catalogStatus: CatalogStatus
	catalogError: string | null
	refreshing: boolean
	online: boolean
	/** The server told us this terminal was removed; orders wait until it is paired again. */
	pairingLost: boolean
	/** Who is signed in at the till, or null (locked). Never kept across a reload. */
	session: Session | null
	/** Consecutive times the server did not recognise the secret (may just be an outage on its side). */
	unrecognisedStrikes: number
	/** The location this terminal is bound to is not on the published menu: do not sell. */
	locationMissing: boolean

	orderType: OrderType
	orderSource: 'counter' | 'phone'
	customerPhone: string
	pickupAt: number | null
	pickupTimeZone: string | null
	customerName: string
	tableLabel: string
	lines: CartLine[]
	/** Set while the cart is an open tab being added to, rather than a new order. */
	activeOrderId: string | null
	/** The tax a loaded tab was opened with (it keeps it, even if the location's changed). */
	activeTax: { taxRatePercent: number; taxInclusive: boolean } | null
	/** Empty until discounts and loyalty exist; totals and orders already carry it. */
	adjustments: Adjustment[]

	boot: () => Promise<void>
	refresh: () => Promise<void>
	/** Refreshes the menu only when it is older than `maxAgeMs` and the till is online. */
	refreshIfStale: (maxAgeMs: number) => Promise<void>
	updateSettings: (patch: Partial<PosSettings>) => Promise<void>
	setOnline: (online: boolean) => void
	sync: (force?: boolean) => Promise<void>
	/** Learns early whether this terminal was removed, before it takes a sale. */
	verifyPairing: () => Promise<void>
	/** Open tabs on this location's other terminals (online only). */
	otherTabs: () => Promise<
		{ ok: true; tabs: OtherTab[] } | { ok: false; error: string }
	>
	/** Takes a tab over from another terminal. Returns an error message, or null. */
	takeOverTab: (tab: OtherTab) => Promise<string | null>
	/** Signs a person in with their PIN. Resolves to what happened, never throws. */
	signIn: (pin: string) => Promise<SignInOutcome>
	/** Checks a manager's PIN for an approval, without changing who is signed in. */
	approve: (pin: string) => Promise<ApprovalOutcome>
	/** Sign-in is on and the person signed in is not a manager: changes need approval. */
	needsManager: () => boolean
	/** Locks the till (also "switch user"): the order on screen is kept. */
	lock: () => void
	noteUnrecognised: () => void
	/** Pairs from a pasted code or link. Returns an error message, or null on success. */
	pair: (input: string) => Promise<string | null>
	unpair: () => void

	setOrderType: (type: OrderType) => void
	setPhoneOrder: (details: PhonePickup) => void
	setCounterOrder: () => void
	setCustomerName: (name: string) => void
	setTableLabel: (label: string) => void
	addLine: (line: Omit<CartLine, 'id'>) => void
	setQuantity: (lineId: string, quantity: number) => void
	replaceLine: (lineId: string, line: Omit<CartLine, 'id'>) => void
	removeLine: (lineId: string) => void
	loadTab: (order: PosOrder) => void
	clearOrder: () => void
}

const newId = () => crypto.randomUUID()

export type OtherTab = {
	terminal: { code: string; label: string; removed?: boolean }
	order: ServerTab
}

const apiUrl = (settings: PosSettings, path: string) =>
	`${settings.tenantApiUrl.replace(/\/+$/, '')}${path}`

/** Every item of a menu by id (subcategories included). */
function itemsById(menu: MenuPayload): Map<string, MenuItem> {
	const items = new Map<string, MenuItem>()
	const walk = (category: MenuCategory) => {
		for (const item of category.items) items.set(item.id, item)
		category.subcategories?.forEach(walk)
	}
	for (const m of menu.menus) m.categories.forEach(walk)
	return items
}

/**
 * A line as this till shows it: its names in the till's language when the
 * menu still has the item, else as recorded (decoded if saved as raw maps).
 */
export function shownLine<T extends Parameters<typeof renameLine>[0]>(
	line: T,
): T {
	return renameLine(
		decodedLine(line),
		usePos.getState().shownItems.get(line.itemId),
	)
}

/**
 * A line of a sale as this till shows it: an open tab in the till's language,
 * a closed sale as it was sold (what its receipt and invoice say, whatever the
 * menu says today).
 */
export function saleLine<T extends Parameters<typeof renameLine>[0]>(
	line: T,
	open: boolean,
): T {
	return open ? shownLine(line) : decodedLine(line)
}

/** An item's name as this till shows it, else as recorded (for removed lines). */
export function shownItemName(itemId: string, recorded: string): string {
	return (
		usePos.getState().shownItems.get(itemId)?.displayName || menuText(recorded)
	)
}

function adopt(snapshot: CatalogSnapshot, settings: PosSettings) {
	// Names and descriptions in the till's language: the published menu keeps
	// every translation (`{"en":…,"ar":…}`). The snapshot itself stays as
	// published, so a language switch only reads it again.
	const menu = localizeMenu(
		snapshot.menu,
		effectiveLocale(
			settings.locale ?? null,
			snapshot.menu.organization.defaultLocale,
		),
	)
	// A terminal bound to a location sells only there. If that location is not on
	// the published menu, never fall back to another one: its taxes and prices
	// would be wrong and the server would refuse every sale.
	const bound = settings.locationLocked
		? menu.locations.find((l) => l.id === settings.locationId)
		: undefined
	const locationMissing = settings.locationLocked && !bound
	const location = locationMissing
		? null
		: (bound ?? pickLocation(menu, settings.locationId) ?? null)
	const categories = location ? buildCategories(menu, location.id) : []
	const record = localizeMenu(
		snapshot.menu,
		recordLocale(snapshot.menu, location),
	)
	applyTheme(snapshot.organization)
	document.title = `${snapshot.organization.name} · Station`
	return {
		snapshot,
		location,
		locationMissing,
		categories,
		recordItems: itemsById(record),
		shownItems: itemsById(menu),
		catalogStatus: (categories.length > 0 ? 'ready' : 'empty') as CatalogStatus,
		catalogError: null,
	}
}

export const usePos = create<PosState>((set, get) => ({
	settings: loadSettings(),
	snapshot: null,
	categories: [],
	recordItems: new Map(),
	shownItems: new Map(),
	location: null,
	catalogStatus: 'loading',
	catalogError: null,
	refreshing: false,
	online: typeof navigator === 'undefined' ? true : navigator.onLine,
	pairingLost: false,
	session: null,
	unrecognisedStrikes: 0,
	locationMissing: false,

	orderType: 'dine_in',
	orderSource: 'counter',
	customerPhone: '',
	pickupAt: null,
	pickupTimeZone: null,
	customerName: '',
	tableLabel: '',
	lines: [],
	activeOrderId: null,
	activeTax: null,
	adjustments: [],

	async boot() {
		const { settings } = get()
		// Offline first: paint from the device copy, then try to refresh behind it.
		const cached = await loadCachedCatalog()
		if (
			cached &&
			(settings.demo ||
				cached.organization.slug === settings.slug.trim().toLowerCase())
		) {
			set(adopt(cached, settings))
		} else if (!isConfigured(settings)) {
			set({ catalogStatus: 'empty' })
			return
		}
		await get().refresh()
		void get()
			.verifyPairing()
			.then(() => get().sync())
	},

	async refresh() {
		const { settings } = get()
		if (!isConfigured(settings)) return
		set({ refreshing: true })
		const result = await refreshCatalog(settings)
		if (result.ok) {
			set({ ...adopt(result.snapshot, settings), refreshing: false })
		} else {
			// Keep selling from the copy on the device; only say so when there is none.
			set((s) => ({
				refreshing: false,
				catalogError: result.error,
				catalogStatus: s.snapshot ? s.catalogStatus : 'error',
			}))
		}
	},

	async refreshIfStale(maxAgeMs) {
		const { snapshot, online, refreshing } = get()
		if (!online || refreshing) return
		if (snapshot && Date.now() - snapshot.fetchedAt < maxAgeMs) return
		await get().refresh()
	},

	async updateSettings(patch) {
		const before = get().settings
		const settings = { ...before, ...patch }
		// A different restaurant or workplace has different staff: never let the old
		// ones sign in offline.
		if (
			settings.slug !== before.slug ||
			settings.scopeId !== before.scopeId ||
			settings.tenantApiUrl !== before.tenantApiUrl
		)
			await forgetCachedStaff()
		// Punches waiting for another restaurant must never be sent to this one:
		// their PINs would be checked against the wrong staff.
		if (
			settings.slug !== before.slug ||
			settings.tenantApiUrl !== before.tenantApiUrl
		)
			await punchQueue()
				.wipe()
				.catch(() => {})
		saveSettings(settings)
		set({ settings })
		const slugChanged =
			patch.slug !== undefined ||
			patch.appUrl !== undefined ||
			patch.demo !== undefined
		if (slugChanged) {
			set({ snapshot: null, categories: [], catalogStatus: 'loading' })
			applyTheme(null)
			await get().refresh()
		} else if (patch.locationId !== undefined || patch.locale !== undefined) {
			// Another location, or another language for the menu's names.
			const { snapshot } = get()
			if (snapshot) set(adopt(snapshot, settings))
		}
		void get().sync()
	},

	setOnline(online) {
		set({ online })
		if (online)
			void get()
				.verifyPairing()
				.then(() => get().sync())
	},

	async sync(force = false) {
		const sent = await flushOutbox(get().settings, {
			force,
			onUnrecognised: () => get().noteUnrecognised(),
			onUnpaired: () => {
				// Forget the dead secret; the queued orders stay and send after re-pairing.
				// A removed terminal cannot check PINs or send orders: drop the lock so a
				// manager can pair it again from Settings.
				const settings = {
					...get().settings,
					deviceToken: null,
					signInRequired: false,
					apps: { timeclock: false, reservations: false },
				}
				saveSettings(settings)
				set({ settings, pairingLost: true, session: null })
				void forgetZatcaUnit()
			},
		})
		// Punches waiting since the till was offline go out in their own queue.
		// Any too old to record are set aside first, PINs dropped, even when this
		// till cannot send them (unpaired, removed or offline).
		await expirePunches().catch(() => 0)
		const punches = await flushPunches(get().settings, get().online).catch(
			() => null,
		)
		if (punches?.deviceGone) void get().verifyPairing()
		// Orders going through proves the server knows us.
		if (sent > 0 && get().unrecognisedStrikes > 0) {
			set({
				unrecognisedStrikes: 0,
				pairingLost: get().settings.deviceToken === null && get().pairingLost,
			})
		}
	},

	async verifyPairing() {
		const { verdict, device, apps, transfers, fiscalChains, zatca } =
			await checkDeviceDetailed(get().settings)
		if (verdict === 'ok') {
			if (get().unrecognisedStrikes > 0 || get().pairingLost)
				set({ unrecognisedStrikes: 0, pairingLost: false })
			// A manager may have changed sign-in or the end of the business day in the Menuza app.
			const current = get().settings
			if (
				device &&
				(device.signInRequired !== current.signInRequired ||
					device.scopeId !== current.scopeId ||
					device.shiftsRequired !== current.shiftsRequired ||
					(device.dayStartMinutes !== null &&
						device.dayStartMinutes !== current.dayStartMinutes))
			) {
				// Another workplace has other staff: nobody from the old one signs in offline.
				if (device.scopeId !== current.scopeId) await forgetCachedStaff()
				const settings = {
					...current,
					signInRequired: device.signInRequired,
					scopeId: device.scopeId,
					dayStartMinutes: device.dayStartMinutes ?? current.dayStartMinutes,
					shiftsRequired: device.shiftsRequired,
				}
				saveSettings(settings)
				set({ settings })
			}
			// A manager may have turned the time clock or the host stand on or off.
			const before = get().settings.apps
			const after = { ...before, ...apps }
			if (
				after.timeclock !== before.timeclock ||
				after.reservations !== before.reservations
			) {
				const settings = { ...get().settings, apps: after }
				saveSettings(settings)
				set({ settings })
			}
			// Tabs another terminal took over stop being open here.
			if (transfers && transfers.length > 0)
				await markTransferredAway(transfers)
			// A till whose storage was lost continues its fiscal chain rather than restarting it.
			if (fiscalChains && fiscalChains.length > 0)
				await adoptServerChain(fiscalChains)
			// An onboarded ZATCA unit signs its invoices here, offline if need be.
			await syncZatcaUnit(get().settings, zatca ?? null)
			return
		}
		if (verdict === 'unrecognised') return get().noteUnrecognised()
		if (verdict !== 'removed') return
		const settings = {
			...get().settings,
			deviceToken: null,
			signInRequired: false,
			apps: { timeclock: false, reservations: false },
		}
		saveSettings(settings)
		set({ settings, pairingLost: true, session: null })
		// A removed terminal must not keep a key that signs invoices in the restaurant's name.
		await forgetZatcaUnit()
	},

	async otherTabs() {
		const { settings, online } = get()
		if (settings.demo || !settings.deviceToken || !settings.tenantApiUrl) {
			return {
				ok: false,
				error: t`This terminal is not paired with a restaurant.`,
			}
		}
		if (!online)
			return {
				ok: false,
				error: t`Connect to the internet to see other terminals’ tabs.`,
			}
		try {
			const response = await fetch(apiUrl(settings, '/pos/tabs'), {
				headers: { Authorization: `Bearer ${settings.deviceToken}` },
				signal: AbortSignal.timeout(8_000),
			})
			if (!response.ok)
				return { ok: false, error: t`The server answered ${response.status}.` }
			const body = (await response.json()) as { tabs: OtherTab[] }
			return { ok: true, tabs: body.tabs }
		} catch {
			return { ok: false, error: t`Could not reach the server.` }
		}
	},

	async takeOverTab(tab) {
		const { settings, session } = get()
		if (!settings.deviceToken)
			return t`This terminal is not paired with a restaurant.`
		// Refuse before claiming: a claimed tab this till cannot bill would be stranded.
		if (!canAdoptTab(tab.order))
			return t`This tab has no tax rate on the server, so it cannot be billed here. Settle it on the terminal that opened it.`
		let claimed: ServerTab
		try {
			const response = await fetch(
				apiUrl(settings, `/pos/tabs/${encodeURIComponent(tab.order.id)}/claim`),
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${settings.deviceToken}`,
					},
					body: JSON.stringify({
						revision: tab.order.revision,
						staffId: session?.staff.id ?? null,
					}),
					signal: AbortSignal.timeout(8_000),
				},
			)
			const body = (await response.json().catch(() => ({}))) as {
				order?: ServerTab
				message?: string
				error?: string
			}
			const status = response.status
			if (!response.ok || !body.order)
				return body.message ?? body.error ?? t`The server answered ${status}.`
			claimed = body.order
		} catch {
			return t`Could not reach the server. The tab stays where it is.`
		}
		try {
			await adoptTab(claimed, settings.slug.trim().toLowerCase())
			return null
		} catch (e) {
			return e instanceof Error
				? e.message
				: t`The tab was taken over but could not be saved on this device.`
		}
	},

	async signIn(pin) {
		const { settings, online } = get()
		const outcome = await attemptSignIn(pin, {
			tenantApiUrl: settings.tenantApiUrl,
			deviceToken: settings.deviceToken,
			demo: settings.demo,
			online,
		})
		if (outcome.ok) {
			touch()
			set({ session: outcome.session })
		} else if (
			outcome.reason === 'sign_in_off' ||
			outcome.reason === 'terminal_removed'
		) {
			// The server says the situation changed: pick it up now rather than at the next check.
			void get().verifyPairing()
		}
		return outcome
	},

	approve(pin) {
		const { settings, online } = get()
		return approveAsManager(pin, {
			tenantApiUrl: settings.tenantApiUrl,
			deviceToken: settings.deviceToken,
			demo: settings.demo,
			online,
		})
	},

	needsManager() {
		const { settings, session } = get()
		return settings.signInRequired && session?.role !== 'manager'
	},

	lock() {
		set({ session: null })
	},

	// "Not recognised" is not "removed": a node answers it while it cannot reach the
	// control plane. Never wipe the secret on it. After three in a row, warn that
	// the terminal may need pairing again, and let any later success clear it.
	noteUnrecognised() {
		const strikes = get().unrecognisedStrikes + 1
		set({
			unrecognisedStrikes: strikes,
			pairingLost: strikes >= 3 || get().pairingLost,
		})
	},

	async pair(input) {
		const parsed = parsePairingInput(input)
		if (!parsed) return t`That does not look like a pairing code or link.`
		let settings = get().settings
		// A link configures the whole terminal; a bare code uses what is already set.
		settings = {
			...settings,
			tenantApiUrl: parsed.tenantApiUrl ?? settings.tenantApiUrl,
			appUrl: parsed.appUrl ?? settings.appUrl,
			slug: parsed.slug ?? settings.slug,
			demo: parsed.slug || parsed.appUrl ? false : settings.demo,
		}
		// https only, and only servers this deployment names (see `serverOriginProblem`).
		const problem = serversProblem([settings.tenantApiUrl, settings.appUrl])
		if (problem) return problem
		const result = await pairTerminal(settings.tenantApiUrl, parsed.code)
		if (!result.ok) return result.error
		const next = withPairing(settings, result)
		await get().updateSettings({ ...next })
		set({ pairingLost: false })
		// Learn which Station apps this terminal offers now, not at the next check.
		void get().verifyPairing()
		// Anything saved while unpaired goes out now, not after a retry timer.
		void get().sync(true)
		return null
	},

	unpair() {
		const settings = {
			...get().settings,
			deviceToken: null,
			deviceLabel: null,
			locationLocked: false,
			signInRequired: false,
			apps: { timeclock: false, reservations: false },
		}
		saveSettings(settings)
		set({ settings, pairingLost: false, session: null })
		void forgetCachedStaff()
		void forgetZatcaUnit()
		// Waiting and refused punches stay: unpairing is how a till the server
		// stopped recognising is paired again, and they may be the only record of
		// a shift. Pairing to another restaurant wipes them (updateSettings), and
		// each carries its person's id, so the server refuses one whose PIN now
		// belongs to someone else. Once too old to record, `sync` sets them aside
		// and drops their PINs.
	},

	setOrderType: (orderType) =>
		set((s) => ({
			orderType: s.orderSource === 'phone' ? 'takeaway' : orderType,
		})),
	setPhoneOrder: (details) =>
		set({
			...details,
			orderSource: 'phone',
			orderType: 'takeaway',
			tableLabel: '',
		}),
	setCounterOrder: () =>
		set({
			orderSource: 'counter',
			customerName: '',
			customerPhone: '',
			pickupAt: null,
			pickupTimeZone: null,
		}),
	setCustomerName: (customerName) => set({ customerName }),
	setTableLabel: (tableLabel) => set({ tableLabel }),

	addLine(added) {
		set((s) => {
			// One language of record for every line, whichever till rings it up.
			const line = renameLine(added, s.recordItems.get(added.itemId))
			const signature = lineSignature(line)
			const existing = s.lines.find((l) => lineSignature(l) === signature)
			if (existing) {
				return {
					lines: s.lines.map((l) =>
						l.id === existing.id
							? { ...l, quantity: Math.min(50, l.quantity + line.quantity) }
							: l,
					),
				}
			}
			return { lines: [...s.lines, { ...line, id: newId() }] }
		})
	},
	setQuantity(lineId, quantity) {
		set((s) => ({
			lines:
				quantity <= 0
					? s.lines.filter((l) => l.id !== lineId)
					: s.lines.map((l) =>
							l.id === lineId ? { ...l, quantity: Math.min(50, quantity) } : l,
						),
		}))
	},
	replaceLine(lineId, line) {
		set((s) => ({
			lines: s.lines.map((l) =>
				l.id === lineId
					? { ...renameLine(line, s.recordItems.get(line.itemId)), id: lineId }
					: l,
			),
		}))
	},
	removeLine: (lineId) =>
		set((s) => ({ lines: s.lines.filter((l) => l.id !== lineId) })),
	loadTab: (order) =>
		set({
			activeOrderId: order.id,
			activeTax: {
				taxRatePercent: order.taxRatePercent,
				taxInclusive: order.taxInclusive,
			},
			orderType: order.orderType,
			orderSource: order.orderSource ?? 'counter',
			customerPhone: order.customerPhone ?? '',
			pickupAt: order.pickupAt ?? null,
			pickupTimeZone: order.pickupTimeZone ?? null,
			customerName: order.customerName,
			tableLabel: order.tableLabel,
			// A tab opened before (or on a till in another language) continues in
			// the language of record, so its documents read one language.
			lines: order.lines.map((line) =>
				renameLine(decodedLine(line), get().recordItems.get(line.itemId)),
			),
			adjustments: order.adjustments,
		}),
	clearOrder: () =>
		set({
			lines: [],
			orderSource: 'counter',
			customerPhone: '',
			pickupAt: null,
			pickupTimeZone: null,
			customerName: '',
			tableLabel: '',
			adjustments: [],
			activeOrderId: null,
			activeTax: null,
		}),
}))

// Punches saved while the tablet slept go out the moment it wakes, not on the
// next sync tick: an offline punch is only recorded within 48 hours, and a
// till shut overnight should not spend the morning waiting.
if (typeof document !== 'undefined')
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible' && usePos.getState().online)
			void usePos.getState().sync()
	})
