import {
	SAVED_ADDRESS_NOTES_MAX,
	type SavedAddress,
} from '@repo/common/saved-addresses'
import { getAccessToken } from '~/lib/client-auth'
import {
	createSavedAddress,
	deleteSavedAddress,
	listSavedAddresses,
	updateSavedAddress,
} from '~/lib/guest-account-client'
import { type AddressesPageLabels } from '~/lib/guest-account-labels'
import { browserLocale, browserLocaleHref } from '~/lib/locale'
import {
	createPlacesSearch,
	createSessionToken,
	fetchPlacePredictions,
	requestDeliveryLocations,
	type DeliveryLocationsResult,
	type PlacePrediction,
} from '~/lib/ordering/delivery-client'

/**
 * Profile, Addresses (#113): add, rename, make default and remove saved
 * delivery addresses. Browser direct to the region with the customer token.
 * An address is added only from a successful geocode: the region signs the
 * quote of a store that delivers there, and the save names that signed token.
 */

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = '',
	text?: string,
) {
	const node = document.createElement(tag)
	if (className) node.className = className
	if (text !== undefined) node.textContent = text
	return node
}

const card = 'rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5'
const secondary =
	'inline-flex min-h-9 items-center justify-center rounded-md border border-border px-3 text-sm font-medium focus-ring'

/** The store to save the address against: the first that delivers there. */
export function pickDeliverableStore(
	result: DeliveryLocationsResult,
): { locationId: string; quoteToken: string } | null {
	if (result.status !== 'ok') return null
	const first = result.locations.find((choice) => choice.quote)
	return first?.quote
		? { locationId: first.locationId, quoteToken: first.quote.token }
		: null
}

function field(labelText: string, id: string, input: HTMLInputElement) {
	const wrap = el('div', 'space-y-1.5')
	const label = el(
		'label',
		'block text-sm font-semibold text-foreground',
		labelText,
	)
	label.htmlFor = id
	input.id = id
	wrap.append(label, input)
	return wrap
}

function textInput(maxLength: number, value = '') {
	const input = el('input', 'field')
	input.type = 'text'
	input.maxLength = maxLength
	input.value = value
	input.dir = 'auto'
	return input
}

export function mountAddressesPage(
	root: HTMLElement,
	labels: AddressesPageLabels,
) {
	const searchLocationId = root.dataset.locationId ?? ''
	const locale = root.dataset.locale || browserLocale()
	let addresses: SavedAddress[] = []
	let limit = 10

	const listEl = el('ul', 'space-y-3')
	const status = el('p', 'text-sm text-muted-foreground')
	status.setAttribute('role', 'status')
	const addBox = el('section', card)

	async function load() {
		if (!getAccessToken()) {
			root.replaceChildren()
			const wrap = el('div', 'flex flex-col gap-2 text-sm')
			const link = el('a', 'underline', labels.signInLink)
			link.href = browserLocaleHref('/login')
			wrap.append(el('p', '', labels.signIn), link)
			root.append(wrap)
			return
		}
		const result = await listSavedAddresses()
		if (!result.ok) {
			if (result.code === 'signed_out') return void load()
			root.replaceChildren()
			const retry = el('button', secondary, labels.retry)
			retry.type = 'button'
			retry.addEventListener('click', () => void load())
			root.append(el('p', 'text-sm text-destructive', labels.loadError), retry)
			return
		}
		addresses = result.data.addresses
		limit = result.data.limit
		render()
	}

	function render() {
		root.replaceChildren(listEl, status, addBox)
		listEl.replaceChildren()
		if (addresses.length === 0) {
			const empty = el('li', `${card} text-center`)
			empty.append(
				el('p', 'text-sm font-medium text-foreground', labels.empty),
				el('p', 'mt-1 text-xs text-muted-foreground', labels.emptyHint),
			)
			listEl.append(empty)
		}
		for (const address of addresses) listEl.append(renderRow(address))
		renderAdd()
	}

	function renderRow(address: SavedAddress) {
		const item = el('li', card)
		item.dataset.savedAddressId = address.id
		const head = el('div', 'flex flex-wrap items-center gap-2')
		head.append(
			el('h3', 'text-sm font-semibold text-foreground', address.label),
		)
		if (address.isDefault)
			head.append(el('span', 'badge tone-neutral', labels.defaultBadge))
		const line = el(
			'p',
			'bidi-isolate mt-1 text-sm text-muted-foreground',
			[address.formatted, address.unit].filter(Boolean).join(' · '),
		)
		line.dir = 'auto'
		item.append(head, line)
		if (address.notes) {
			const notes = el('p', 'mt-1 text-xs text-muted-foreground', address.notes)
			notes.dir = 'auto'
			item.append(notes)
		}
		const actions = el('div', 'mt-3 flex flex-wrap gap-2')
		const edit = el('button', secondary, labels.edit)
		edit.type = 'button'
		edit.addEventListener('click', () => {
			const form = renderEdit(address)
			item.replaceWith(form)
			// The Edit button is gone: the keyboard goes to the first field.
			form.querySelector<HTMLInputElement>('input')?.focus()
		})
		actions.append(edit)
		if (!address.isDefault) {
			const make = el('button', secondary, labels.makeDefault)
			make.type = 'button'
			make.addEventListener('click', async () => {
				make.disabled = true
				const result = await updateSavedAddress(address.id, { isDefault: true })
				if (result.ok) {
					await load()
					focusRow(address.id)
				} else report(result.code)
			})
			actions.append(make)
		}
		const remove = el('button', `${secondary} text-destructive`, labels.remove)
		remove.type = 'button'
		remove.addEventListener('click', () => {
			if (!window.confirm(labels.removeConfirm)) return
			void (async () => {
				remove.disabled = true
				const result = await deleteSavedAddress(address.id)
				if (result.ok || result.code === 'address_not_found') {
					await load()
					// The row is gone: the list heading area takes the focus.
					focusList()
				} else report(result.code)
			})()
		})
		actions.append(remove)
		item.append(actions)
		return item
	}

	function renderEdit(address: SavedAddress) {
		const form = el('form', card + ' space-y-3')
		const label = textInput(40, address.label)
		const unit = textInput(50, address.unit ?? '')
		const notes = textInput(SAVED_ADDRESS_NOTES_MAX, address.notes ?? '')
		const row = el('div', 'flex flex-wrap gap-2')
		const save = el('button', 'btn-cta', labels.saveChanges)
		save.type = 'submit'
		const cancel = el('button', secondary, labels.cancel)
		cancel.type = 'button'
		cancel.addEventListener('click', () => {
			render()
			focusRow(address.id)
		})
		row.append(save, cancel)
		form.append(
			field(labels.nameLabel, `addr-label-${address.id}`, label),
			field(labels.unitLabel, `addr-unit-${address.id}`, unit),
			field(labels.notesLabel, `addr-notes-${address.id}`, notes),
			row,
		)
		form.addEventListener('submit', async (event) => {
			event.preventDefault()
			if (!label.value.trim()) return label.focus()
			save.disabled = true
			const result = await updateSavedAddress(address.id, {
				label: label.value.trim(),
				unit: unit.value.trim() || null,
				notes: notes.value.trim() || null,
			})
			if (result.ok) {
				await load()
				focusRow(address.id)
			} else {
				save.disabled = false
				report(result.code)
			}
		})
		return form
	}

	/** After a redraw: the row's Edit button, or the list when the row is gone. */
	function focusRow(id: string) {
		const row = Array.from(
			listEl.querySelectorAll<HTMLElement>('[data-saved-address-id]'),
		).find((item) => item.dataset.savedAddressId === id)
		const target = row?.querySelector<HTMLElement>('button')
		if (target) target.focus()
		else focusList()
	}

	function focusList() {
		listEl.tabIndex = -1
		listEl.focus()
	}

	function report(code: string) {
		status.textContent =
			code === 'address_limit_reached' ? labels.limitReached : labels.failed
	}

	function renderAdd() {
		addBox.replaceChildren()
		if (!searchLocationId) return
		addBox.append(
			el('h2', 'font-heading text-base text-foreground', labels.add),
		)
		if (addresses.length >= limit) {
			addBox.append(
				el('p', 'mt-2 text-sm text-muted-foreground', labels.limitReached),
			)
			return
		}
		const form = el('form', 'mt-3 space-y-3')
		form.noValidate = true
		const search = el('input', 'field')
		search.type = 'text'
		search.dir = 'auto'
		search.autocomplete = 'off'
		search.placeholder = labels.searchPlaceholder
		const suggestions = el(
			'ul',
			'hidden divide-y divide-border rounded-lg border border-border bg-card',
		)
		suggestions.setAttribute('aria-label', labels.suggestions)
		const unit = textInput(50)
		const name = textInput(40)
		const notes = textInput(SAVED_ADDRESS_NOTES_MAX)
		const message = el('p', 'text-sm text-destructive')
		message.setAttribute('role', 'alert')
		const submit = el('button', 'btn-cta w-full', labels.save)
		submit.type = 'submit'
		let sessionToken = createSessionToken()
		let chosen: { placeId?: string; text: string } | null = null

		const places = createPlacesSearch({
			fetchPredictions: (query, signal) =>
				fetchPlacePredictions({
					locationId: searchLocationId,
					query,
					sessionToken,
					locale,
					signal,
				}),
			onState: (state) => {
				suggestions.replaceChildren()
				const predictions: PlacePrediction[] =
					state.status === 'ready' ? state.predictions : []
				suggestions.classList.toggle('hidden', predictions.length === 0)
				for (const prediction of predictions) {
					const option = el('li')
					const button = el(
						'button',
						'block w-full px-3 py-2 text-start text-sm focus-ring',
					)
					button.type = 'button'
					button.textContent = [prediction.mainText, prediction.secondaryText]
						.filter(Boolean)
						.join(', ')
					button.dir = 'auto'
					button.addEventListener('click', () => {
						search.value = button.textContent ?? ''
						chosen = { placeId: prediction.placeId, text: search.value }
						suggestions.classList.add('hidden')
					})
					option.append(button)
					suggestions.append(option)
				}
			},
		})
		search.addEventListener('input', () => {
			chosen = null
			message.textContent = ''
			places.search(search.value)
		})

		form.append(
			field(labels.searchPlaceholder, 'addr-search', search),
			suggestions,
			field(labels.unitLabel, 'addr-unit', unit),
			field(labels.nameLabel, 'addr-name', name),
			field(labels.notesLabel, 'addr-notes', notes),
			message,
			submit,
		)
		form.addEventListener('submit', async (event) => {
			event.preventDefault()
			message.textContent = ''
			const text = search.value.trim()
			if (!name.value.trim()) return name.focus()
			if (!chosen && text.length < 3) return search.focus()
			submit.disabled = true
			submit.textContent = labels.checking
			try {
				const found = await requestDeliveryLocations({
					purpose: 'delivery',
					placeId: chosen?.placeId,
					address: chosen?.placeId ? undefined : (chosen?.text ?? text),
					unit: unit.value.trim() || undefined,
					sessionToken,
					locale,
				})
				sessionToken = createSessionToken()
				if (found.status === 'not_found') {
					message.textContent = labels.addressNotFound
					return
				}
				const store = pickDeliverableStore(found)
				if (!store) {
					message.textContent = labels.cantSave
					return
				}
				const saved = await createSavedAddress({
					locationId: store.locationId,
					quoteToken: store.quoteToken,
					label: name.value.trim(),
					...(notes.value.trim() ? { notes: notes.value.trim() } : {}),
				})
				if (saved.ok) await load()
				else
					message.textContent =
						saved.code === 'address_limit_reached'
							? labels.limitReached
							: labels.failed
			} catch {
				message.textContent = labels.failed
			} finally {
				submit.disabled = false
				submit.textContent = labels.save
			}
		})
		addBox.append(form)
	}

	void load()
}

const root = document.getElementById('saved-addresses-root')
if (root?.dataset.labels) {
	mountAddressesPage(
		root,
		JSON.parse(root.dataset.labels) as AddressesPageLabels,
	)
}
