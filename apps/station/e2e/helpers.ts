import {
	expect,
	test as base,
	type BrowserContext,
	type Locator,
	type Page,
} from '@playwright/test'
import { posOrderRequestSchema } from '@repo/common/pos-orders'

export const API = 'http://127.0.0.1:4711'
export const APP = 'http://127.0.0.1:4710'
export const SETTINGS_KEY = 'pos.settings.v1'

/** What the backend harness exposes for inspection and control. */
export const backend = {
	async post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
		const response = await fetch(`${API}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})
		return (await response.json()) as T
	},
	async get<T = unknown>(path: string): Promise<T> {
		return (await (await fetch(`${API}${path}`)).json()) as T
	},
	reset: () => backend.post('/__test/reset'),
	pairingCode: (
		body: {
			label?: string
			terminalCode?: string
			locationId?: string | null
			ttlMs?: number
			signInRequired?: boolean
			shiftsRequired?: boolean
		} = {},
	) =>
		backend.post<{ code: string; link: string; terminalCode: string }>(
			'/__test/pairing-code',
			body,
		),
	orders: async () =>
		(await backend.get<{ orders: StoredOrder[] }>('/__test/orders')).orders,
	devices: async () =>
		(await backend.get<{ devices: StoredDevice[] }>('/__test/devices')).devices,
	requests: async () =>
		(
			await backend.get<{
				requests: Array<{
					method: string
					path: string
					status: number
					idempotencyKey: string | null
				}>
			}>('/__test/requests')
		).requests,
	outage: (status = 503, count = -1) =>
		backend.post('/__test/outage', { status, count }),
	clearOutage: () => backend.post('/__test/outage', { clear: true }),
	liveMenu: (body: {
		prices?: Record<string, number>
		remove?: string[]
		publish?: boolean
	}) => backend.post('/__test/live-menu', body),
	publish: () => backend.post('/__test/publish'),
	theme: (body: Record<string, unknown>) => backend.post('/__test/theme', body),
	addStaff: async (
		body: {
			first?: string
			last?: string
			pin?: string | null
			manager?: boolean
			scopeId?: string
			status?: string
		} = {},
	) => (await backend.post<{ id: string }>('/__test/staff', body)).id,
	updateStaff: (body: {
		id: string
		pin?: string
		status?: string
		manager?: boolean
	}) => backend.post('/__test/staff-update', body),
	setSignIn: (id: string, signInRequired: boolean) =>
		backend.post('/__test/terminal', { id, signInRequired }),
	location: (patch: Record<string, unknown>) =>
		backend.post('/__test/location', patch),
	overrides: (overrides: Array<Record<string, unknown>>, publish = true) =>
		backend.post('/__test/overrides', { overrides, publish }),
	revoke: (deviceId: string) => backend.post('/__test/revoke', { deviceId }),
	shifts: async () =>
		(
			await backend.get<{
				shifts: Array<{
					shift: {
						status: string
						countedCashCents: number | null
						tillExpectedCashCents: number | null
						movements: Array<{
							kind: string
							amountCents: number
							note: string
						}>
					}
					summary: { cash: { expectedCents: number }; orders: { paid: number } }
					overShortCents: number | null
				}>
			}>('/__test/shifts')
		).shifts,
	zatca: (body: { vatNumber?: string } = {}) =>
		backend.post<{ ok: boolean }>('/__test/zatca', body),
	zatcaSubmissions: async () =>
		(
			await backend.get<{
				submissions: Array<{ status: string; kind: string; counter: number }>
			}>('/__test/zatca-submissions')
		).submissions,
}

export type StoredOrder = {
	id: string
	number: string
	businessDate: string
	revision: number
	status: 'open' | 'paid' | 'void' | 'refunded'
	orderType: string
	orderSource?: 'counter' | 'phone'
	customerPhone?: string | null
	pickupAt?: number | null
	pickupTimeZone?: string | null
	guestName: string | null
	tableLabel: string | null
	staff: { id: string; name: string } | null
	signIn: 'online' | 'offline' | null
	voidedBy: { id: string; name: string } | null
	voidReason?: string | null
	voidApprovedBy?: { id: string; name: string } | null
	lineVoids?: Array<{
		name: string
		quantity: number
		reason: string
		by: { name: string } | null
		approvedBy: { name: string } | null
	}>
	refunds?: Array<{
		method: string
		amountCents: number
		reason: string
		approvedBy: { name: string } | null
	}>
	refundedCents?: number
	totalCents: number
	subtotalCents: number
	taxCents: number
	tipCents: number
	serverTotalCents: number | null
	reviewReason: string | null
	currency: string
	locationName: string | null
	lines: Array<{
		name: string
		quantity: number
		baseCents: number
		variantLabel: string | null
		instructions: string
		options: Array<{ optionName: string; unitCents: number }>
	}>
	payments: Array<{
		id: string
		method: string
		amountCents: number
		tenderedCents: number
		reference?: string | null
		staff: { id: string; name: string } | null
	}>
}
export type StoredDevice = {
	id: string
	label: string
	terminalCode: string
	revokedAt: number | null
	lastSeenAt: number | null
	signInRequired: boolean
	scopeId: string
}

const demoSettings = {
	appUrl: '',
	slug: '',
	tenantApiUrl: '',
	terminalCode: 'T1',
	locationId: null,
	deviceToken: null,
	deviceLabel: null,
	demo: true,
}

/** Seeds settings once (never overwriting what the app saved itself, so reloads keep state). */
export async function seedSettings(
	context: BrowserContext,
	settings: Record<string, unknown>,
) {
	await context.addInitScript(
		([key, value]) => {
			try {
				if (!localStorage.getItem(key as string))
					localStorage.setItem(key as string, JSON.stringify(value))
			} catch {
				/* storage blocked */
			}
		},
		[SETTINGS_KEY, settings] as const,
	)
}

export const test = base.extend<{
	/** Wipes backend state. `page` depends on it, so it runs before every other fixture. */
	resetBackend: void
	/** Demo mode: sample menu, no backend, no pairing. */
	demo: Page
	/** Nothing configured at all: the first-run setup screen. */
	fresh: Page
	/** Real stack: not yet paired, pointed at the harness. Pair with `pairUi` or `pairViaLink`. */
	unpaired: Page
	/** Real stack, already paired through the UI. */
	paired: Page
}>({
	// `test.beforeEach` runs AFTER fixtures are set up, which would wipe a terminal
	// a fixture had just paired. Resetting inside the fixture chain keeps tests
	// independent of the order they run in.
	// Playwright requires the destructuring pattern, even when empty.
	// oxlint-disable-next-line no-empty-pattern
	resetBackend: async ({}, use) => {
		await backend.reset()
		await use()
	},
	page: async ({ page, resetBackend }, use) => {
		void resetBackend
		await use(page)
	},
	demo: async ({ page, context }, use) => {
		await seedSettings(context, demoSettings)
		await page.goto('/')
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		await use(page)
	},
	fresh: async ({ page }, use) => {
		await page.goto('/')
		await expect(
			page.getByRole('heading', { name: 'Set up this terminal' }),
		).toBeVisible()
		await use(page)
	},
	unpaired: async ({ page, context }, use) => {
		await seedSettings(context, {
			...demoSettings,
			demo: false,
			appUrl: APP,
			slug: 'demo',
			tenantApiUrl: API,
		})
		await page.goto('/')
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		await use(page)
	},
	paired: async ({ page, context }, use) => {
		await seedSettings(context, {
			...demoSettings,
			demo: false,
			appUrl: APP,
			slug: 'demo',
			tenantApiUrl: API,
		})
		await page.goto('/')
		await expect(
			page.getByRole('heading', { name: 'Demo Kitchen' }),
		).toBeVisible()
		await pairUi(page)
		await use(page)
	},
})

export { expect }

// ---------------------------------------------------------------------------
// Till actions
// ---------------------------------------------------------------------------

/** Pairs through Settings with a freshly minted code. Returns the terminal code. */
export async function pairUi(
	page: Page,
	options: {
		label?: string
		terminalCode?: string
		locationId?: string | null
		signInRequired?: boolean
		shiftsRequired?: boolean
	} = {},
) {
	const { code, terminalCode } = await backend.pairingCode(options)
	await page.getByRole('button', { name: 'Settings' }).click()
	await page.getByLabel('Pairing link or code').fill(code)
	await page.getByRole('button', { name: 'Pair terminal' }).click()
	// Pairing is done when the settings sheet closes and the server knows the terminal
	// (a till that requires sign-in locks at once, so "no dialogs" would never be true).
	await expect(
		page.getByRole('dialog', {
			name: /Terminal settings|Set up this terminal/,
		}),
	).toHaveCount(0)
	await expect
		.poll(async () =>
			(await backend.devices()).some(
				(d) => d.revokedAt === null && d.terminalCode === terminalCode,
			),
		)
		.toBe(true)
	return terminalCode
}

export const cart = (page: Page) =>
	page.getByRole('region', { name: 'Current order' })
export const dialog = (page: Page) => page.getByRole('dialog')

export const menuItem = (page: Page, name: string) =>
	page.getByRole('button', { name: new RegExp(`^${name},`) })

export async function openCategory(page: Page, name: string) {
	await page
		.getByRole('navigation', { name: 'Categories' })
		.getByRole('button', { name: new RegExp(`^${name}`) })
		.click()
}

/** Tap an item that needs no choices. */
export async function addQuick(page: Page, name: string) {
	await menuItem(page, name).click()
}

/** Open an item's sheet and return it. */
export async function openItem(page: Page, name: string) {
	await menuItem(page, name).click()
	const sheet = dialog(page)
	await expect(sheet.getByRole('heading', { name })).toBeVisible()
	return sheet
}

export async function choose(sheet: Locator, option: string | RegExp) {
	await sheet.getByRole('button', { name: option }).click()
}

export async function confirmAdd(
	sheet: Locator,
	label: RegExp = /^(Add|Update) ·/,
) {
	await sheet.getByRole('button', { name: label }).click()
}

/** Reads "$12.34" into cents. */
export const cents = (text: string | null) =>
	Math.round(Number((text ?? '').replace(/[^0-9.-]/g, '')) * 100)

export async function chargeButtonTotal(page: Page) {
	return cents(
		await cart(page)
			.getByRole('button', { name: /^Charge/ })
			.textContent(),
	)
}

export async function startCharge(page: Page) {
	await cart(page)
		.getByRole('button', { name: /^Charge/ })
		.click()
	await expect(
		dialog(page).getByRole('heading', { name: /^(Charge|Pay)/ }),
	).toBeVisible()
	return dialog(page)
}

export async function typeKeypad(scope: Locator, digits: string) {
	for (const digit of digits)
		await scope
			.getByRole('group', { name: 'Keypad' })
			.getByRole('button', { name: digit, exact: true })
			.click()
}

/** Wait until the backend holds `count` orders (the outbox is asynchronous). */
export async function expectStored(count: number, timeout = 15_000) {
	await expect
		.poll(async () => (await backend.orders()).length, { timeout })
		.toBe(count)
	return backend.orders()
}

/** Every stored order must also satisfy the shared wire contract once re-read. */
export function assertWireContract(body: unknown) {
	const parsed = posOrderRequestSchema.safeParse(body)
	expect(
		parsed.success,
		JSON.stringify(parsed.success ? '' : parsed.error.issues),
	).toBe(true)
}

export async function goOffline(context: BrowserContext, page: Page) {
	await context.setOffline(true)
	await page.evaluate(() => window.dispatchEvent(new Event('offline')))
}

export async function goOnline(context: BrowserContext, page: Page) {
	await context.setOffline(false)
	await page.evaluate(() => window.dispatchEvent(new Event('online')))
}

export async function openOrders(page: Page, view?: 'open' | 'today') {
	await page.getByRole('button', { name: /^Orders/ }).click()
	const sheet = dialog(page)
	await expect(sheet.getByRole('heading', { name: 'Orders' })).toBeVisible()
	if (view === 'open')
		await sheet.getByRole('radio', { name: /^Open tabs/ }).click()
	if (view === 'today')
		await sheet.getByRole('radio', { name: /^Today/ }).click()
	return sheet
}

export async function closeDialog(page: Page) {
	await dialog(page).getByRole('button', { name: 'Close' }).click()
	await expect(page.getByRole('dialog')).toHaveCount(0)
}

/** Two plain fries: $15.00 + $1.24 tax = $16.24. */
export async function fillCart(page: Page, quantity = 2) {
	await openCategory(page, 'Starters')
	for (let i = 0; i < quantity; i++) await addQuick(page, 'Truffle Fries')
}

export const confirmButton = (sheet: Locator) =>
	sheet.getByRole('button', {
		name: /^(Confirm|Take|Enter an amount|Saving)|short$/,
	})

/** Stubs window.print so a test can see it was asked to print without opening a dialog. */
export async function trapPrint(page: Page) {
	await page.evaluate(() => {
		;(window as unknown as { __prints: number }).__prints = 0
		window.print = () => {
			;(window as unknown as { __prints: number }).__prints++
		}
	})
	return () =>
		page.evaluate(() => (window as unknown as { __prints: number }).__prints)
}

/** Records every order upload the page makes, parsed. */
export function captureUploads(page: Page) {
	const uploads: Array<{
		url: string
		key: string | undefined
		body: unknown
	}> = []
	page.on('request', (request) => {
		if (request.method() === 'POST' && request.url().endsWith('/pos/orders')) {
			uploads.push({
				url: request.url(),
				key: request.headers()['idempotency-key'],
				body: request.postDataJSON(),
			})
		}
	})
	return uploads
}

/** Pay the current order in full with exact cash. */
export async function payExactCash(page: Page) {
	const sheet = await startCharge(page)
	await confirmButton(sheet).click()
	await expect(
		dialog(page).getByRole('heading', { name: 'Paid' }),
	).toBeVisible()
	await dialog(page).getByRole('button', { name: 'New order' }).click()
	await expect(page.getByRole('dialog')).toHaveCount(0)
}

export async function sellFries(page: Page, quantity = 1) {
	await fillCart(page, quantity)
	await payExactCash(page)
}

// ---------------------------------------------------------------------------
// Staff sign-in
// ---------------------------------------------------------------------------

export const lockScreen = (page: Page) =>
	page.getByRole('dialog', { name: /^Locked/ })

/** Types a PIN on the lock screen and presses Sign in. */
export async function signInWithPin(page: Page, pin: string) {
	const lock = lockScreen(page)
	await expect(lock).toBeVisible()
	for (const digit of pin)
		await lock
			.getByRole('group', { name: 'Keypad' })
			.getByRole('button', { name: digit, exact: true })
			.click()
	await lock.getByRole('button', { name: 'Sign in' }).click()
	// Let the attempt finish (the lock opens, or the digits clear on a refusal) before
	// the next one starts typing, as a person would.
	await expect(async () => {
		const opened = (await lock.count()) === 0
		const cleared =
			(await lock.getByRole('img', { name: '0 digits entered' }).count()) === 1
		expect(opened || cleared).toBe(true)
	}).toPass({ timeout: 10_000 })
}

export const ANA = { first: 'Ana', last: 'Karim', pin: '4321', name: 'Ana K.' }
export const LINA = {
	first: 'Lina',
	last: 'Mansour',
	pin: '9999',
	name: 'Lina M.',
	manager: true,
}
export const OMAR = {
	first: 'Omar',
	last: 'Rahman',
	pin: '7777',
	name: 'Omar R.',
}

/** The till is signed in as someone (the staff chip shows their name). */
export const staffChip = (page: Page, name: string) =>
	page.getByRole('button', {
		name: new RegExp(`^Lock the till, signed in as ${name}`),
	})

/** A paired till that requires sign-in, with Ana (cashier), Lina (manager) and Omar (cashier) on the roster. */
export async function pairLocked(page: Page) {
	const ids = {
		ana: await backend.addStaff(ANA),
		lina: await backend.addStaff(LINA),
		omar: await backend.addStaff(OMAR),
	}
	await pairUi(page, { signInRequired: true })
	await expect(lockScreen(page)).toBeVisible()
	return ids
}

/**
 * Answers the "why?" sheet that guards taking items off a tab, cancelling, and
 * refunding: picks a reason, has a manager approve with their PIN when asked,
 * and confirms.
 */
export async function giveReason(
	page: Page,
	options: {
		title: string | RegExp
		confirm: string | RegExp
		reason?: string
		managerPin?: string
	},
) {
	const sheet = page.getByRole('dialog', { name: options.title })
	await expect(sheet).toBeVisible()
	await sheet
		.getByRole('button', { name: options.reason ?? 'Rung up by mistake' })
		.click()
	if (options.managerPin) {
		await typeKeypad(sheet, options.managerPin)
		await sheet.getByRole('button', { name: 'Approve' }).click()
		await expect(sheet.getByText(/Approved by/)).toBeVisible()
	}
	await sheet.getByRole('button', { name: options.confirm }).click()
	await expect(sheet).toHaveCount(0)
}
