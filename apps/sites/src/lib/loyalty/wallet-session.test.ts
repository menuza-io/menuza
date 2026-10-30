// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
	getAccessToken,
	getRefreshToken,
	setSessionTokens,
} from '../client-auth.ts'
import { createLoyaltyClient } from '../loyalty-client.ts'
import { testProgram, testWallet } from './test-fixtures.ts'
import { testLoyaltyLabels } from './test-labels.ts'
import { initWalletPage, type WalletPage } from './wallet-page.ts'

/**
 * The wallet over the real loyalty client and session code, with only the
 * region mocked: what a refresh failure does to the customer's session.
 */

const labels = testLoyaltyLabels()
const pages: WalletPage[] = []

/** An unsigned token the session code can read. */
function accessToken(n: number): string {
	const payload = btoa(JSON.stringify({ sub: 'cus-1', orgId: 'org-1', n }))
	return `head.${payload}.sig`
}

const unauthorized = () =>
	Response.json({ error: 'Unauthorized' }, { status: 401 })

/**
 * The region by path: `/loyalty/wallet` and `/auth/refresh` take the next
 * queued answer; history, till requests and the program answer empty.
 */
function region(answers: { wallet: Response[]; refresh: Response[] }) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input)).pathname
			const queue =
				path === '/loyalty/wallet'
					? answers.wallet
					: path === '/auth/refresh'
						? answers.refresh
						: null
			if (queue) {
				const next = queue.shift()
				if (!next) throw new Error(`Unexpected ${path}`)
				return next
			}
			if (path === '/loyalty/history') {
				return Response.json({ entries: [], nextCursor: null })
			}
			if (path === '/loyalty/approvals') return Response.json({ approvals: [] })
			if (path === '/loyalty/program') {
				return Response.json({ program: testProgram() })
			}
			throw new Error(`Unexpected ${path}`)
		}),
	)
}

async function openWallet(): Promise<HTMLElement> {
	const root = document.createElement('div')
	document.body.append(root)
	const page = await initWalletPage(root, {
		client: createLoyaltyClient({
			baseUrl: () => 'https://regional.example',
			binding: () => ({ slug: 'acme' }),
		}),
		labels,
		locale: 'en',
		signedIn: () => getAccessToken() !== null,
		loginHref: '/login',
		pollMs: 60_000,
		isHidden: () => false,
		newKey: () => 'key-1',
		historyPageSize: 2,
	})
	pages.push(page)
	return root
}

function q(root: ParentNode, selector: string): HTMLElement {
	const node = root.querySelector<HTMLElement>(selector)
	if (!node) throw new Error(`Missing ${selector}`)
	return node
}

function sectionIds(root: HTMLElement) {
	return Array.from(
		root.querySelectorAll<HTMLElement>('[data-loyalty-section]'),
		(node) => node.dataset.loyaltySection,
	)
}

/** A signed-in browser; disposing it closes the wallets and the stubs. */
function signedIn() {
	const store = new Map<string, string>()
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	})
	document.documentElement.dataset.tenantApiUrl = 'https://regional.example'
	setSessionTokens({ accessToken: accessToken(1), refreshToken: 'refresh-1' })
	return {
		[Symbol.dispose]() {
			for (const page of pages.splice(0)) page.destroy()
			vi.unstubAllGlobals()
			document.body.replaceChildren()
			delete document.documentElement.dataset.customerSession
			delete document.documentElement.dataset.tenantApiUrl
		},
	}
}

describe('rewards wallet: session refresh', () => {
	it('keeps the session when refreshing fails for now, then loads on retry', async () => {
		using ignoredSession = signedIn()
		region({
			wallet: [
				unauthorized(),
				unauthorized(),
				Response.json({ wallet: testWallet() }),
			],
			refresh: [
				Response.json({ error: 'busy' }, { status: 503 }),
				Response.json({
					accessToken: accessToken(2),
					refreshToken: 'refresh-2',
				}),
			],
		})
		const root = await openWallet()
		expect(
			q(root, '[data-loyalty-section=error] [role=alert]').textContent,
		).toBe(labels.errorNetwork)
		expect(getAccessToken()).toBe(accessToken(1))
		expect(getRefreshToken()).toBe('refresh-1')

		q(root, '[data-loyalty-action=retry]').click()
		await vi.waitFor(() => expect(sectionIds(root)).toContain('balance'))
		expect(getAccessToken()).toBe(accessToken(2))
		expect(getRefreshToken()).toBe('refresh-2')
	})

	it('signs out when the region refuses the refresh', async () => {
		using ignoredSession = signedIn()
		region({
			wallet: [unauthorized()],
			refresh: [Response.json({ error: 'invalid_grant' }, { status: 401 })],
		})
		const root = await openWallet()
		expect(sectionIds(root)[0]).toBe('sign-in')
		expect(getAccessToken()).toBeNull()
		expect(getRefreshToken()).toBeNull()
	})

	it('signs out when the organization is no longer active', async () => {
		using ignoredSession = signedIn()
		region({
			wallet: [
				Response.json(
					{
						error: 'Organization is no longer active',
						code: 'organization_inactive',
					},
					{ status: 403 },
				),
			],
			refresh: [],
		})
		const root = await openWallet()
		expect(sectionIds(root)[0]).toBe('sign-in')
		expect(getAccessToken()).toBeNull()
		expect(getRefreshToken()).toBeNull()
	})

	it('keeps the session when the region is temporarily unavailable', async () => {
		using ignoredSession = signedIn()
		region({
			wallet: [
				Response.json(
					{
						error: 'Service temporarily unavailable. Please try again.',
						code: 'temporarily_unavailable',
					},
					{ status: 503 },
				),
			],
			refresh: [],
		})
		const root = await openWallet()
		expect(
			q(root, '[data-loyalty-section=error] [role=alert]').textContent,
		).toBe(labels.errorNetwork)
		expect(getAccessToken()).toBe(accessToken(1))
		expect(getRefreshToken()).toBe('refresh-1')
	})
})
