// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import {
	LOYALTY_APPROVAL_TTL_MS,
	LOYALTY_MEMBER_CODE_TTL_MS,
} from '@repo/loyalty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoyaltyClientError } from '../loyalty-client.ts'
import {
	testApproval,
	testEntry,
	testProgram,
	testWallet,
} from './test-fixtures.ts'
import { testLoyaltyLabels } from './test-labels.ts'
import {
	initWalletPage,
	type WalletPage,
	type WalletPageDeps,
} from './wallet-page.ts'

const labels = testLoyaltyLabels()
const NOW = Date.UTC(2030, 4, 1, 12)
const pages: WalletPage[] = []

type Client = WalletPageDeps['client']

function fakeClient() {
	return {
		program: vi.fn<Client['program']>(async () => testProgram()),
		wallet: vi.fn<Client['wallet']>(async () => testWallet()),
		history: vi.fn<Client['history']>(async () => ({
			entries: [],
			nextCursor: null,
		})),
		memberCode: vi.fn<Client['memberCode']>(async () => ({
			code: 'ABCD-EFGH',
			expiresAt: Date.now() + LOYALTY_MEMBER_CODE_TTL_MS,
		})),
		approvals: vi.fn<Client['approvals']>(async () => []),
		decideApproval: vi.fn<Client['decideApproval']>(
			async (approvalId, decision) =>
				testApproval({
					id: approvalId,
					status: decision === 'approve' ? 'approved' : 'declined',
				}),
		),
	}
}

function setup(options: { signedIn?: boolean; hidden?: () => boolean } = {}) {
	const client = fakeClient()
	const root = document.createElement('div')
	document.body.append(root)
	let keys = 0
	return {
		root,
		client,
		async start() {
			const page = await initWalletPage(root, {
				client,
				labels,
				locale: 'en',
				signedIn: () => options.signedIn ?? true,
				loginHref: '/login?redirect=%2Fprofile%2Frewards',
				pollMs: 5_000,
				isHidden: options.hidden ?? (() => false),
				newKey: () => `key-${++keys}`,
				historyPageSize: 2,
			})
			pages.push(page)
			await settle()
			return page
		},
	}
}

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve()
}

function q<T extends Element = HTMLElement>(
	root: ParentNode,
	selector: string,
) {
	const node = root.querySelector<T>(selector)
	if (!node) throw new Error(`Missing ${selector}`)
	return node
}

function click(root: ParentNode, selector: string) {
	q(root, selector).click()
}

function sectionIds(root: HTMLElement) {
	return Array.from(
		root.querySelectorAll<HTMLElement>('[data-loyalty-section]'),
		(node) => node.dataset.loyaltySection,
	)
}

/** Text a sighted visitor sees: skips anything inside a `hidden` element. */
function visibleText(root: Element): string {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
	let text = ''
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!node.parentElement?.closest('[hidden]')) text += node.textContent
	}
	return text
}

const statusText = (root: HTMLElement) =>
	q(root, '[data-loyalty-status]').textContent
const announced = (root: HTMLElement) =>
	q(root, '[data-loyalty-announcer]').textContent

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(NOW)
})

afterEach(() => {
	for (const page of pages.splice(0)) page.destroy()
	vi.useRealTimers()
	document.body.replaceChildren()
})

describe('rewards wallet: signed out', () => {
	it('shows the program with a sign-in link and never asks for a wallet', async () => {
		const ctx = setup({ signedIn: false })
		await ctx.start()
		expect(ctx.client.wallet).not.toHaveBeenCalled()
		expect(ctx.client.program).toHaveBeenCalledTimes(1)
		expect(sectionIds(ctx.root)).toEqual([
			'sign-in',
			'earn',
			'rewards',
			'terms',
		])
		expect(
			q<HTMLAnchorElement>(
				ctx.root,
				'[data-loyalty-section=sign-in] a',
			).getAttribute('href'),
		).toBe('/login?redirect=%2Fprofile%2Frewards')
		expect(q(ctx.root, '[data-loyalty-section=earn]').textContent).toContain(
			'1 point for every $1.00 you spend',
		)
		expect(ctx.root.querySelectorAll('[data-reward-id]')).toHaveLength(2)
		expect(ctx.root.querySelector('[data-reward-standing]')).toBeNull()
		expect(q(ctx.root, '[data-loyalty-section=terms]').textContent).toContain(
			'Points have no cash value.',
		)
		expect(ctx.root.getAttribute('aria-busy')).toBeNull()
	})

	it('says rewards are unavailable when the site runs no program', async () => {
		const ctx = setup({ signedIn: false })
		ctx.client.program.mockResolvedValue(null)
		await ctx.start()
		expect(sectionIds(ctx.root)).toEqual(['unavailable'])
		expect(ctx.root.textContent).toContain(labels.unavailableTitle)
	})
})

describe('rewards wallet: loading', () => {
	it('shows the unavailable card while loyalty is off for the site', async () => {
		const ctx = setup()
		ctx.client.wallet.mockResolvedValue(null)
		await ctx.start()
		expect(sectionIds(ctx.root)).toEqual(['unavailable'])
		expect(ctx.client.history).not.toHaveBeenCalled()
		expect(ctx.client.approvals).not.toHaveBeenCalled()
	})

	it('treats a disabled program like no program', async () => {
		const ctx = setup()
		ctx.client.wallet.mockRejectedValue(
			new LoyaltyClientError('loyalty_disabled', 403),
		)
		await ctx.start()
		expect(sectionIds(ctx.root)).toEqual(['unavailable'])
	})

	it('offers a retry when the wallet cannot be loaded', async () => {
		const ctx = setup()
		ctx.client.wallet.mockRejectedValueOnce(
			new LoyaltyClientError('network', 0),
		)
		await ctx.start()
		expect(
			q(ctx.root, '[data-loyalty-section=error] [role=alert]').textContent,
		).toBe(labels.errorNetwork)
		click(ctx.root, '[data-loyalty-action=retry]')
		await settle()
		expect(ctx.client.wallet).toHaveBeenCalledTimes(2)
		expect(sectionIds(ctx.root)).toContain('balance')
	})

	it('says it is loading in a status region outside the busy area', async () => {
		const ctx = setup()
		let answer!: (wallet: Awaited<ReturnType<Client['wallet']>>) => void
		ctx.client.wallet.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					answer = resolve
				}),
		)
		const starting = ctx.start()
		await settle()
		const loading = q(ctx.root, '[data-loyalty-loading]')
		expect(loading).toHaveAttribute('role', 'status')
		expect(loading.textContent).toBe(labels.loading)
		// Screen readers hold back what changes inside a busy element, so the
		// status, the announcer and the loading line stay outside it.
		const busy = ctx.root.querySelectorAll('[aria-busy="true"]')
		expect(busy).toHaveLength(1)
		expect(busy[0]).not.toBe(ctx.root)
		for (const live of [
			loading,
			q(ctx.root, '[data-loyalty-status]'),
			q(ctx.root, '[data-loyalty-announcer]'),
		]) {
			expect(live.closest('[aria-busy="true"]')).toBeNull()
		}
		answer(testWallet())
		await starting
		expect(loading.textContent).toBe('')
		expect(ctx.root.querySelector('[aria-busy]')).toBeNull()
	})

	it('keeps focus on retry while it loads, then moves it to what loaded', async () => {
		const ctx = setup()
		ctx.client.wallet.mockRejectedValueOnce(
			new LoyaltyClientError('network', 0),
		)
		await ctx.start()
		const loading = q(ctx.root, '[data-loyalty-loading]')
		expect(loading.textContent).toBe('')

		ctx.client.wallet.mockRejectedValueOnce(
			new LoyaltyClientError('network', 0),
		)
		const first = q<HTMLButtonElement>(ctx.root, '[data-loyalty-action=retry]')
		first.focus()
		first.click()
		// A second press while it waits starts nothing new.
		first.click()
		expect(first).toHaveFocus()
		expect(first).toHaveAttribute('aria-busy', 'true')
		expect(loading.textContent).toBe(labels.loading)
		await settle()
		expect(ctx.client.wallet).toHaveBeenCalledTimes(2)
		const second = q<HTMLButtonElement>(ctx.root, '[data-loyalty-action=retry]')
		expect(second).not.toBe(first)
		expect(second).toHaveFocus()
		expect(loading.textContent).toBe('')

		second.click()
		await settle()
		expect(sectionIds(ctx.root)).toContain('balance')
		expect(q(ctx.root, '#loyalty-balance-heading')).toHaveFocus()
	})
	it('goes back to signing in when the session ended or belongs to another site', async () => {
		const cases = [
			[new LoyaltyClientError('signed_out', 401), labels.errorSignedOut],
			[
				new LoyaltyClientError('organization_mismatch', 403),
				labels.errorWrongSite,
			],
		] as const
		for (const [error, message] of cases) {
			const store = new Map<string, string>([
				['tenant_access_token', 'dead-access'],
				['tenant_refresh_token', 'dead-refresh'],
			])
			vi.stubGlobal('localStorage', {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => void store.set(key, value),
				removeItem: (key: string) => void store.delete(key),
			})
			const ctx = setup()
			ctx.client.wallet.mockRejectedValueOnce(error)
			await ctx.start()
			expect(sectionIds(ctx.root)[0]).toBe('sign-in')
			expect(statusText(ctx.root)).toBe(message)
			// The refused tokens are forgotten, so the next load starts signed out.
			expect(store.has('tenant_access_token')).toBe(false)
			expect(store.has('tenant_refresh_token')).toBe(false)
			ctx.root.remove()
			vi.unstubAllGlobals()
		}
	})
})

describe('rewards wallet: opening', () => {
	it('opens straight on the balance with nothing to join or accept', async () => {
		const ctx = setup()
		await ctx.start()
		expect(ctx.client.wallet).toHaveBeenCalledTimes(1)
		expect(sectionIds(ctx.root)).toContain('balance')
		expect(ctx.root.querySelector('form')).toBeNull()
		expect(ctx.root.querySelector('input[type=checkbox]')).toBeNull()
		expect(ctx.root.querySelector('[data-loyalty-section=join]')).toBeNull()
		expect(statusText(ctx.root)).toBe('')
	})

	it('shows the terms as read-only text, closed until opened', async () => {
		const ctx = setup()
		await ctx.start()
		const terms = q<HTMLDetailsElement>(
			ctx.root,
			'details[data-loyalty-section=terms]',
		)
		expect(terms.open).toBe(false)
		expect(q(terms, 'summary').textContent).toBe(labels.termsHeading)
		expect(terms.textContent).toContain('Points have no cash value.')
		expect(terms.querySelector('input, button')).toBeNull()
	})

	it('leaves the terms section out when the program has no terms', async () => {
		const ctx = setup()
		ctx.client.wallet.mockResolvedValue(
			testWallet({ program: testProgram({ terms: null }) }),
		)
		await ctx.start()
		expect(sectionIds(ctx.root)).not.toContain('terms')
	})

	it('keeps an opened terms section open across a refresh', async () => {
		const ctx = setup()
		const page = await ctx.start()
		q<HTMLDetailsElement>(
			ctx.root,
			'details[data-loyalty-section=terms]',
		).open = true
		await page.refresh()
		expect(
			q<HTMLDetailsElement>(ctx.root, 'details[data-loyalty-section=terms]')
				.open,
		).toBe(true)
	})

	it('treats an account that was erased like no program', async () => {
		const ctx = setup()
		ctx.client.wallet.mockResolvedValue(
			testWallet({ member: null, balance: null, nextReward: null }),
		)
		await ctx.start()
		expect(sectionIds(ctx.root)).toEqual(['unavailable'])
		expect(ctx.client.history).not.toHaveBeenCalled()
	})

	it('tells a signed-out visitor about a paused program without a join prompt', async () => {
		const ctx = setup({ signedIn: false })
		ctx.client.program.mockResolvedValue(testProgram({ status: 'paused' }))
		await ctx.start()
		expect(ctx.root.textContent).toContain(labels.errorProgramInactive)
		expect(ctx.root.textContent).toContain(labels.signedOutBody)
		expect(ctx.root.querySelector('form')).toBeNull()
	})
})

describe('rewards wallet: member', () => {
	it('shows the balance, progress to the next reward and what each reward needs', async () => {
		const ctx = setup()
		await ctx.start()
		expect(sectionIds(ctx.root)).toEqual([
			'balance',
			'approvals',
			'code',
			'rewards',
			'earn',
			'history',
			'terms',
		])
		expect(q(ctx.root, '[data-loyalty-available]').textContent).toBe(
			'150 points',
		)
		const bar = q(ctx.root, '[role=progressbar]')
		expect(bar.getAttribute('aria-valuenow')).toBe('37')
		expect(bar.getAttribute('aria-valuetext')).toBe(
			'250 points more to unlock $20 off',
		)
		// A name like "$20 off" keeps its own direction in shown text only.
		expect(bar.previousElementSibling?.textContent).toBe(
			'250 points more to unlock \u2068$20 off\u2069',
		)
		expect(q(ctx.root, '[data-reward-id=rwd_big] bdi').textContent).toBe(
			'$20 off',
		)
		expect(
			q(ctx.root, '[data-reward-id=rwd_coffee] [data-reward-standing]').dataset
				.rewardStanding,
		).toBe('affordable')
		const big = q(ctx.root, '[data-reward-id=rwd_big] [data-reward-standing]')
		expect(big.dataset.rewardStanding).toBe('short')
		expect(big.textContent).toBe('250 points more needed')
		expect(
			q(ctx.root, '[data-loyalty-section=balance]').textContent,
		).not.toMatch(/member since/i)
		expect(ctx.root.querySelector('[data-loyalty-notice]')).toBeNull()
	})

	it('says when every reward is unlocked and when points are held', async () => {
		const ctx = setup()
		ctx.client.wallet.mockResolvedValue(
			testWallet({
				balance: { points: 500, reserved: 50, available: 450 },
				nextReward: null,
			}),
		)
		await ctx.start()
		const balance = q(ctx.root, '[data-loyalty-section=balance]')
		expect(balance.textContent).toContain(labels.allRewardsUnlocked)
		expect(balance.textContent).toContain(
			'50 points held for an order in progress',
		)
		expect(balance.querySelector('[role=progressbar]')).toBeNull()
	})

	it('explains a balance below zero', async () => {
		const ctx = setup()
		ctx.client.wallet.mockResolvedValue(
			testWallet({ balance: { points: -20, reserved: 0, available: -20 } }),
		)
		await ctx.start()
		expect(q(ctx.root, '[data-loyalty-section=balance]').textContent).toContain(
			labels.owedNotice,
		)
	})

	it('uses the program unit label', async () => {
		const ctx = setup()
		ctx.client.wallet.mockResolvedValue(
			testWallet({
				program: testProgram({ unitLabel: 'stars' }),
				balance: { points: 1, reserved: 0, available: 1 },
			}),
		)
		await ctx.start()
		expect(q(ctx.root, '[data-loyalty-available]').textContent).toBe('1 star')
	})

	it('puts a suspended membership on hold', async () => {
		const ctx = setup()
		ctx.client.wallet.mockResolvedValue(
			testWallet({ member: { status: 'suspended' } }),
		)
		await ctx.start()
		expect(q(ctx.root, '[data-loyalty-notice]').textContent).toBe(
			labels.suspendedNotice,
		)
		expect(sectionIds(ctx.root)).not.toContain('code')
		expect(sectionIds(ctx.root)).not.toContain('approvals')
		expect(ctx.client.approvals).not.toHaveBeenCalled()
	})

	it('stops codes and approvals while the program is paused', async () => {
		const ctx = setup()
		ctx.client.wallet.mockResolvedValue(
			testWallet({ program: testProgram({ status: 'paused' }) }),
		)
		await ctx.start()
		expect(q(ctx.root, '[data-loyalty-notice]').textContent).toBe(
			labels.pausedNotice,
		)
		expect(sectionIds(ctx.root)).not.toContain('code')
		expect(sectionIds(ctx.root)).not.toContain('approvals')
	})

	it('keeps the member code but hides till requests while rewards cannot be used', async () => {
		const ctx = setup()
		ctx.client.wallet.mockResolvedValue(
			testWallet({ program: testProgram({ redemptionEnabled: false }) }),
		)
		await ctx.start()
		expect(sectionIds(ctx.root)).toContain('code')
		expect(sectionIds(ctx.root)).not.toContain('approvals')
		expect(q(ctx.root, '[data-loyalty-section=rewards]').textContent).toContain(
			labels.redemptionPaused,
		)
		expect(ctx.client.approvals).not.toHaveBeenCalled()
	})

	it('shows a calm message for a suspended account and hides the code and requests', async () => {
		const ctx = setup()
		ctx.client.wallet.mockResolvedValue(
			testWallet({ member: { status: 'suspended' } }),
		)
		await ctx.start()
		expect(q(ctx.root, '[data-loyalty-notice]').textContent).toBe(
			labels.suspendedNotice,
		)
		expect(sectionIds(ctx.root)).toContain('balance')
		expect(sectionIds(ctx.root)).not.toContain('code')
		expect(sectionIds(ctx.root)).not.toContain('approvals')
		expect(ctx.client.approvals).not.toHaveBeenCalled()
	})
})

describe('rewards wallet: history', () => {
	it('lists activity and loads more with the cursor', async () => {
		const ctx = setup()
		ctx.client.history
			.mockResolvedValueOnce({
				entries: [
					testEntry({ id: 'led_2', delta: 12, channel: 'pos' }),
					testEntry({
						id: 'led_1',
						type: 'redeem',
						delta: -100,
						channel: 'web',
						rewardName: 'Free coffee',
					}),
				],
				nextCursor: 'c2',
			})
			.mockResolvedValueOnce({
				entries: [
					testEntry({
						id: 'led_0',
						type: 'adjust',
						delta: 5,
						channel: null,
						reason: 'goodwill',
					}),
				],
				nextCursor: null,
			})
		await ctx.start()
		expect(ctx.client.history).toHaveBeenCalledWith({ cursor: null, limit: 2 })
		const items = () =>
			Array.from(ctx.root.querySelectorAll<HTMLElement>('[data-entry-id]'))
		expect(items().map((item) => item.dataset.entryId)).toEqual([
			'led_2',
			'led_1',
		])
		expect(items()[0]!.textContent).toContain('Earned')
		expect(items()[0]!.textContent).toContain('In store')
		expect(items()[0]!.textContent).toContain('+12 points')
		expect(items()[1]!.textContent).toContain(
			'Redeemed \u2068Free coffee\u2069',
		)
		expect(items()[1]!.textContent).toContain('\u2212100 points')
		const more = q<HTMLButtonElement>(
			ctx.root,
			'[data-loyalty-action=history-more]',
		)
		expect(more.hidden).toBe(false)
		more.click()
		await settle()
		expect(ctx.client.history).toHaveBeenLastCalledWith({
			cursor: 'c2',
			limit: 2,
		})
		expect(items().map((item) => item.dataset.entryId)).toEqual([
			'led_2',
			'led_1',
			'led_0',
		])
		expect(items()[2]).toHaveFocus()
		expect(more.hidden).toBe(true)
	})

	it('offers a retry after a failure, then shows the empty state', async () => {
		const ctx = setup()
		ctx.client.history.mockRejectedValueOnce(
			new LoyaltyClientError('network', 0),
		)
		await ctx.start()
		const history = q(ctx.root, '[data-loyalty-section=history]')
		expect(visibleText(history)).toContain(labels.errorNetwork)
		expect(q(history, '[role=alert]').textContent).toBe(labels.errorNetwork)
		expect(visibleText(history)).not.toContain(labels.historyEmpty)
		const retry = q<HTMLButtonElement>(
			history,
			'[data-loyalty-action=history-retry]',
		)
		expect(retry.hidden).toBe(false)
		retry.click()
		await settle()
		expect(retry.hidden).toBe(true)
		expect(visibleText(history)).toContain(labels.historyEmpty)
		expect(visibleText(history)).not.toContain(labels.errorNetwork)
	})
})

describe('rewards wallet: member code', () => {
	it('shows a code with a countdown and lets it expire on this device', async () => {
		const ctx = setup()
		await ctx.start()
		click(ctx.root, '[data-loyalty-action=code]')
		await settle()
		const code = q(ctx.root, '[data-loyalty-code]')
		expect(q(code, '[aria-hidden=true]').textContent).toBe('ABCD-EFGH')
		expect(q(code, '.sr-only').textContent).toBe('A B C D, E F G H')
		expect(code.dir).toBe('ltr')
		expect(code).toHaveFocus()
		expect(announced(ctx.root)).toBe(labels.codeReady)
		const countdown = () =>
			q(ctx.root, '[data-loyalty-countdown=code]').textContent
		expect(countdown()).toBe('Expires in \u20665:00\u2069')
		await vi.advanceTimersByTimeAsync(1_000)
		expect(countdown()).toBe('Expires in \u20664:59\u2069')
		await vi.advanceTimersByTimeAsync(LOYALTY_MEMBER_CODE_TTL_MS)
		expect(ctx.root.querySelector('[data-loyalty-code]')).toBeNull()
		expect(visibleText(q(ctx.root, '[data-loyalty-section=code]'))).toContain(
			labels.codeExpired,
		)
		expect(q(ctx.root, '[data-loyalty-action=code]').textContent).toBe(
			labels.codeRefresh,
		)
	})

	it('checks for till requests while the code is live and announces a new one', async () => {
		const ctx = setup()
		ctx.client.approvals
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([testApproval()])
		await ctx.start()
		expect(ctx.client.approvals).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(10_000)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(1)
		click(ctx.root, '[data-loyalty-action=code]')
		await settle()
		await vi.advanceTimersByTimeAsync(5_000)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(5_000)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(3)
		expect(ctx.root.querySelector('[data-approval-id=apr_1]')).not.toBeNull()
		expect(announced(ctx.root)).toBe(labels.newApprovals)
	})

	it('does not check while the page is hidden', async () => {
		let hidden = false
		const ctx = setup({ hidden: () => hidden })
		await ctx.start()
		click(ctx.root, '[data-loyalty-action=code]')
		await settle()
		hidden = true
		await vi.advanceTimersByTimeAsync(15_000)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(1)
		hidden = false
		await vi.advanceTimersByTimeAsync(5_000)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(2)
	})

	it('reloads the wallet when the membership went on hold meanwhile', async () => {
		const ctx = setup()
		ctx.client.wallet
			.mockResolvedValueOnce(testWallet())
			.mockResolvedValueOnce(testWallet({ member: { status: 'suspended' } }))
		ctx.client.memberCode.mockRejectedValueOnce(
			new LoyaltyClientError('member_inactive', 409),
		)
		await ctx.start()
		click(ctx.root, '[data-loyalty-action=code]')
		await settle()
		expect(ctx.client.wallet).toHaveBeenCalledTimes(2)
		expect(sectionIds(ctx.root)).not.toContain('code')
		expect(q(ctx.root, '[data-loyalty-notice]').textContent).toBe(
			labels.suspendedNotice,
		)
	})
})

describe('rewards wallet: till requests', () => {
	it('approves a request with an idempotency key and refreshes the balance', async () => {
		const ctx = setup()
		ctx.client.approvals.mockResolvedValueOnce([testApproval()])
		ctx.client.wallet
			.mockResolvedValueOnce(testWallet())
			.mockResolvedValueOnce(
				testWallet({ balance: { points: 50, reserved: 0, available: 50 } }),
			)
		await ctx.start()
		const item = q(ctx.root, '[data-approval-id=apr_1]')
		expect(item.textContent).toContain('Use \u2068Free coffee\u2069?')
		expect(item.textContent).toContain('Spends 100 points for $5.00 off')
		expect(q(item, '[data-loyalty-countdown=approval]').textContent).toBe(
			'Expires in \u20663:00\u2069',
		)
		expect(
			q(item, '[data-loyalty-action=approve]').getAttribute('aria-label'),
		).toBe('Approve Free coffee')
		click(item, '[data-loyalty-action=approve]')
		await settle()
		expect(ctx.client.decideApproval).toHaveBeenCalledWith(
			'apr_1',
			'approve',
			'key-1',
		)
		expect(ctx.root.querySelector('[data-approval-id]')).toBeNull()
		expect(statusText(ctx.root)).toBe('Approved: \u2068Free coffee\u2069.')
		expect(document.activeElement?.id).toBe('loyalty-approvals-heading')
		expect(
			q(ctx.root, '[data-loyalty-available]').dataset.loyaltyAvailable,
		).toBe('50')
	})

	it('declines without reloading the balance', async () => {
		const ctx = setup()
		ctx.client.approvals.mockResolvedValueOnce([testApproval()])
		await ctx.start()
		click(ctx.root, '[data-approval-id=apr_1] [data-loyalty-action=decline]')
		await settle()
		expect(ctx.client.decideApproval).toHaveBeenCalledWith(
			'apr_1',
			'decline',
			'key-1',
		)
		expect(statusText(ctx.root)).toBe('Declined: \u2068Free coffee\u2069.')
		expect(ctx.client.wallet).toHaveBeenCalledTimes(1)
	})

	it('drops a request that expired meanwhile and checks again', async () => {
		const ctx = setup()
		ctx.client.approvals.mockResolvedValueOnce([testApproval()])
		ctx.client.decideApproval.mockRejectedValueOnce(
			new LoyaltyClientError('approval_expired', 410),
		)
		await ctx.start()
		click(ctx.root, '[data-approval-id=apr_1] [data-loyalty-action=approve]')
		await settle()
		expect(ctx.root.querySelector('[data-approval-id]')).toBeNull()
		expect(statusText(ctx.root)).toBe(labels.approvalExpired)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(2)
		expect(
			visibleText(q(ctx.root, '[data-loyalty-section=approvals]')),
		).toContain(labels.approvalsEmpty)
	})

	it('retries a failed decision with the same key', async () => {
		const ctx = setup()
		ctx.client.approvals.mockResolvedValue([testApproval()])
		ctx.client.decideApproval.mockRejectedValueOnce(
			new LoyaltyClientError('network', 0),
		)
		await ctx.start()
		click(ctx.root, '[data-approval-id=apr_1] [data-loyalty-action=approve]')
		await settle()
		const section = q(ctx.root, '[data-loyalty-section=approvals]')
		expect(visibleText(section)).toContain(labels.errorNetwork)
		expect(q(section, '[role=alert]').textContent).toBe(labels.errorNetwork)
		const approve = q(
			section,
			'[data-approval-id=apr_1] [data-loyalty-action=approve]',
		)
		expect(approve.getAttribute('aria-disabled')).toBeNull()
		approve.click()
		await settle()
		expect(ctx.client.decideApproval.mock.calls.map((call) => call[2])).toEqual(
			['key-1', 'key-1'],
		)
	})

	it('stops offering a request when its time is up on this device', async () => {
		const ctx = setup()
		const approval = testApproval()
		ctx.client.approvals.mockImplementation(async () =>
			Date.now() < approval.expiresAt ? [approval] : [],
		)
		await ctx.start()
		const countdown = () =>
			q(ctx.root, '[data-loyalty-countdown=approval]').textContent
		await vi.advanceTimersByTimeAsync(1_000)
		expect(countdown()).toBe('Expires in \u20662:59\u2069')
		await vi.advanceTimersByTimeAsync(LOYALTY_APPROVAL_TTL_MS)
		expect(ctx.root.querySelector('[data-approval-id]')).toBeNull()
		expect(
			visibleText(q(ctx.root, '[data-loyalty-section=approvals]')),
		).toContain(labels.approvalsEmpty)
	})

	it('reads a failed check out once, not again on every poll', async () => {
		const ctx = setup()
		ctx.client.approvals
			.mockResolvedValueOnce([])
			.mockRejectedValue(new LoyaltyClientError('network', 0))
		await ctx.start()
		click(ctx.root, '[data-loyalty-action=code]')
		await settle()
		await vi.advanceTimersByTimeAsync(5_000)
		const alert = q(ctx.root, '[data-loyalty-section=approvals] [role=alert]')
		expect(alert.hidden).toBe(false)
		expect(alert.textContent).toBe(labels.errorNetwork)
		const line = alert.firstChild
		// The next check waits twice as long after a failure.
		await vi.advanceTimersByTimeAsync(10_000)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(3)
		expect(alert.firstChild).toBe(line)
	})

	it('checks less often while checks fail, and at the usual pace once one works', async () => {
		const ctx = setup()
		ctx.client.approvals
			.mockResolvedValueOnce([])
			.mockRejectedValueOnce(new LoyaltyClientError('network', 0))
			.mockRejectedValueOnce(new LoyaltyClientError('unknown', 500))
			.mockResolvedValue([])
		await ctx.start()
		click(ctx.root, '[data-loyalty-action=code]')
		await settle()
		await vi.advanceTimersByTimeAsync(5_000)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(9_999)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(3)
		await vi.advanceTimersByTimeAsync(19_999)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(3)
		await vi.advanceTimersByTimeAsync(1)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(4)
		await vi.advanceTimersByTimeAsync(5_000)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(5)
	})

	it('never waits more than a minute between checks', async () => {
		const ctx = setup()
		ctx.client.approvals
			.mockResolvedValueOnce([])
			.mockRejectedValue(new LoyaltyClientError('network', 0))
		await ctx.start()
		click(ctx.root, '[data-loyalty-action=code]')
		await settle()
		// 5, 10, 20 and 40 seconds, then a minute at most.
		await vi.advanceTimersByTimeAsync(75_000)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(5)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(6)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(7)
	})

	it('waits as long as the region asks after a rate limit', async () => {
		const ctx = setup()
		ctx.client.approvals
			.mockResolvedValueOnce([])
			.mockRejectedValueOnce(new LoyaltyClientError('rate_limited', 429, 30))
			.mockResolvedValue([])
		await ctx.start()
		click(ctx.root, '[data-loyalty-action=code]')
		await settle()
		await vi.advanceTimersByTimeAsync(5_000)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(29_999)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(3)
	})

	it('checks for requests on demand', async () => {
		const ctx = setup()
		await ctx.start()
		click(ctx.root, '[data-loyalty-action=check-approvals]')
		await settle()
		expect(ctx.client.approvals).toHaveBeenCalledTimes(2)
		expect(announced(ctx.root)).toBe(labels.approvalsEmpty)
	})

	it('stops checking once the page is gone', async () => {
		const ctx = setup()
		ctx.client.approvals.mockResolvedValue([testApproval()])
		const page = await ctx.start()
		page.destroy()
		await vi.advanceTimersByTimeAsync(20_000)
		expect(ctx.client.approvals).toHaveBeenCalledTimes(1)
	})
})
