/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OrderRequestError } from './order-client'

const client = {
	createGroup: vi.fn(),
	readGroup: vi.fn(),
	joinGroup: vi.fn(),
	addGroupLine: vi.fn(),
	removeGroupLine: vi.fn(),
	setGroupDone: vi.fn(),
	updateGroup: vi.fn(),
	leaveGroup: vi.fn(),
	endGroup: vi.fn(),
}

vi.mock('./group-client.ts', async () => {
	const actual =
		await vi.importActual<typeof import('./group-client')>('./group-client')
	return {
		...actual,
		createGroup: (...args: unknown[]) => client.createGroup(...args),
		readGroup: (...args: unknown[]) => client.readGroup(...args),
		joinGroup: (...args: unknown[]) => client.joinGroup(...args),
		addGroupLine: (...args: unknown[]) => client.addGroupLine(...args),
		removeGroupLine: (...args: unknown[]) => client.removeGroupLine(...args),
		setGroupDone: (...args: unknown[]) => client.setGroupDone(...args),
		updateGroup: (...args: unknown[]) => client.updateGroup(...args),
		leaveGroup: (...args: unknown[]) => client.leaveGroup(...args),
		endGroup: (...args: unknown[]) => client.endGroup(...args),
	}
})

import {
	deadlineIso,
	groupErrorText,
	mountGroupPage,
	parseAmountMinor,
} from './group-ui'

const labels = new Proxy(
	{},
	{
		get: (_target, key: string) => `L:${key}`,
	},
) as never

const PERSON = `gp1.${'b'.repeat(64)}`
const SHARE = `gs1.${'a'.repeat(64)}`

function line(
	id: string,
	personId: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		personId,
		line: { itemId: 'i1', quantity: 1, options: [] },
		itemName: 'Burger',
		variantNames: [],
		options: [],
		amountMinor: 1000,
		available: true,
		canRemove: true,
		...overrides,
	}
}

function view(overrides: Record<string, unknown> = {}) {
	return {
		id: 'g1',
		status: 'open',
		locationId: 'loc-1',
		hostFirstName: 'Hana',
		deadlineAt: null,
		perPersonLimitMinor: null,
		totalLimitMinor: null,
		totalMinor: 2000,
		currency: 'USD',
		version: 3,
		people: [
			{
				id: 'p1',
				firstName: 'Hana',
				isHost: true,
				isYou: true,
				done: false,
				lineCount: 1,
				subtotalMinor: 1000,
			},
			{
				id: 'p2',
				firstName: 'Sam <b>x</b>',
				isHost: false,
				isYou: false,
				done: true,
				lineCount: 1,
				subtotalMinor: 1000,
			},
		],
		lines: [line('l1', 'p1'), line('l2', 'p2', { canRemove: true })],
		you: { personId: 'p1', isHost: true },
		order: null,
		canAdd: true,
		serverNow: 1000,
		...overrides,
	}
}

function mount(overrides: Record<string, unknown> = {}) {
	document.body.innerHTML = '<div id="root"></div>'
	const root = document.getElementById('root')!
	const options = {
		root,
		labels,
		orgId: 'org',
		locale: 'en',
		defaultLocale: 'en',
		currency: 'USD',
		formatMoney: (amount: number) => `$${amount.toFixed(2)}`,
		locations: [
			{ id: 'loc-1', name: 'Main' },
			{ id: 'loc-2', name: 'Second' },
		],
		menuHref: '/menu',
		checkoutHref: '/menu/checkout',
		successHref: '/menu/success',
		pagePath: '/menu/group',
		signInHref: '/login',
		signInAndReturn: vi.fn(),
		isSignedIn: () => true,
		defaultLocationId: 'loc-1',
		...overrides,
	}
	const handle = mountGroupPage(options as never)
	return { root, handle, options }
}

async function settled() {
	await new Promise((resolve) => setTimeout(resolve, 0))
	await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
	vi.clearAllMocks()
	localStorage.clear()
	sessionStorage.clear()
	window.history.replaceState(null, '', '/menu/group')
})

describe('helpers', () => {
	it('reads amounts and deadlines the way the region wants them', () => {
		expect(parseAmountMinor('12.5')).toBe(1250)
		expect(parseAmountMinor(' 7 ')).toBe(700)
		expect(parseAmountMinor('0')).toBeNull()
		expect(parseAmountMinor('abc')).toBeNull()
		expect(parseAmountMinor('12,50')).toBe(1250)
		expect(parseAmountMinor('١٢٫٥٠')).toBe(1250)
		expect(parseAmountMinor('۷')).toBe(700)
		expect(parseAmountMinor('1.234')).toBeNull()
		expect(parseAmountMinor('1,2,3')).toBeNull()
		expect(deadlineIso('')).toBeNull()
		expect(deadlineIso('2030-01-01T10:00')).toMatch(/^2030-01-01T/)
		expect(deadlineIso('nonsense')).toBeNull()
	})

	it('names what the region refused', () => {
		const text = (code: string, status = 409) =>
			groupErrorText(labels, new OrderRequestError(code, status))
		expect(text('group_limit_reached')).toBe('L:limitReached')
		expect(text('group_locked')).toBe('L:locked')
		expect(text('group_deadline_passed')).toBe('L:pastDeadline')
		expect(text('group_already_ordered')).toBe('L:ordered')
		expect(text('group_not_found', 404)).toBe('L:gone')
		expect(text('rate_limit_exceeded', 429)).toBe('L:limited')
		expect(text('whatever')).toBe('L:failed')
		expect(groupErrorText(labels, new Error('x'))).toBe('L:failed')
	})
})

describe('the group order page (#170)', () => {
	it('asks a signed-out guest to sign in before starting a group', async () => {
		const { root, options } = mount({ isSignedIn: () => false })
		await settled()
		expect(root.querySelector('[data-group-start]')).toBeTruthy()
		root.querySelector<HTMLButtonElement>('button')!.click()
		expect(options.signInAndReturn).toHaveBeenCalled()
		expect(client.createGroup).not.toHaveBeenCalled()
	})

	it('starts a group with the deadline and limits typed, keeps the host’s token, and shows the link to share', async () => {
		client.createGroup.mockResolvedValue({
			groupId: 'g1',
			personToken: PERSON,
			shareToken: SHARE,
			view: view(),
		})
		client.readGroup.mockResolvedValue(view())
		const { root } = mount()
		await settled()
		root.querySelector<HTMLSelectElement>('#group-location')!.value = 'loc-2'
		root.querySelector<HTMLInputElement>('#group-deadline')!.value =
			'2030-01-01T10:00'
		root.querySelector<HTMLInputElement>('#group-per-person')!.value = '25'
		root.querySelector<HTMLInputElement>('#group-total-limit')!.value = '200.50'
		root
			.querySelector<HTMLFormElement>('[data-group-start]')!
			.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
		await settled()
		const request = client.createGroup.mock.calls[0]![0]
		expect(request).toMatchObject({
			locationId: 'loc-2',
			perPersonLimitMinor: 2500,
			totalLimitMinor: 20050,
		})
		expect(request.deadlineAt).toMatch(/^2030-01-01T/)
		expect(JSON.parse(localStorage.getItem('menuza_group_org')!)).toMatchObject(
			{
				groupId: 'g1',
				personToken: PERSON,
				shareToken: SHARE,
				isHost: true,
			},
		)
		expect(root.querySelector('[data-group-view="g1"]')).toBeTruthy()
		const input = root.querySelector<HTMLInputElement>('[data-group-share]')!
		expect(input.value).toContain('/menu/group?g=g1#join=gs1.')
		expect(new URL(input.value).search).not.toContain('gs1')
	})

	it('joins with a link token the layout parked in session storage, and clears it once joined', async () => {
		window.history.replaceState(null, '', '/menu/group?g=g1')
		sessionStorage.setItem('menuza_pending_join', SHARE)
		client.readGroup.mockResolvedValue(
			view({ lines: [], you: null, people: [], canAdd: false }),
		)
		client.joinGroup.mockResolvedValue({
			groupId: 'g1',
			personToken: PERSON,
			view: view({ you: { personId: 'p2', isHost: false } }),
		})
		const { root } = mount()
		await settled()
		const form = root.querySelector<HTMLFormElement>('[data-group-join]')!
		expect(form).toBeTruthy()
		root.querySelector<HTMLInputElement>('#group-first-name')!.value = 'Sam'
		form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
		await settled()
		expect(client.joinGroup).toHaveBeenCalledWith('g1', SHARE, 'Sam')
		expect(sessionStorage.getItem('menuza_pending_join')).toBeNull()
	})

	it('lets a friend join from the link, drops the token from the address bar and keeps their own', async () => {
		window.history.replaceState(null, '', `/menu/group?g=g1#join=${SHARE}`)
		client.readGroup.mockResolvedValue(
			view({ lines: [], you: null, people: [], canAdd: false }),
		)
		client.joinGroup.mockResolvedValue({
			groupId: 'g1',
			personToken: PERSON,
			view: view({ you: { personId: 'p2', isHost: false } }),
		})
		const { root } = mount()
		await settled()
		const form = root.querySelector<HTMLFormElement>('[data-group-join]')!
		expect(form).toBeTruthy()
		root.querySelector<HTMLInputElement>('#group-first-name')!.value = '  Sam '
		form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
		await settled()
		expect(client.joinGroup).toHaveBeenCalledWith('g1', SHARE, 'Sam')
		expect(window.location.hash).toBe('')
		expect(window.location.search).toBe('?g=g1')
		expect(JSON.parse(localStorage.getItem('menuza_group_org')!)).toEqual({
			groupId: 'g1',
			personToken: PERSON,
		})
		expect(root.querySelector('[data-group-view]')).toBeTruthy()
		// A friend has no host panel and no share box.
		expect(root.querySelector('[data-group-host]')).toBeNull()
		expect(root.querySelector('[data-group-share]')).toBeNull()
	})

	it('draws each person’s dishes as text, with who may remove what', async () => {
		localStorage.setItem(
			'menuza_group_org',
			JSON.stringify({
				groupId: 'g1',
				personToken: PERSON,
				shareToken: SHARE,
				isHost: true,
			}),
		)
		client.readGroup.mockResolvedValue(view())
		const { root } = mount()
		await settled()
		const people = [...root.querySelectorAll('[data-group-person]')]
		expect(people).toHaveLength(2)
		// Markup in a name is text.
		expect(root.querySelector('[data-group-person="p2"] b')).toBeNull()
		expect(
			root.querySelector('[data-group-person="p2"]')!.textContent,
		).toContain('Sam <b>x</b>')
		expect(people[0]!.querySelectorAll('[data-group-line]')).toHaveLength(1)
		expect(people[1]!.querySelectorAll('[data-group-line]')).toHaveLength(1)
		expect(root.textContent).toContain('1× Burger')
		expect(root.textContent).toContain('$10.00')
	})

	it('removes a dish and marks "I\'m done" with the person’s own token', async () => {
		localStorage.setItem(
			'menuza_group_org',
			JSON.stringify({ groupId: 'g1', personToken: PERSON }),
		)
		client.readGroup.mockResolvedValue(
			view({ you: { personId: 'p1', isHost: false } }),
		)
		client.removeGroupLine.mockResolvedValue(
			view({ lines: [line('l2', 'p2')] }),
		)
		client.setGroupDone.mockResolvedValue(view())
		const { root } = mount()
		await settled()
		root.querySelector<HTMLButtonElement>('[data-group-remove="l1"]')!.click()
		await settled()
		expect(client.removeGroupLine).toHaveBeenCalledWith('g1', PERSON, 'l1')
		root.querySelector<HTMLButtonElement>('[data-group-done]')!.click()
		await settled()
		expect(client.setGroupDone).toHaveBeenCalledWith('g1', PERSON, true)
	})

	it('adds the visitor’s cart to the group and takes those dishes out of the cart', async () => {
		localStorage.setItem(
			'menuza_group_org',
			JSON.stringify({ groupId: 'g1', personToken: PERSON }),
		)
		localStorage.setItem(
			'menuza_cart_org',
			JSON.stringify([
				{
					id: 'c1',
					itemId: 'i1',
					name: 'Burger',
					basePrice: 10,
					unitPrice: 10,
					quantity: 2,
					instructions: '',
					options: [],
				},
			]),
		)
		client.readGroup.mockResolvedValue(view())
		client.addGroupLine.mockResolvedValue(view())
		const { root } = mount()
		await settled()
		root.querySelector<HTMLButtonElement>('[data-group-add-cart]')!.click()
		await settled()
		expect(client.addGroupLine).toHaveBeenCalledWith('g1', PERSON, {
			itemId: 'i1',
			variantId: undefined,
			quantity: 2,
			instructions: '',
			options: [],
		})
		expect(JSON.parse(localStorage.getItem('menuza_cart_org') ?? '[]')).toEqual(
			[],
		)
	})

	it('shows nobody an add button once the group is locked or ordered, and the host the order', async () => {
		localStorage.setItem(
			'menuza_group_org',
			JSON.stringify({
				groupId: 'g1',
				personToken: PERSON,
				shareToken: SHARE,
				isHost: true,
			}),
		)
		client.readGroup.mockResolvedValue(
			view({
				status: 'ordered',
				canAdd: false,
				order: { id: 'o1', number: 'W-1', status: 'accepted' },
				lines: [line('l1', 'p1', { canRemove: false })],
			}),
		)
		const { root } = mount()
		await settled()
		expect(root.querySelector('[data-group-add-cart]')).toBeNull()
		expect(root.querySelector('[data-group-host]')).toBeNull()
		expect(root.querySelector('[data-group-order="o1"]')).toBeTruthy()
		expect(root.querySelector('a[href="/menu/success?order=o1"]')).toBeTruthy()
		expect(root.querySelector('[data-group-state="ordered"]')).toBeTruthy()
	})

	it('does not redraw when a poll finds the same group, keeps the focus when it does, and drops a stale answer', async () => {
		localStorage.setItem(
			'menuza_group_org',
			JSON.stringify({
				groupId: 'g1',
				personToken: PERSON,
				shareToken: SHARE,
				isHost: true,
			}),
		)
		client.readGroup.mockResolvedValue(view())
		const { root, handle } = mount()
		await settled()
		const first = root.querySelector('[data-group-view]')
		const lock = root.querySelector<HTMLButtonElement>('[data-group-lock]')!
		lock.focus()
		// The same group again (only the server clock moved): nothing is rebuilt.
		client.readGroup.mockResolvedValue(view({ serverNow: 6000 }))
		await handle.refresh()
		expect(root.querySelector('[data-group-view]')).toBe(first)
		expect(lock).toHaveFocus()
		// A newer group redraws, and the focus goes back to the same button.
		client.readGroup.mockResolvedValue(view({ version: 4, totalMinor: 3000 }))
		await handle.refresh()
		expect(root.querySelector('[data-group-view]')).not.toBe(first)
		const again = root.querySelector<HTMLButtonElement>('[data-group-lock]')!
		expect(again).toHaveFocus()
		// An older answer (a poll that was slow) never overwrites a newer one.
		const shown = root.querySelector('[data-group-view]')
		client.readGroup.mockResolvedValue(view({ version: 3 }))
		await handle.refresh()
		expect(root.querySelector('[data-group-view]')).toBe(shown)
	})

	it('forgets a leftover checkout note when the group page opens', async () => {
		sessionStorage.setItem(
			'menuza_group_checkout_org',
			JSON.stringify({
				groupId: 'g1',
				version: 1,
				token: PERSON,
				savedAt: Date.now(),
			}),
		)
		client.readGroup.mockResolvedValue(view())
		mount()
		await settled()
		expect(sessionStorage.getItem('menuza_group_checkout_org')).toBeNull()
	})

	it('lets the host lock, and checks out with the group’s own cart and a note for the checkout page', async () => {
		localStorage.setItem(
			'menuza_group_org',
			JSON.stringify({
				groupId: 'g1',
				personToken: PERSON,
				shareToken: SHARE,
				isHost: true,
			}),
		)
		client.readGroup.mockResolvedValue(view())
		client.updateGroup.mockResolvedValue(view({ status: 'locked' }))
		const assign = vi.fn()
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: {
				...window.location,
				assign,
				origin: 'https://cafe.example',
				hash: '',
				search: '',
				pathname: '/menu/group',
			},
		})
		const { root } = mount()
		await settled()
		root.querySelector<HTMLButtonElement>('[data-group-lock]')!.click()
		await settled()
		expect(client.updateGroup).toHaveBeenCalledWith('g1', PERSON, {
			locked: true,
		})
		client.readGroup.mockResolvedValue(view({ version: 7 }))
		root.querySelector<HTMLButtonElement>('[data-group-checkout]')!.click()
		await settled()
		expect(
			JSON.parse(sessionStorage.getItem('menuza_group_checkout_org')!),
		).toEqual({
			groupId: 'g1',
			version: 7,
			token: PERSON,
			savedAt: expect.any(Number),
		})
		const cart = JSON.parse(localStorage.getItem('menuza_cart_org_group')!)
		expect(cart).toHaveLength(2)
		expect(localStorage.getItem('menuza_cart_org')).toBeNull()
		expect(assign).toHaveBeenCalledWith('/menu/checkout?location=loc-1')
	})

	it('offers to remove dishes that left the menu and holds the checkout until they are gone', async () => {
		localStorage.setItem(
			'menuza_group_org',
			JSON.stringify({
				groupId: 'g1',
				personToken: PERSON,
				shareToken: SHARE,
				isHost: true,
			}),
		)
		client.readGroup.mockResolvedValue(
			view({
				lines: [line('l1', 'p1'), line('l2', 'p2', { available: false })],
			}),
		)
		client.removeGroupLine.mockResolvedValue(
			view({ lines: [line('l1', 'p1')] }),
		)
		const { root } = mount()
		await settled()
		expect(
			root.querySelector<HTMLButtonElement>('[data-group-checkout]')!.disabled,
		).toBe(true)
		root
			.querySelector<HTMLButtonElement>('[data-group-remove-unavailable]')!
			.click()
		await settled()
		expect(client.removeGroupLine).toHaveBeenCalledWith('g1', PERSON, 'l2')
	})

	it('forgets a group the region no longer knows and says so', async () => {
		localStorage.setItem(
			'menuza_group_org',
			JSON.stringify({ groupId: 'g1', personToken: PERSON }),
		)
		client.readGroup.mockRejectedValue(
			new OrderRequestError('group_not_found', 404),
		)
		const { root } = mount()
		await settled()
		expect(root.querySelector('[data-group-gone]')).toBeTruthy()
		expect(localStorage.getItem('menuza_group_org')).toBeNull()
	})

	it('shows a refusal on adding and keeps the page', async () => {
		localStorage.setItem(
			'menuza_group_org',
			JSON.stringify({ groupId: 'g1', personToken: PERSON }),
		)
		localStorage.setItem(
			'menuza_cart_org',
			JSON.stringify([
				{
					id: 'c1',
					itemId: 'i1',
					name: 'B',
					basePrice: 1,
					unitPrice: 1,
					quantity: 1,
					instructions: '',
					options: [],
				},
			]),
		)
		client.readGroup.mockResolvedValue(view())
		client.addGroupLine.mockRejectedValue(
			new OrderRequestError('group_limit_reached', 409),
		)
		const { root } = mount()
		await settled()
		root.querySelector<HTMLButtonElement>('[data-group-add-cart]')!.click()
		await settled()
		expect(root.textContent).toContain('L:limitReached')
		// The dish stays in the cart: nothing went in.
		expect(JSON.parse(localStorage.getItem('menuza_cart_org')!)).toHaveLength(1)
	})
})
