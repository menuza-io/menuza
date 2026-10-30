// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initCompleteNamePage } from './complete-name.ts'
import { initProfilePage } from './profile-page.ts'
import { initProfileSettingsPage } from './profile-settings.ts'
import { loadOrders, loadPaymentMethods } from './profile-shop-data.ts'
import { setSessionTokens } from '~/lib/client-auth'

/**
 * Account pages over the real session code with only the region mocked: a
 * refresh that fails for now must not send the customer to sign in again.
 */

const mocks = vi.hoisted(() => ({ redirectToLogin: vi.fn() }))

vi.mock('~/lib/client-auth', async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	redirectToLogin: mocks.redirectToLogin,
}))

function accessToken(): string {
	return `head.${btoa(JSON.stringify({ sub: 'cus-1', orgId: 'org-1' }))}.sig`
}

const unauthorized = () =>
	Response.json({ error: 'Unauthorized' }, { status: 401 })

/** Every route answers 401; the refresh answers `refresh`. */
function region(refresh: () => Response | Error) {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const path = new URL(String(input)).pathname
		if (path === '/auth/refresh') {
			const next = refresh()
			if (next instanceof Error) throw next
			return next
		}
		return unauthorized()
	})
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

const transientRefreshes: Array<[string, () => Response | Error]> = [
	['a 503', () => Response.json({ error: 'busy' }, { status: 503 })],
	['a 429', () => Response.json({ error: 'slow down' }, { status: 429 })],
	['a lost connection', () => new TypeError('fetch failed')],
]

const refusedRefreshes: Array<[string, () => Response]> = [
	['a 401', () => Response.json({ error: 'invalid_grant' }, { status: 401 })],
	[
		'organization_inactive',
		() =>
			Response.json(
				{
					error: 'Organization is no longer active',
					code: 'organization_inactive',
				},
				{ status: 403 },
			),
	],
]

const NETWORK = 'Network error. Please try again.'

function profileDom(rootId: string) {
	document.body.innerHTML = `
		<div id="${rootId}">
			<form id="profile-form" data-network="${NETWORK}">
				<input id="name" name="name" value="Sam" />
				<input id="email" name="email" value="" />
				<input id="phone" name="phone" value="" />
				<div id="error-message" class="hidden"><p></p></div>
				<div id="success-message" class="hidden"></div>
				<button id="submit-button" type="submit">Save</button>
			</form>
			<div id="profile-loading"></div>
			<ul id="order-history"></ul>
			<ul id="payment-methods" class="hidden"></ul>
			<div id="payment-methods-loading"></div>
		</div>`
}

function errorShown(): string | null {
	const box = document.getElementById('error-message')!
	return box.classList.contains('hidden') ? null : box.textContent!.trim()
}

function submit() {
	const form = document.getElementById('profile-form') as HTMLFormElement
	form.dispatchEvent(new Event('submit', { cancelable: true }))
}

async function settle(fetchMock: ReturnType<typeof region>, calls: number) {
	await vi.waitFor(() =>
		expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(calls),
	)
	await new Promise((resolve) => setTimeout(resolve, 0))
	await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
	const store = new Map<string, string>()
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	})
	document.documentElement.dataset.tenantApiUrl = 'https://regional.example'
	setSessionTokens({ accessToken: accessToken(), refreshToken: 'refresh-1' })
	mocks.redirectToLogin.mockReset()
})

afterEach(() => {
	vi.unstubAllGlobals()
	document.body.replaceChildren()
	delete document.documentElement.dataset.customerSession
})

describe.each([
	['profile page', 'profile-page-root', initProfilePage],
	['profile settings', 'profile-settings-root', initProfileSettingsPage],
] as const)('%s', (_name, rootId, init) => {
	it.each(transientRefreshes)(
		'stays and says so when refreshing fails with %s',
		async (_label, refresh) => {
			profileDom(rootId)
			const fetchMock = region(refresh)
			init()
			await vi.waitFor(() => expect(errorShown()).toBe(NETWORK))
			await settle(fetchMock, 2)
			expect(mocks.redirectToLogin).not.toHaveBeenCalled()
			expect(localStorage.getItem('tenant_refresh_token')).toBe('refresh-1')

			const before = fetchMock.mock.calls.length
			submit()
			expect(errorShown()).toBeNull()
			await vi.waitFor(() => expect(errorShown()).toBe(NETWORK))
			await settle(fetchMock, before + 2)
			expect(mocks.redirectToLogin).not.toHaveBeenCalled()
		},
	)

	it.each(refusedRefreshes)(
		'sends the customer to sign in when the refresh is refused with %s',
		async (_label, refresh) => {
			profileDom(rootId)
			const fetchMock = region(refresh)
			init()
			await vi.waitFor(() => expect(mocks.redirectToLogin).toHaveBeenCalled())
			expect(fetchMock).toHaveBeenCalled()
			expect(localStorage.getItem('tenant_refresh_token')).toBeNull()
		},
	)
})

describe('account lists', () => {
	it.each(transientRefreshes)(
		'never signs the customer out when refreshing fails with %s',
		async (_label, refresh) => {
			profileDom('profile-lists')
			region(refresh)
			await loadPaymentMethods({
				paymentMethodsList: document.getElementById('payment-methods'),
				paymentMethodsLoading: document.getElementById(
					'payment-methods-loading',
				),
				noPaymentMethods: 'None',
				expiresLabel: 'Expires',
			})
			await loadOrders({
				orderHistory: document.getElementById('order-history'),
				orderHistoryLoading: null,
				noOrders: 'None',
			})
			expect(mocks.redirectToLogin).not.toHaveBeenCalled()
			expect(localStorage.getItem('tenant_refresh_token')).toBe('refresh-1')
		},
	)

	it('sends the customer to sign in when the session is refused', async () => {
		profileDom('profile-lists')
		region(refusedRefreshes[0]![1])
		await loadOrders({
			orderHistory: document.getElementById('order-history'),
			orderHistoryLoading: null,
			noOrders: 'None',
		})
		expect(mocks.redirectToLogin).toHaveBeenCalledTimes(1)
	})
})

describe('complete name', () => {
	function nameDom() {
		document.body.innerHTML = `
			<form id="complete-name-form" data-network="${NETWORK}">
				<input id="name" name="name" value="Sam Doe" />
				<div id="error-message" class="hidden"></div>
				<button type="submit">Continue</button>
			</form>`
	}

	it.each(transientRefreshes)(
		'keeps the form when refreshing fails with %s',
		async (_label, refresh) => {
			nameDom()
			const fetchMock = region(refresh)
			initCompleteNamePage()
			await settle(fetchMock, 2)
			expect(mocks.redirectToLogin).not.toHaveBeenCalled()

			const form = document.getElementById(
				'complete-name-form',
			) as HTMLFormElement
			const before = fetchMock.mock.calls.length
			form.dispatchEvent(new Event('submit', { cancelable: true }))
			await vi.waitFor(() => expect(errorShown()).toBe(NETWORK))
			await settle(fetchMock, before + 2)
			expect(mocks.redirectToLogin).not.toHaveBeenCalled()
			expect(localStorage.getItem('tenant_refresh_token')).toBe('refresh-1')
		},
	)

	it.each(refusedRefreshes)(
		'sends the customer to sign in when the refresh is refused with %s',
		async (_label, refresh) => {
			nameDom()
			region(refresh)
			initCompleteNamePage()
			await vi.waitFor(() => expect(mocks.redirectToLogin).toHaveBeenCalled())
		},
	)
})
