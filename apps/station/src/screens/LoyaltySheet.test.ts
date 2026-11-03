// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { createElement as h, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { maskPhone, LoyaltySheet } from './LoyaltySheet.tsx'
import { initialLoyaltyState, useLoyalty } from '~/lib/loyalty-store.ts'
import { type LoyaltyMember } from '~/lib/loyalty.ts'
import { usePos } from '~/lib/store.ts'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no modal dialog: the sheet only needs `open` to be set.
beforeEach(() => {
	HTMLDialogElement.prototype.showModal = function showModal() {
		this.setAttribute('open', '')
	}
	HTMLDialogElement.prototype.close = function close() {
		this.removeAttribute('open')
	}
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
	useLoyalty.setState(initialLoyaltyState, false)
	usePos.setState({
		online: true,
		lines: [
			{
				id: 'l1',
				itemId: 'latte',
				name: 'Latte',
				variantId: null,
				variantLabel: null,
				quantity: 1,
				baseCents: 500,
				instructions: '',
				options: [],
			},
		],
		session: null,
	})
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
})

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

function draw() {
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() =>
		root.render(
			h(
				I18nProvider,
				{ i18n },
				h(LoyaltySheet, { open: true, onClose: vi.fn(), money }),
			),
		),
	)
}

const MEMBER: LoyaltyMember = {
	binding: 'b'.repeat(32),
	bindingExpiresAt: Date.now() + 3_600_000,
	firstName: 'Ada',
	unitLabel: 'points',
	balance: { points: 120, reserved: 0, available: 120 },
	rewards: [
		{
			id: 'small',
			version: 1,
			name: 'Free coffee',
			description: null,
			pointsCost: 100,
			kind: 'items',
			currency: 'USD',
		},
		{
			id: 'big',
			version: 1,
			name: 'Free dinner',
			description: null,
			pointsCost: 500,
			kind: 'order',
			currency: 'USD',
		},
	],
	redemptionEnabled: true,
	joined: false,
}

const text = () => host.textContent ?? ''
const buttons = () => [...host.querySelectorAll('button')]
const button = (label: string) =>
	buttons().find((b) => b.textContent?.trim() === label)

describe('the rewards sheet with nobody identified', () => {
	it('offers a member code and a phone number, and tells the guest the number joins the program', () => {
		draw()
		expect(text()).toContain('Member code')
		expect(text()).toContain('Phone number')
		expect(text()).toContain('This number joins the rewards program.')
		expect(button('Skip')).toBeTruthy()
	})

	it('nothing can be sent until there is something to send', () => {
		draw()
		expect(button('Find')?.disabled).toBe(true)
		expect(button('Send code')?.disabled).toBe(true)
	})

	it('hides a phone number behind its last four digits', () => {
		expect(maskPhone('+1 555 010 0401')).toBe('••••0401')
		expect(maskPhone('123')).toBe('123')
	})
})

describe('the rewards sheet with a member', () => {
	it('greets them and shows their balance and how far the next reward is', () => {
		useLoyalty.setState({ member: MEMBER })
		draw()
		expect(text()).toContain('Member found: Ada')
		expect(text()).toContain('120 points')
		expect(text()).toContain('They earn on this order when it is paid.')
		// 500 - 120 = 380 to go for the dearest reward, the cheapest unaffordable.
		expect(text()).toContain('380 points more to Free dinner')
		expect(text()).toContain('380 points to go')
		expect(host.querySelector('[role="progressbar"]')).toBeTruthy()
	})

	it('welcomes a guest who has just joined', () => {
		useLoyalty.setState({ member: { ...MEMBER, joined: true } })
		draw()
		expect(text()).toContain('Welcome, Ada')
	})

	it('a reward they can afford can be used; one they cannot only shows what is missing', () => {
		useLoyalty.setState({ member: MEMBER })
		draw()
		const use = button('Use')
		expect(use).toBeTruthy()
		expect(use?.disabled).toBe(false)
		// Only the affordable reward has a button.
		expect(buttons().filter((b) => b.textContent === 'Use')).toHaveLength(1)
	})

	it('offline, spending is not offered and the reason is said', () => {
		usePos.setState({ online: false })
		useLoyalty.setState({ member: MEMBER })
		draw()
		expect(button('Use')?.disabled).toBe(true)
		expect(text()).toContain(
			'Rewards can only be spent when the till is online.',
		)
		// Earning still works: the sheet still says so.
		expect(text()).toContain('They earn on this order when it is paid.')
	})

	it('with spending switched off the reason is said too', () => {
		useLoyalty.setState({ member: { ...MEMBER, redemptionEnabled: false } })
		draw()
		expect(button('Use')?.disabled).toBe(true)
		expect(text()).toContain('spending points is switched off')
	})

	it('an empty order has nothing to take a reward off', () => {
		usePos.setState({ lines: [] })
		useLoyalty.setState({ member: MEMBER })
		draw()
		expect(button('Use')?.disabled).toBe(true)
		expect(text()).toContain('Add items to the order to use a reward.')
	})

	it('shows the reward on the order and a way to remove it', () => {
		useLoyalty.setState({
			member: MEMBER,
			applied: { approvalId: 'ap1', name: 'Free coffee', discountMinor: 500 },
		})
		draw()
		expect(text()).toContain('Reward on this order: Free coffee')
		expect(text()).toContain('−$5.00')
		expect(button('Remove')).toBeTruthy()
		// One reward per order: the list is out of the way.
		expect(button('Use')).toBeUndefined()
	})

	it('while the guest decides: ask them, text a code, or cancel', () => {
		useLoyalty.setState({
			member: MEMBER,
			waiting: {
				otpSent: false,
				approval: {
					id: 'ap1',
					status: 'pending',
					saleId: 's',
					rewardId: 'small',
					rewardVersion: 1,
					rewardName: 'Free coffee',
					pointsCost: 100,
					discountMinor: 500,
					lines: [],
					redemptionId: null,
					expiresAt: Date.now() + 60_000,
					otpAvailable: true,
					otpSentAt: null,
				},
			},
		})
		draw()
		expect(text()).toContain('Waiting for the guest to approve Free coffee')
		expect(button('Text them a code')).toBeTruthy()
		expect(button('Cancel request')).toBeTruthy()
	})

	it('lets the cashier say it is not them', () => {
		useLoyalty.setState({ member: MEMBER })
		draw()
		expect(button('Not them')).toBeTruthy()
		expect(button('Done')).toBeTruthy()
	})
})
