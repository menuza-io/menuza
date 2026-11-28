/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const isSignedIn = vi.fn()
const listSavedAddresses = vi.fn()
const createSavedAddress = vi.fn()

vi.mock('~/lib/guest-account-client', () => ({
	isSignedIn: () => isSignedIn(),
	listSavedAddresses: () => listSavedAddresses(),
	createSavedAddress: (...args: unknown[]) => createSavedAddress(...args),
}))

import {
	mountSaveAddressForm,
	mountSavedAddressPicker,
} from './saved-addresses-ui'

const labels = {
	heading: 'Saved addresses',
	defaultBadge: 'Default',
	saveThis: 'Save this address',
	nameLabel: 'Name this address',
	namePlaceholder: 'Home, Work…',
	home: 'Home',
	work: 'Work',
	notesLabel: 'Gate code or delivery note',
	save: 'Save address',
	saving: 'Saving…',
	saved: 'Address saved',
	limitReached: 'limit',
	failed: 'failed',
	notDeliveredNow: "We don't deliver here right now",
	notFound: 'gone',
	signInAgain: 'sign in',
}

const address = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	label: id === 'a1' ? 'Home' : 'Work',
	formatted: '233 S Wacker Dr, Chicago',
	line1: '233 S Wacker Dr',
	unit: 'Suite 4',
	city: 'Chicago',
	state: 'IL',
	postalCode: '60606',
	country: 'US',
	notes: null,
	isDefault: id === 'a1',
	createdAt: 1,
	...over,
})

function dom() {
	document.body.innerHTML =
		'<div id="saved" hidden><div id="list"></div></div><div id="offer" hidden></div>'
	return {
		root: document.getElementById('saved')!,
		list: document.getElementById('list')!,
		offer: document.getElementById('offer')!,
	}
}

beforeEach(() => {
	isSignedIn.mockReset()
	listSavedAddresses.mockReset()
	createSavedAddress.mockReset()
})

describe('saved address picker at checkout (#113)', () => {
	it('offers the saved addresses to a signed-in guest, the default first', async () => {
		isSignedIn.mockReturnValue(true)
		listSavedAddresses.mockResolvedValue({
			ok: true,
			data: { addresses: [address('a2'), address('a1')], limit: 10 },
		})
		const { root, list } = dom()
		const onPick = vi.fn()
		const picker = mountSavedAddressPicker({ root, list, labels, onPick })
		await picker.refresh()
		expect(root.hidden).toBe(false)
		const buttons = [...list.querySelectorAll<HTMLButtonElement>('button')]
		expect(buttons.map((b) => b.dataset.savedAddressId)).toEqual(['a1', 'a2'])
		expect(list.textContent).toContain('Default')
		buttons[0]!.click()
		expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }))
		picker.select('a1')
		expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true')
		expect(buttons[1]!.getAttribute('aria-pressed')).toBe('false')
	})

	it('shows nothing to a signed-out guest or a guest with none', async () => {
		const { root, list } = dom()
		const picker = mountSavedAddressPicker({
			root,
			list,
			labels,
			onPick: vi.fn(),
		})
		isSignedIn.mockReturnValue(false)
		await picker.refresh()
		expect(root.hidden).toBe(true)
		expect(listSavedAddresses).not.toHaveBeenCalled()
		isSignedIn.mockReturnValue(true)
		listSavedAddresses.mockResolvedValue({
			ok: true,
			data: { addresses: [], limit: 10 },
		})
		await picker.refresh()
		expect(root.hidden).toBe(true)
	})
})

describe('save this address after a quote (#113)', () => {
	const offer = { locationId: 'loc-1', quoteToken: 'dq1.token.value' }

	it('is offered only to a signed-in guest', () => {
		const { offer: root } = dom()
		const form = mountSaveAddressForm({ root, labels, onSaved: vi.fn() })
		isSignedIn.mockReturnValue(false)
		form.offer(offer)
		expect(root.hidden).toBe(true)
		isSignedIn.mockReturnValue(true)
		form.offer(offer)
		expect(root.hidden).toBe(false)
		expect(root.textContent).toContain('Save this address')
		form.offer(null)
		expect(root.hidden).toBe(true)
	})

	it('saves with the signed quote token, the name and the note', async () => {
		isSignedIn.mockReturnValue(true)
		createSavedAddress.mockResolvedValue({
			ok: true,
			data: { address: address('a9') },
		})
		const { offer: root } = dom()
		const onSaved = vi.fn()
		const form = mountSaveAddressForm({ root, labels, onSaved })
		form.offer(offer)
		root.querySelector<HTMLButtonElement>('button')!.click()
		const [name, notes] = root.querySelectorAll<HTMLInputElement>('input')
		name!.value = 'Home'
		notes!.value = 'Gate code 4411'
		root
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { cancelable: true }))
		await vi.waitFor(() => expect(onSaved).toHaveBeenCalled())
		expect(createSavedAddress).toHaveBeenCalledWith({
			locationId: 'loc-1',
			quoteToken: 'dq1.token.value',
			label: 'Home',
			notes: 'Gate code 4411',
		})
		await vi.waitFor(() => expect(root.textContent).toContain('Address saved'))
	})

	it('keeps the form and what was typed when the same place is quoted again, and saves with the newest token', async () => {
		isSignedIn.mockReturnValue(true)
		createSavedAddress.mockResolvedValue({
			ok: true,
			data: { address: address('a9') },
		})
		const { offer: root } = dom()
		const onSaved = vi.fn()
		const form = mountSaveAddressForm({ root, labels, onSaved })
		form.offer(offer)
		root.querySelector<HTMLButtonElement>('button')!.click()
		const [name] = root.querySelectorAll<HTMLInputElement>('input')
		name!.value = 'Mum'
		const node = root.querySelector('form')
		form.offer({ ...offer, quoteToken: 'dq1.newer.token' })
		expect(root.querySelector('form')).toBe(node)
		expect(root.querySelector<HTMLInputElement>('input')!.value).toBe('Mum')
		root
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { cancelable: true }))
		await vi.waitFor(() => expect(onSaved).toHaveBeenCalled())
		expect(createSavedAddress).toHaveBeenCalledWith(
			expect.objectContaining({ quoteToken: 'dq1.newer.token', label: 'Mum' }),
		)
	})

	it('says why it could not save and lets the guest try again', async () => {
		isSignedIn.mockReturnValue(true)
		createSavedAddress.mockResolvedValue({
			ok: false,
			status: 409,
			code: 'address_limit_reached',
			session: 'ok',
		})
		const { offer: root } = dom()
		const form = mountSaveAddressForm({ root, labels, onSaved: vi.fn() })
		form.offer(offer)
		root.querySelector<HTMLButtonElement>('button')!.click()
		root.querySelector<HTMLInputElement>('input')!.value = 'Work'
		root
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { cancelable: true }))
		await vi.waitFor(() => expect(root.textContent).toContain('limit'))
		expect(
			root.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled,
		).toBe(false)
	})

	it('does not call the region without a name', async () => {
		isSignedIn.mockReturnValue(true)
		const { offer: root } = dom()
		const form = mountSaveAddressForm({ root, labels, onSaved: vi.fn() })
		form.offer(offer)
		root
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { cancelable: true }))
		await Promise.resolve()
		expect(createSavedAddress).not.toHaveBeenCalled()
	})
})
