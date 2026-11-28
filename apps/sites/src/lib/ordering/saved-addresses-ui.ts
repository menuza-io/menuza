import {
	SAVED_ADDRESS_LABEL_MAX,
	SAVED_ADDRESS_NOTES_MAX,
	orderSavedAddresses,
	savedAddressTitle,
	type SavedAddress,
} from '@repo/common/saved-addresses'
import {
	createSavedAddress,
	isSignedIn,
	listSavedAddresses,
} from '~/lib/guest-account-client'
import { type SavedAddressLabels } from '~/lib/ordering-labels'

/**
 * Saved delivery addresses inside the checkout details sheet (#113): a picker
 * for a signed-in guest's own addresses and a "Save this address" form offered
 * after a successful quote. Everything goes browser direct to the region; a
 * saved address is quoted again by id when it is picked, never trusted.
 */

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = '',
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag)
	if (className) node.className = className
	if (text !== undefined) node.textContent = text
	return node
}

export type SavedAddressPicker = {
	refresh(): Promise<void>
	select(id: string | null): void
	addresses(): SavedAddress[]
}

export function mountSavedAddressPicker(options: {
	root: HTMLElement
	list: HTMLElement
	labels: SavedAddressLabels
	onPick: (address: SavedAddress) => void
}): SavedAddressPicker {
	const { root, list, labels } = options
	let addresses: SavedAddress[] = []
	let selectedId: string | null = null

	function render() {
		list.replaceChildren()
		root.hidden = addresses.length === 0
		for (const address of addresses) {
			const button = el(
				'button',
				'choice-card focus-ring w-full items-start text-start',
			)
			button.type = 'button'
			button.dataset.savedAddressId = address.id
			button.setAttribute('aria-pressed', String(address.id === selectedId))
			const body = el('span', 'min-w-0 flex-1')
			const head = el('span', 'flex flex-wrap items-center gap-2')
			head.append(
				el('span', 'text-sm font-semibold text-foreground', address.label),
			)
			if (address.isDefault) {
				head.append(el('span', 'badge tone-neutral', labels.defaultBadge))
			}
			const line = el(
				'span',
				'bidi-isolate mt-0.5 block text-xs text-muted-foreground',
				savedAddressTitle({
					label: '',
					line1: address.line1,
					unit: address.unit,
				}).replace(/^: /, ''),
			)
			line.dir = 'auto'
			body.append(head, line)
			button.append(body)
			button.addEventListener('click', () => options.onPick(address))
			list.append(button)
		}
	}

	return {
		async refresh() {
			if (!isSignedIn()) {
				addresses = []
				render()
				return
			}
			const result = await listSavedAddresses()
			addresses = result.ok ? orderSavedAddresses(result.data.addresses) : []
			render()
		},
		select(id) {
			selectedId = id
			for (const button of list.querySelectorAll<HTMLElement>(
				'[data-saved-address-id]',
			)) {
				button.setAttribute(
					'aria-pressed',
					String(button.dataset.savedAddressId === id),
				)
			}
		},
		addresses: () => addresses,
	}
}

export type SaveAddressOffer = {
	locationId: string
	quoteToken: string
	/** The note the guest might want kept with it (never required). */
	notes?: string | null
}

export type SaveAddressForm = {
	/** Offer to save (a deliverable typed address), or hide the form with null. */
	offer(input: SaveAddressOffer | null): void
}

export function mountSaveAddressForm(options: {
	root: HTMLElement
	labels: SavedAddressLabels
	onSaved: (address: SavedAddress) => void
}): SaveAddressForm {
	const { root, labels } = options
	function reset() {
		root.replaceChildren()
		root.hidden = true
	}

	function showMessage(text: string, tone: 'ok' | 'error') {
		root.replaceChildren()
		root.hidden = false
		const message = el(
			'p',
			tone === 'ok'
				? 'text-sm font-medium text-foreground'
				: 'text-sm font-medium text-destructive',
			text,
		)
		message.setAttribute('role', tone === 'ok' ? 'status' : 'alert')
		root.append(message)
	}

	function renderForm(offer: SaveAddressOffer) {
		root.replaceChildren()
		root.hidden = false
		const toggle = el(
			'button',
			'focus-ring text-sm font-medium text-primary hover:underline',
			labels.saveThis,
		)
		toggle.type = 'button'
		toggle.setAttribute('aria-expanded', 'false')
		const form = el('form', 'mt-3 hidden space-y-3')
		form.noValidate = true
		const nameId = 'od-save-name'
		const nameField = el('div', 'space-y-1.5')
		const nameLabel = el(
			'label',
			'block text-sm font-semibold text-foreground',
			labels.nameLabel,
		)
		nameLabel.htmlFor = nameId
		const name = el('input', 'field')
		name.id = nameId
		name.type = 'text'
		name.maxLength = SAVED_ADDRESS_LABEL_MAX
		name.placeholder = labels.namePlaceholder
		name.autocomplete = 'off'
		const chips = el('div', 'flex flex-wrap gap-2')
		for (const text of [labels.home, labels.work]) {
			const chip = el('button', 'chip min-h-9 focus-ring', text)
			chip.type = 'button'
			chip.addEventListener('click', () => {
				name.value = text
				name.focus()
			})
			chips.append(chip)
		}
		nameField.append(nameLabel, name, chips)
		const notesId = 'od-save-notes'
		const notesField = el('div', 'space-y-1.5')
		const notesLabel = el(
			'label',
			'block text-sm font-semibold text-foreground',
			labels.notesLabel,
		)
		notesLabel.htmlFor = notesId
		const notes = el('input', 'field')
		notes.id = notesId
		notes.type = 'text'
		notes.maxLength = SAVED_ADDRESS_NOTES_MAX
		notes.dir = 'auto'
		notes.value = offer.notes ?? ''
		notesField.append(notesLabel, notes)
		const submit = el('button', 'btn-cta w-full', labels.save)
		submit.type = 'submit'
		const status = el('p', 'text-sm text-destructive')
		status.setAttribute('role', 'alert')
		status.hidden = true
		form.append(nameField, notesField, submit, status)
		toggle.addEventListener('click', () => {
			const open = form.classList.toggle('hidden') === false
			toggle.setAttribute('aria-expanded', String(open))
			if (open) name.focus()
		})
		form.addEventListener('submit', async (event) => {
			event.preventDefault()
			const label = name.value.trim()
			if (!label) {
				name.focus()
				return
			}
			submit.disabled = true
			submit.textContent = labels.saving
			status.hidden = true
			const result = await createSavedAddress({
				locationId: offer.locationId,
				quoteToken: offer.quoteToken,
				label,
				...(notes.value.trim() ? { notes: notes.value.trim() } : {}),
			})
			if (result.ok) {
				showMessage(labels.saved, 'ok')
				options.onSaved(result.data.address)
				return
			}
			submit.disabled = false
			submit.textContent = labels.save
			status.textContent =
				result.code === 'address_limit_reached'
					? labels.limitReached
					: result.code === 'signed_out' ||
						  result.code === 'session_unavailable'
						? labels.signInAgain
						: labels.failed
			status.hidden = false
		})
		root.append(toggle, form)
	}

	return {
		offer(input) {
			if (!input || !isSignedIn()) {
				reset()
				return
			}
			renderForm(input)
		},
	}
}
