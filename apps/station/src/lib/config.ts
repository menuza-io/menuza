import { NO_POS_DEVICE_APPS, type PosDeviceApps } from '@repo/common/pos-orders'
import { type TerminalJsonSettings } from '@repo/common/terminal-profiles'
import { isTrainingMode } from './training-flag.ts'

export const MENU_COLUMNS_VALUES = ['auto', 2, 3, 4] as const
export type MenuColumns = (typeof MENU_COLUMNS_VALUES)[number]
export const MENU_DENSITIES = ['comfortable', 'compact'] as const
export type MenuDensity = (typeof MENU_DENSITIES)[number]

/**
 * Device settings, kept in localStorage so the shell can boot with no network
 * and no IndexedDB round-trip. Nothing here is a secret except `deviceToken`.
 *
 * `deviceToken` reaches further than this terminal's own uploads: it signs
 * staff in by PIN (`/pos/sign-in`), lists and claims other terminals' open tabs
 * at its location, with guest names and callback numbers (`/pos/tabs`), and
 * fetches this till's ZATCA signing key and certificate (`/pos/zatca`). Treat
 * it like a password: unpairing or removal forgets it together with the ZATCA
 * key (see `forgetZatcaUnit`), and only an operator can issue a new one.
 */
export type PosSettings = {
	/** App origin that serves the published catalog and branding. */
	appUrl: string
	/** Business slug, as in the restaurant's site address. */
	slug: string
	/** Regional tenant-api origin that receives orders. */
	tenantApiUrl: string
	/** Short code printed in front of order numbers, e.g. `T1`. */
	terminalCode: string
	locationId: string | null
	/** The workplace whose staff PINs sign in here. */
	scopeId: string
	/** Locks the till until a staff member signs in with their PIN. Set by the server. */
	signInRequired: boolean
	/** Minutes after midnight when the business day turns over. Set by the server. */
	dayStartMinutes: number
	/** Sell only inside an open cash drawer shift. Set by the server. */
	shiftsRequired: boolean
	/** Seconds of no touching before the till locks (0: never). Device-local, set by a manager. */
	idleLockSeconds: number
	/** True when the server bound this terminal to `locationId`; it then cannot be changed here. */
	locationLocked: boolean
	deviceToken: string | null
	/** Name a manager gave this terminal when pairing it. */
	deviceLabel: string | null
	/** Seeds a sample menu so the UI can be explored without a backend. */
	demo: boolean
	/** Interface language chosen on this device; null follows the restaurant's default. */
	locale: 'en' | 'ar' | null
	/** Menu grid columns on this terminal ('auto' or 2, 3, 4). */
	menuColumns?: MenuColumns
	/** Menu tile density on this terminal ('comfortable' or 'compact'). */
	menuDensity?: MenuDensity
	/** Station apps beside the till, as the server last reported them. */
	apps: PosDeviceApps
	/** The app on screen, kept per device so a host stand reopens as a host stand. */
	activeApp: StationApp
	/**
	 * Settings the server set for this terminal (its profile, or a manager in the
	 * App): the till follows them and shows them locked. A setting not listed is
	 * the till's own choice.
	 */
	managed?: Partial<TerminalJsonSettings>
	/** The terminal profile this terminal follows, by name. */
	profileName?: string | null
}

/** The apps a Station tablet can show: the till, the time clock, the host stand, the kitchen, Stock, Orders. */
export type StationApp =
	'pos' | 'timeclock' | 'reservations' | 'kitchen' | 'stock' | 'orders'

/**
 * The active app if the terminal still offers it, else the till. A till where
 * staff sign in opens its time clock over the lock instead (nobody punches
 * from inside someone else's session), so it never shows it as an app.
 */
export function shownApp(
	s: Pick<PosSettings, 'apps' | 'activeApp' | 'signInRequired'>,
): StationApp {
	// A training till only sells: every other app acts on real data (#383).
	if (isTrainingMode()) return 'pos'
	if (s.activeApp === 'timeclock' && s.apps.timeclock && !s.signInRequired)
		return 'timeclock'
	if (s.activeApp === 'reservations' && s.apps.reservations)
		return 'reservations'
	if (s.activeApp === 'kitchen') return 'kitchen'
	// Stock is offered by the terminal's `inventory` setting (and the organization's flag).
	if (s.activeApp === 'stock' && s.apps.inventory) return 'stock'
	if (s.activeApp === 'orders' && s.apps.orders) return 'orders'
	return 'pos'
}

const KEY = 'pos.settings.v1'

const defaults = (): PosSettings => ({
	appUrl: import.meta.env.VITE_APP_URL ?? '',
	slug: import.meta.env.VITE_ORG_SLUG ?? '',
	tenantApiUrl: import.meta.env.VITE_TENANT_API_URL ?? '',
	terminalCode: 'T1',
	locationId: null,
	locationLocked: false,
	scopeId: 'main',
	signInRequired: false,
	dayStartMinutes: 240,
	shiftsRequired: false,
	idleLockSeconds: 120,
	deviceToken: null,
	deviceLabel: null,
	demo: import.meta.env.VITE_POS_DEMO === '1',
	locale: null,
	menuColumns: 'auto',
	menuDensity: 'comfortable',
	apps: { ...NO_POS_DEVICE_APPS },
	activeApp: 'pos',
	managed: {},
	profileName: null,
})

function parseMenuColumns(raw: unknown): MenuColumns {
	return raw === 2 || raw === 3 || raw === 4 || raw === 'auto' ? raw : 'auto'
}

function parseMenuDensity(raw: unknown): MenuDensity {
	return raw === 'compact' ? 'compact' : 'comfortable'
}

/** Grid column class shared by the menu grid and the settings live preview. */
export function menuGridColumnsClass(
	columns: MenuColumns,
	density: MenuDensity,
): string {
	switch (columns) {
		case 2:
			return 'grid-cols-2'
		case 3:
			return 'grid-cols-3'
		case 4:
			return 'grid-cols-4'
		case 'auto':
		default:
			return density === 'compact'
				? 'grid-cols-[repeat(auto-fill,minmax(min(100%,8rem),1fr))] sm:grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))]'
				: 'grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))] sm:grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))]'
	}
}

export function loadSettings(): PosSettings {
	try {
		const raw = localStorage.getItem(KEY)
		if (raw) {
			const saved = JSON.parse(raw) as Partial<PosSettings>
			// Settings saved before an app existed read that app as off.
			return {
				...defaults(),
				...saved,
				menuColumns: parseMenuColumns(saved.menuColumns),
				menuDensity: parseMenuDensity(saved.menuDensity),
				apps: { ...NO_POS_DEVICE_APPS, ...saved.apps },
				managed: { ...saved.managed },
			}
		}
	} catch {
		/* private mode or corrupt value: fall back to defaults */
	}
	return defaults()
}

export function saveSettings(next: PosSettings): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(next))
	} catch {
		/* storage unavailable: settings last for this session only */
	}
}

export const isConfigured = (s: PosSettings): boolean =>
	s.demo || Boolean(s.appUrl && s.slug)

/**
 * The settings after the server's managed values are applied, or null when
 * nothing changed. The lock timeout and menu layout take the server's value;
 * the kitchen station and guest screen are read from `managed` where they are
 * used. A setting the server stopped managing keeps its last value as the
 * till's own.
 */
export function managedSettingsPatch(
	current: PosSettings,
	managed: Partial<TerminalJsonSettings>,
	profileName: string | null,
): PosSettings | null {
	const next: PosSettings = {
		...current,
		managed,
		profileName,
		idleLockSeconds: managed.idleLockSeconds ?? current.idleLockSeconds,
		menuColumns: managed.menuColumns ?? current.menuColumns,
		menuDensity: managed.menuDensity ?? current.menuDensity,
	}
	const same =
		JSON.stringify(current.managed ?? {}) === JSON.stringify(managed) &&
		(current.profileName ?? null) === profileName &&
		next.idleLockSeconds === current.idleLockSeconds &&
		next.menuColumns === current.menuColumns &&
		next.menuDensity === current.menuDensity
	return same ? null : next
}
