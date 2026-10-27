import { createdOrderSchema } from '@repo/common/order-receipt'
import {
	QR_TAB_TOKEN_HEADER,
	QR_TABLE_TOKEN_HEADER,
	type QrPublicTab,
} from '@repo/common/qr-ordering'
import { getOrgBinding } from '~/lib/client-auth'

/**
 * QR table ordering in the guest's browser. The table code arrives in the URL
 * fragment (`#table=…`, never sent to any server), is removed from the address
 * bar at once, and then travels only to the regional tenant-api in the
 * `X-Table-Token` header. The open tab's token (`X-Tab-Token`) is kept in
 * `localStorage` so the guest can close the page and come back; no contact
 * field is ever stored here.
 */

const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const TOKEN_PATTERN = /^[A-Za-z0-9-]{1,64}\.[1-9]\d{0,8}\.[0-9a-f]{64}$/

export type TablePolicy = {
	requireGuestName: boolean
	requireGuestPhone: boolean
	onlineTabPayAvailable: boolean
}

export type TableSession = {
	orgId: string
	locationId: string
	tableToken: string
	tableLabel: string
	tabId: string | null
	tabToken: string | null
	tabNumber: string | null
	policy: TablePolicy
	savedAt: number
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const isToken = (value: unknown): value is string =>
	typeof value === 'string' && TOKEN_PATTERN.test(value)
const isText = (value: unknown): value is string => typeof value === 'string'
const isTextOrNull = (value: unknown) => value === null || isText(value)

function readPolicy(value: unknown): TablePolicy | null {
	if (!isRecord(value)) return null
	const { requireGuestName, requireGuestPhone, onlineTabPayAvailable } = value
	if (
		typeof requireGuestName !== 'boolean' ||
		typeof requireGuestPhone !== 'boolean' ||
		typeof onlineTabPayAvailable !== 'boolean'
	) {
		return null
	}
	return { requireGuestName, requireGuestPhone, onlineTabPayAvailable }
}

function readSession(value: unknown): TableSession | null {
	if (!isRecord(value)) return null
	const policy = readPolicy(value.policy)
	if (
		!policy ||
		!isText(value.orgId) ||
		!isText(value.locationId) ||
		!isToken(value.tableToken) ||
		!isText(value.tableLabel) ||
		!isTextOrNull(value.tabId) ||
		!(value.tabToken === null || isToken(value.tabToken)) ||
		!isTextOrNull(value.tabNumber) ||
		typeof value.savedAt !== 'number'
	) {
		return null
	}
	return {
		orgId: value.orgId,
		locationId: value.locationId,
		tableToken: value.tableToken,
		tableLabel: value.tableLabel,
		tabId: value.tabId as string | null,
		tabToken: value.tabToken as string | null,
		tabNumber: value.tabNumber as string | null,
		policy,
		savedAt: value.savedAt,
	}
}

const sessionKey = (orgId: string) => `menuza_qr_tab_${orgId}`

/** The table code from `#table=…`, or null (malformed codes are ignored). */
export function readTableFragment(href: string): string | null {
	let hash = ''
	try {
		hash = new URL(href).hash
	} catch {
		return null
	}
	const params = new URLSearchParams(hash.replace(/^#/, ''))
	const token = params.get('table')?.trim() ?? ''
	return TOKEN_PATTERN.test(token) ? token : null
}

const SCAN_STASH_KEY = 'menuza_qr_scan'
const SCAN_STASH_MAX_AGE_MS = 5 * 60_000

/**
 * The table code the layout's head script moved out of the address bar
 * (before analytics could see it). Read once: it is removed as it is taken.
 */
export function takeStashedTableScan(
	storage: Pick<Storage, 'getItem' | 'removeItem'> | null,
	now = Date.now(),
): string | null {
	if (!storage) return null
	try {
		const raw = storage.getItem(SCAN_STASH_KEY)
		storage.removeItem(SCAN_STASH_KEY)
		if (!raw) return null
		const parsed = JSON.parse(raw) as { code?: unknown; at?: unknown }
		const code = typeof parsed.code === 'string' ? parsed.code.trim() : ''
		const at = typeof parsed.at === 'number' ? parsed.at : 0
		if (now - at > SCAN_STASH_MAX_AGE_MS || now < at) return null
		return TOKEN_PATTERN.test(code) ? code : null
	} catch {
		return null
	}
}

/** The same address without the table code (other fragment parts stay). */
export function stripTableFragment(href: string): string {
	const url = new URL(href)
	const params = new URLSearchParams(url.hash.replace(/^#/, ''))
	if (!params.has('table')) return href
	params.delete('table')
	const rest = params.toString()
	url.hash = rest ? `#${rest}` : ''
	return url.toString()
}

export function loadTableSession(
	orgId: string,
	now = Date.now(),
): TableSession | null {
	try {
		const raw = localStorage.getItem(sessionKey(orgId))
		if (!raw) return null
		const session = readSession(JSON.parse(raw))
		if (!session || session.orgId !== orgId) return null
		if (now - session.savedAt > SESSION_TTL_MS) {
			clearTableSession(orgId)
			return null
		}
		return session
	} catch {
		return null
	}
}

export function saveTableSession(session: TableSession) {
	try {
		localStorage.setItem(
			sessionKey(session.orgId),
			JSON.stringify({ ...session, savedAt: Date.now() }),
		)
	} catch {
		// Private mode: the table works for this page view only.
	}
}

export function clearTableSession(orgId: string) {
	try {
		localStorage.removeItem(sessionKey(orgId))
	} catch {
		// Nothing stored.
	}
}

// ---------------------------------------------------------------------------
// Order-ahead posters (`?src=qr`): tag the next pickup order for attribution.
// ---------------------------------------------------------------------------

const posterKey = (orgId: string) => `menuza_order_source_${orgId}`

export function rememberPosterVisit(orgId: string) {
	try {
		sessionStorage.setItem(posterKey(orgId), 'qr_poster')
	} catch {
		// Attribution only.
	}
}

export function posterSource(orgId: string): 'qr_poster' | null {
	try {
		return sessionStorage.getItem(posterKey(orgId)) === 'qr_poster'
			? 'qr_poster'
			: null
	} catch {
		return null
	}
}

// ---------------------------------------------------------------------------
// Regional calls
// ---------------------------------------------------------------------------

export class TableRequestError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(code)
		this.name = 'TableRequestError'
	}
}

function regionalUrl() {
	const url = document.documentElement.dataset.tenantApiUrl
	if (!url) throw new TableRequestError('region_unavailable', 503)
	return url.replace(/\/$/, '')
}

async function readJson(response: Response): Promise<unknown> {
	const value: unknown = await response.json().catch(() => null)
	if (!response.ok) {
		const code =
			value &&
			typeof value === 'object' &&
			'error' in value &&
			typeof value.error === 'string'
				? value.error
				: 'request_failed'
		throw new TableRequestError(code, response.status)
	}
	return value
}

/** Header for the session: the tab once there is one, else the table. */
export function tableHeaders(
	session: Pick<TableSession, 'tableToken' | 'tabToken'>,
): Record<string, string> {
	return session.tabToken
		? { [QR_TAB_TOKEN_HEADER]: session.tabToken }
		: { [QR_TABLE_TOKEN_HEADER]: session.tableToken }
}

export type TableContext = {
	table: { label: string; locationId: string }
	dineIn: TablePolicy & { enabled: boolean }
	openTab: {
		id: string
		tabToken: string
		tabNumber: string
		roundsCount: number
		totalCents: number
	} | null
}

export function readTableContext(value: unknown): TableContext | null {
	if (!isRecord(value) || !isRecord(value.table) || !isRecord(value.dineIn)) {
		return null
	}
	const policy = readPolicy(value.dineIn)
	if (
		!policy ||
		typeof value.dineIn.enabled !== 'boolean' ||
		!isText(value.table.label) ||
		!isText(value.table.locationId)
	) {
		return null
	}
	let openTab: TableContext['openTab'] = null
	if (value.openTab !== null && value.openTab !== undefined) {
		const tab = value.openTab
		if (
			!isRecord(tab) ||
			!isText(tab.id) ||
			!isToken(tab.tabToken) ||
			!isText(tab.tabNumber) ||
			typeof tab.roundsCount !== 'number' ||
			typeof tab.totalCents !== 'number'
		) {
			return null
		}
		openTab = {
			id: tab.id,
			tabToken: tab.tabToken,
			tabNumber: tab.tabNumber,
			roundsCount: tab.roundsCount,
			totalCents: tab.totalCents,
		}
	}
	return {
		table: { label: value.table.label, locationId: value.table.locationId },
		dineIn: { ...policy, enabled: value.dineIn.enabled },
		openTab,
	}
}

/** What a table code unlocks: its label, the policy, and the open tab. */
export async function fetchTableContext(input: {
	locationId: string
	tableToken: string
}): Promise<TableContext> {
	const params = new URLSearchParams(getOrgBinding())
	params.set('locationId', input.locationId)
	const response = await fetch(
		`${regionalUrl()}/orders/options?${params.toString()}`,
		{
			cache: 'no-store',
			headers: { [QR_TABLE_TOKEN_HEADER]: input.tableToken },
		},
	)
	const context = readTableContext(await readJson(response))
	if (!context) throw new TableRequestError('options_unavailable', 502)
	return context
}

export type CreatedRound = ReturnType<typeof createdOrderSchema.parse> & {
	tab: { id: string; tabNumber: string; tabToken: string }
}

/** Sends one round to the kitchen (prices are set by the region). */
export async function submitTableRound(
	session: TableSession,
	body: Record<string, unknown>,
): Promise<CreatedRound> {
	const response = await fetch(`${regionalUrl()}/orders`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...tableHeaders(session) },
		body: JSON.stringify({ ...body, ...getOrgBinding() }),
	})
	const value = await readJson(response)
	const order = createdOrderSchema.safeParse(value)
	const tab = isRecord(value) ? value.tab : null
	if (
		!order.success ||
		!isRecord(tab) ||
		!isText(tab.id) ||
		!isText(tab.tabNumber) ||
		!isToken(tab.tabToken)
	) {
		throw new TableRequestError('order_failed', 502)
	}
	return {
		...order.data,
		tab: { id: tab.id, tabNumber: tab.tabNumber, tabToken: tab.tabToken },
	}
}

/** The tab with every round and the running total (no contact fields). */
export async function fetchTab(tabToken: string): Promise<QrPublicTab> {
	const params = new URLSearchParams(getOrgBinding())
	const response = await fetch(
		`${regionalUrl()}/orders/tab?${params.toString()}`,
		{ cache: 'no-store', headers: { [QR_TAB_TOKEN_HEADER]: tabToken } },
	)
	const value = await readJson(response)
	if (!value || typeof value !== 'object' || !('tab' in value)) {
		throw new TableRequestError('tab_unavailable', 502)
	}
	return (value as { tab: QrPublicTab }).tab
}

/** Errors that mean the stored table or tab can no longer be used. */
export function isDeadTableError(code: string) {
	return (
		code === 'table_not_found' ||
		code === 'table_archived' ||
		code === 'table_location_mismatch' ||
		code === 'dine_in_unavailable'
	)
}

// ---------------------------------------------------------------------------
// Paying the tab from the phone
// ---------------------------------------------------------------------------

const payKey = (orgId: string) => `menuza_tab_payment_${orgId}`

type TabPayment = { orderRef: string; paymentToken: string }

export function loadTabPayment(orgId: string): TabPayment | null {
	try {
		const raw = sessionStorage.getItem(payKey(orgId))
		const value: unknown = raw ? JSON.parse(raw) : null
		if (
			isRecord(value) &&
			isText(value.orderRef) &&
			value.orderRef.startsWith('tab:') &&
			isText(value.paymentToken)
		) {
			return { orderRef: value.orderRef, paymentToken: value.paymentToken }
		}
	} catch {
		// Fall through.
	}
	return null
}

export function clearTabPayment(orgId: string) {
	try {
		sessionStorage.removeItem(payKey(orgId))
	} catch {
		// Nothing stored.
	}
}

/**
 * Starts the hosted checkout for the tab: the region fixes the amount (tab
 * total plus tip) and hands back a payment capability, which only travels to
 * the Sites payment broker as an opaque reference.
 */
export async function startTabPayment(
	orgId: string,
	session: TableSession,
	input: {
		tipPercent: number
		contact: { name: string; phone: string }
		locale: string
	},
): Promise<string> {
	if (!session.tabToken) throw new TableRequestError('tab_not_found', 404)
	const response = await fetch(`${regionalUrl()}/orders/tab/pay`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			[QR_TAB_TOKEN_HEADER]: session.tabToken,
		},
		body: JSON.stringify({
			...getOrgBinding(),
			tipPercent: input.tipPercent,
			contact: input.contact,
		}),
	})
	const value = await readJson(response)
	if (
		!isRecord(value) ||
		!isText(value.orderRef) ||
		!isText(value.tabPaymentToken)
	) {
		throw new TableRequestError('payment_unavailable', 502)
	}
	const payment = {
		orderRef: value.orderRef,
		paymentToken: value.tabPaymentToken,
	}
	try {
		sessionStorage.setItem(payKey(orgId), JSON.stringify(payment))
	} catch {
		// The receipt still shows from the tab itself.
	}
	const checkout = await fetch('/api/orders/payment', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			...getOrgBinding(),
			orderId: payment.orderRef,
			paymentToken: payment.paymentToken,
			locale: input.locale,
		}),
	})
	const result = await readJson(checkout)
	if (!isRecord(result) || !isText(result.checkoutUrl)) {
		throw new TableRequestError('payment_unavailable', 502)
	}
	return result.checkoutUrl
}

/**
 * After the hosted page: asks the App to reconcile with the provider (the
 * redirect alone never marks a tab paid). Returns the reported status.
 */
export async function checkTabPayment(orgId: string): Promise<string | null> {
	const payment = loadTabPayment(orgId)
	if (!payment) return null
	const response = await fetch('/api/orders/payment-status', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			...getOrgBinding(),
			orderId: payment.orderRef,
			paymentToken: payment.paymentToken,
		}),
	})
	const value = await response.json().catch(() => null)
	return isRecord(value) && isText(value.status) ? value.status : null
}
