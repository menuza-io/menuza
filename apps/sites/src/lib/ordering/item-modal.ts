import { newLineId } from './cart-store.ts'
import { remainingFor } from './constraints.ts'
import { el, icon, lockScroll, prefersReducedMotion, trapFocus } from './dom.ts'
import { fillTemplate } from './money.ts'
import {
	type CartItem,
	type CartLine,
	type CartOption,
	type Constraints,
	type Half,
	type ModifierGroup,
	type ModifierOption,
	type OrderingItem,
	type OrderingLabels,
	type Remaining,
	type Variant,
} from './types.ts'

export type ItemModalOptions = {
	/** The `#item-modal-backdrop` element rendered by `ItemModal.astro`. */
	root: HTMLElement
	getItem: (itemId: string) => OrderingItem | undefined
	labels: OrderingLabels
	formatMoney: (amount: number) => string
	constraints?: Constraints | null
	/** Current cart lines, used to cap the quantity stepper. */
	cartLines?: () => CartLine[]
	onAdd: (line: CartItem) => void
	/** Mirror the open item into `?item=<id>` (default true). */
	syncUrl?: boolean
}

export type ItemModal = {
	open(itemId: string, opener?: HTMLElement | null): boolean
	close(): void
	openFromUrl(): boolean
	isOpen(): boolean
}

type Selected = CartOption

type GroupView = {
	group: ModifierGroup
	element: HTMLElement
	status: HTMLElement
	statusText: string
	count: () => number
	enforceMax: () => void
	reset: () => void
}

// `chip` and `segmented-item` style their active state from `aria-checked`
// (set below) and `.is-active`, so the swapped sets are just the marker.
const PILL_BASE = 'chip min-h-10 focus-ring disabled:cursor-not-allowed'
const PILL_ON = 'is-active'
const PILL_OFF = ''
const PILL_DISABLED = ''

const SEGMENT_BASE =
	'segmented-item min-h-8 px-2.5 text-xs focus-ring disabled:cursor-not-allowed disabled:opacity-50'
const SEGMENT_ON = 'is-active'
const SEGMENT_OFF = ''

const STEP_BTN = 'icon-btn size-8'

const STATUS_BASE = 'badge shrink-0'
const STATUS_IDLE = 'tone-neutral'
const STATUS_DONE = 'tone-success'
const STATUS_ERROR = 'tone-danger'

function setPill(button: HTMLButtonElement, on: boolean, disabled = false) {
	button.className = `${PILL_BASE} ${disabled ? PILL_DISABLED : on ? PILL_ON : PILL_OFF}`
	button.setAttribute('aria-checked', on ? 'true' : 'false')
	button.disabled = disabled
}

function setSegment(button: HTMLButtonElement, on: boolean) {
	button.className = `${SEGMENT_BASE} ${on ? SEGMENT_ON : SEGMENT_OFF}`
	button.setAttribute('aria-checked', on ? 'true' : 'false')
}

function isUnavailable(option: ModifierOption): boolean {
	return option.availabilityStatus === 'unavailable'
}

export function createItemModal(options: ItemModalOptions): ItemModal {
	const { root, labels, formatMoney, getItem } = options
	const syncUrl = options.syncUrl !== false
	const cartLines = options.cartLines ?? (() => [])
	const q = <T extends HTMLElement>(id: string) =>
		root.querySelector<T>(`#${id}`)

	const dialog = q<HTMLElement>('item-modal-dialog')
	const closeBtn = q<HTMLButtonElement>('close-item-modal')
	const media = q<HTMLElement>('modal-item-media')
	const nameEl = q<HTMLElement>('modal-item-name')
	const descEl = q<HTMLElement>('modal-item-desc')
	const priceEl = q<HTMLElement>('modal-item-price')
	const variationsEl = q<HTMLElement>('modal-variation-groups')
	const unavailableEl = q<HTMLElement>('modal-variation-unavailable')
	const groupsEl = q<HTMLElement>('modal-modifier-groups')
	const instructionsField = q<HTMLElement>('modal-special-instructions-field')
	const instructionsEl = q<HTMLTextAreaElement>('modal-special-instructions')
	const qtyMinus = q<HTMLButtonElement>('modal-qty-minus')
	const qtyValue = q<HTMLElement>('modal-qty-value')
	const qtyPlus = q<HTMLButtonElement>('modal-qty-plus')
	const qtyNote = q<HTMLElement>('modal-qty-note')
	const addBtn = q<HTMLButtonElement>('modal-add-btn')
	qtyMinus?.setAttribute('aria-label', labels.decrease)
	qtyPlus?.setAttribute('aria-label', labels.increase)

	if (!dialog || !groupsEl || !variationsEl || !addBtn) {
		throw new Error('ItemModal markup is missing required elements')
	}

	let item: OrderingItem | null = null
	let opener: HTMLElement | null = null
	let variationValues: string[] = []
	let variant: Variant | null = null
	let quantity = 1
	let cap: Remaining = { max: null, reason: null }
	let selections = new Map<string, Selected[]>()
	let groupViews: GroupView[] = []
	let releaseTrap: (() => void) | null = null
	let releaseScroll: (() => void) | null = null

	// ---------- pricing ----------

	function unitPrice(): number {
		if (!item) return 0
		let price = variant?.price ?? item.price
		for (const list of selections.values()) {
			for (const sel of list) price += sel.priceDelta || 0
		}
		return price
	}

	function variationBlocked(): boolean {
		return Boolean(
			item?.variations?.groups?.length &&
			(!variant || variant.availabilityStatus === 'unavailable'),
		)
	}

	function updateAddButton() {
		if (!item) return
		const blocked = variationBlocked()
		const capped = cap.max !== null && cap.max <= 0
		addBtn!.disabled = blocked || capped
		if (blocked) {
			addBtn!.textContent = labels.soldOut
			return
		}
		if (capped) {
			addBtn!.textContent =
				cap.reason === 'limit' ? labels.limitReached : labels.soldOut
			return
		}
		addBtn!.textContent = `${labels.addToOrder} · ${formatMoney(unitPrice() * quantity)}`
	}

	// ---------- quantity ----------

	function capNote(): string {
		if (cap.max === null) return ''
		const showInventory = options.constraints?.showInventory !== false
		switch (cap.reason) {
			case 'inventory':
				return showInventory
					? fillTemplate(labels.onlyNLeft, { count: cap.remaining ?? cap.max })
					: ''
			case 'category-inventory':
				return showInventory
					? fillTemplate(labels.onlyNLeftIn, {
							count: cap.max,
							category: cap.categoryName ?? '',
						})
					: ''
			case 'limit':
				return fillTemplate(labels.limitNPerOrder, {
					count: cap.limit ?? cap.max,
				})
			default:
				return ''
		}
	}

	function updateQuantity() {
		if (qtyValue) qtyValue.textContent = String(quantity)
		if (qtyMinus) qtyMinus.disabled = quantity <= 1
		if (qtyPlus) qtyPlus.disabled = cap.max !== null && quantity >= cap.max
		if (qtyNote) {
			const note = capNote()
			qtyNote.textContent = note
			qtyNote.classList.toggle('hidden', !note)
		}
		updateAddButton()
	}

	function refreshCap() {
		if (!item) return
		cap = remainingFor(item.id, cartLines(), options.constraints)
		if (cap.max !== null) quantity = Math.max(1, Math.min(quantity, cap.max))
		updateQuantity()
	}

	// ---------- variations ----------

	function resolveVariant() {
		if (!item) return
		variant =
			item.variations.variants.find((candidate) =>
				candidate.valueIds.every((id, index) => id === variationValues[index]),
			) ?? null
		const blocked = variationBlocked()
		if (unavailableEl) {
			unavailableEl.textContent = labels.combinationUnavailable
			unavailableEl.classList.toggle('hidden', !blocked)
		}
		if (priceEl) priceEl.textContent = formatMoney(variant?.price ?? item.price)
		renderMedia(variant?.imageUrl || item.imageUrl)
		updateAddButton()
	}

	function renderMedia(src: string | null | undefined) {
		if (!media) return
		media.replaceChildren()
		if (!src) {
			media.classList.add('hidden')
			return
		}
		const img = document.createElement('img')
		img.src = src
		img.alt = ''
		img.loading = 'eager'
		img.className = 'size-full object-cover'
		media.appendChild(img)
		media.classList.remove('hidden')
	}

	function renderVariations() {
		if (!item) return
		variationsEl!.replaceChildren()
		const groups = item.variations.groups
		const variants = item.variations.variants
		const singleGroup = groups.length === 1

		groups.forEach((group, groupIndex) => {
			const fieldset = el('fieldset', 'space-y-3')
			const legendId = `modal-variation-${groupIndex}-label`
			const legend = el(
				'legend',
				'text-base font-semibold text-foreground',
				group.name,
			)
			legend.id = legendId
			fieldset.appendChild(legend)
			const list = el('div', 'flex flex-wrap gap-2')
			list.setAttribute('role', 'radiogroup')
			list.setAttribute('aria-labelledby', legendId)

			for (const value of group.values) {
				const matching = variants.filter(
					(candidate) => candidate.valueIds[groupIndex] === value.id,
				)
				const soldOut =
					matching.length > 0 &&
					matching.every(
						(candidate) => candidate.availabilityStatus === 'unavailable',
					)
				const button = el('button')
				button.type = 'button'
				button.setAttribute('role', 'radio')
				button.appendChild(el('span', undefined, value.name))
				if (singleGroup && !soldOut) {
					const available = matching.find(
						(candidate) => candidate.availabilityStatus !== 'unavailable',
					)
					if (available) {
						button.appendChild(
							el('span', 'text-xs opacity-80', formatMoney(available.price)),
						)
					}
				}
				if (soldOut) {
					button.appendChild(el('span', 'text-xs', labels.soldOut))
				}
				const paint = () =>
					setPill(button, variationValues[groupIndex] === value.id, soldOut)
				paint()
				button.addEventListener('click', () => {
					if (soldOut) return
					variationValues[groupIndex] = value.id
					list
						.querySelectorAll<HTMLButtonElement>('button[role="radio"]')
						.forEach((sibling) =>
							setPill(
								sibling,
								sibling.dataset.valueId === value.id,
								sibling.disabled,
							),
						)
					resolveVariant()
				})
				button.dataset.valueId = value.id
				list.appendChild(button)
			}
			fieldset.appendChild(list)
			variationsEl!.appendChild(fieldset)
		})
	}

	// ---------- modifier groups ----------

	function requirementText(group: ModifierGroup): string {
		const min = group.minSelections || 0
		const max =
			group.selectionType === 'single' ? 1 : (group.maxSelections ?? null)
		if (min > 0) {
			let detail: string
			if (max !== null && max === min) {
				detail =
					min === 1
						? labels.chooseOne
						: fillTemplate(labels.chooseN, { count: min })
			} else if (max !== null && max > min) {
				detail = fillTemplate(labels.chooseRange, { min, max })
			} else {
				detail =
					min === 1
						? labels.chooseOne
						: fillTemplate(labels.chooseAtLeastN, { count: min })
			}
			return `${labels.required} · ${detail}`
		}
		return max !== null && group.selectionType !== 'single'
			? `${labels.optional} · ${fillTemplate(labels.upToN, { count: max })}`
			: labels.optional
	}

	function errorText(group: ModifierGroup): string {
		const min = group.minSelections || 0
		return min <= 1
			? labels.chooseAtLeastOne
			: fillTemplate(labels.chooseAtLeastNOptions, { count: min })
	}

	function selectedFor(groupId: string): Selected[] {
		let list = selections.get(groupId)
		if (!list) {
			list = []
			selections.set(groupId, list)
		}
		return list
	}

	function isVisible(element: HTMLElement): boolean {
		return !element.closest('.hidden')
	}

	function paintStatus(view: GroupView, state: 'idle' | 'done' | 'error') {
		const { status } = view
		status.replaceChildren()
		status.removeAttribute('role')
		view.element.removeAttribute('aria-invalid')
		if (state === 'done') {
			status.className = `${STATUS_BASE} ${STATUS_DONE}`
			status.appendChild(icon('check', 'size-3.5'))
			status.appendChild(el('span', undefined, labels.done))
		} else if (state === 'error') {
			status.className = `${STATUS_BASE} ${STATUS_ERROR}`
			status.setAttribute('role', 'alert')
			status.textContent = errorText(view.group)
			view.element.setAttribute('aria-invalid', 'true')
		} else {
			status.className = `${STATUS_BASE} ${STATUS_IDLE}`
			status.textContent = view.statusText
		}
	}

	function refreshGroup(view: GroupView) {
		const count = view.count()
		const required = (view.group.minSelections || 0) > 0
		paintStatus(
			view,
			required && count >= view.group.minSelections ? 'done' : 'idle',
		)
		view.enforceMax()
	}

	function findView(groupId: string): GroupView | undefined {
		return groupViews.find((view) => view.group.id === groupId)
	}

	function clearNested(container: HTMLElement) {
		for (const view of groupViews) {
			if (container.contains(view.element)) view.reset()
		}
		container
			.querySelectorAll<HTMLElement>('.js-nested')
			.forEach((nested) => nested.classList.add('hidden'))
	}

	function toggleNested(nested: HTMLElement | null, show: boolean) {
		if (!nested) return
		if (show) {
			nested.classList.remove('hidden')
			for (const view of groupViews) {
				if (nested.contains(view.element)) refreshGroup(view)
			}
		} else {
			nested.classList.add('hidden')
			clearNested(nested)
		}
	}

	function priceSuffix(amount: number): HTMLElement | null {
		if (!(amount > 0)) return null
		return el(
			'span',
			// plaintext keeps a leading "+" before the amount in RTL.
			'price shrink-0 text-sm font-medium text-muted-foreground [unicode-bidi:plaintext]',
			`+${formatMoney(amount)}`,
		)
	}

	function optionText(option: ModifierOption): HTMLElement {
		const wrap = el('span', 'min-w-0 flex-1')
		wrap.appendChild(
			el('span', 'block text-sm text-foreground', option.displayName),
		)
		if (option.description) {
			wrap.appendChild(
				el('span', 'block text-xs text-muted-foreground', option.description),
			)
		}
		return wrap
	}

	function renderNested(
		option: ModifierOption,
		depth: number,
	): HTMLElement | null {
		const nestedGroups = option.nestedModifierGroups ?? []
		if (!nestedGroups.length) return null
		const nested = el(
			'div',
			'js-nested hidden ms-7 mb-2 space-y-1 rounded-lg bg-muted/60 px-3 pb-1',
		)
		for (const group of nestedGroups)
			nested.appendChild(renderGroup(group, depth + 1))
		return nested
	}

	type GroupBehaviour = Pick<GroupView, 'count' | 'enforceMax' | 'reset'>

	function renderChoiceGroup(
		group: ModifierGroup,
		body: HTMLElement,
		depth: number,
	): GroupBehaviour {
		const single = group.selectionType === 'single'
		const inputName = `grp_${group.id}`
		const rows: Array<{
			input: HTMLInputElement
			option: ModifierOption
			nested: HTMLElement | null
		}> = []

		for (const option of group.options) {
			const row = el('div')
			const label = el(
				'label',
				'flex min-h-12 cursor-pointer items-center gap-3 py-2',
			)
			const input = document.createElement('input')
			input.type = single ? 'radio' : 'checkbox'
			input.name = inputName
			input.value = option.id
			input.className = 'size-4.5 shrink-0 accent-primary focus-ring'
			const unavailable = isUnavailable(option)
			input.disabled = unavailable
			if (unavailable) label.classList.add('cursor-not-allowed', 'opacity-60')
			label.appendChild(input)
			label.appendChild(optionText(option))
			const suffix = unavailable
				? el('span', 'badge tone-neutral shrink-0', labels.soldOut)
				: priceSuffix(option.price)
			if (suffix) label.appendChild(suffix)
			row.appendChild(label)
			const nested = renderNested(option, depth)
			if (nested) row.appendChild(nested)
			body.appendChild(row)
			rows.push({ input, option, nested })
		}

		const sync = () => {
			const list = selectedFor(group.id)
			list.length = 0
			for (const { input, option, nested } of rows) {
				if (input.checked) {
					list.push({
						groupId: group.id,
						groupName: group.name,
						optionId: option.id,
						optionName: option.displayName,
						priceDelta: option.price || 0,
					})
				}
				toggleNested(nested, input.checked)
			}
			const view = findView(group.id)
			if (view) refreshGroup(view)
			updateAddButton()
		}

		for (const { input } of rows) {
			if (single && (group.minSelections || 0) === 0) {
				// Optional radio groups can be cleared by activating the chosen option
				// again. Pointer and keyboard paths are tracked separately: arrow keys
				// fire keydown on the old radio but click on the new one, so a shared
				// flag would uncheck options while the user is just navigating.
				let pointerWasChecked = false
				let spaceWasChecked = false
				input.addEventListener('pointerdown', () => {
					pointerWasChecked = input.checked
				})
				input.addEventListener('pointercancel', () => {
					pointerWasChecked = false
				})
				input.addEventListener('keydown', (event) => {
					spaceWasChecked = event.key === ' ' && input.checked
				})
				input.addEventListener('click', (event) => {
					const viaKeyboard = event.detail === 0
					const toggleOff = viaKeyboard ? spaceWasChecked : pointerWasChecked
					pointerWasChecked = false
					spaceWasChecked = false
					if (toggleOff) {
						input.checked = false
						sync()
					}
				})
			}
			input.addEventListener('change', sync)
		}

		// Defaults populate state the same way a tap would.
		let hasDefault = false
		for (const { input, option } of rows) {
			if (option.isDefault && !input.disabled && (!single || !hasDefault)) {
				input.checked = true
				hasDefault = true
			}
		}
		if (hasDefault) sync()

		return {
			count: () => rows.filter(({ input }) => input.checked).length,
			enforceMax: () => {
				if (single) return
				const max = group.maxSelections
				const checked = rows.filter(({ input }) => input.checked).length
				for (const { input, option } of rows) {
					if (isUnavailable(option)) continue
					input.disabled = max !== null && !input.checked && checked >= max
				}
			},
			reset: () => {
				for (const { input } of rows) input.checked = false
				sync()
			},
		}
	}

	function renderQuantityGroup(
		group: ModifierGroup,
		body: HTMLElement,
	): GroupBehaviour {
		const rows: Array<{
			option: ModifierOption
			qty: number
			value: HTMLElement
			plus: HTMLButtonElement
			minus: HTMLButtonElement
		}> = []

		const total = () => rows.reduce((acc, row) => acc + row.qty, 0)

		const sync = () => {
			const list = selectedFor(group.id)
			list.length = 0
			for (const row of rows) {
				row.value.textContent = String(row.qty)
				row.minus.disabled = row.qty <= 0
				if (row.qty > 0) {
					list.push({
						groupId: group.id,
						groupName: group.name,
						optionId: row.option.id,
						optionName: row.option.displayName,
						priceDelta: (row.option.price || 0) * row.qty,
						quantity: row.qty,
					})
				}
			}
			const view = findView(group.id)
			if (view) refreshGroup(view)
			updateAddButton()
		}

		for (const option of group.options) {
			const row = el('div', 'flex min-h-12 items-center gap-3 py-2')
			const unavailable = isUnavailable(option)
			row.appendChild(optionText(option))
			const suffix = unavailable
				? el('span', 'badge tone-neutral shrink-0', labels.soldOut)
				: priceSuffix(option.price)
			if (suffix) row.appendChild(suffix)
			const stepper = el('div', 'flex shrink-0 items-center gap-2')
			stepper.setAttribute('role', 'group')
			stepper.setAttribute('aria-label', option.displayName)
			const minus = el('button', STEP_BTN)
			minus.type = 'button'
			minus.setAttribute(
				'aria-label',
				`${labels.decrease}: ${option.displayName}`,
			)
			minus.appendChild(icon('minus'))
			const value = el(
				'span',
				'price min-w-5 text-center text-sm text-foreground',
				'0',
			)
			value.setAttribute('aria-live', 'polite')
			const plus = el('button', STEP_BTN)
			plus.type = 'button'
			plus.setAttribute(
				'aria-label',
				`${labels.increase}: ${option.displayName}`,
			)
			plus.appendChild(icon('plus'))
			if (unavailable) {
				plus.disabled = true
				minus.disabled = true
			}
			stepper.append(minus, value, plus)
			row.appendChild(stepper)
			body.appendChild(row)
			const entry = { option, qty: 0, value, plus, minus }
			rows.push(entry)
			minus.addEventListener('click', () => {
				if (entry.qty <= 0) return
				entry.qty -= 1
				sync()
			})
			plus.addEventListener('click', () => {
				entry.qty += 1
				sync()
			})
		}

		sync()
		return {
			count: total,
			enforceMax: () => {
				const groupMax = group.maxSelections
				const sum = total()
				for (const row of rows) {
					if (isUnavailable(row.option)) continue
					const optionMax = row.option.maxSelections ?? null
					row.plus.disabled =
						(groupMax !== null && sum >= groupMax) ||
						(optionMax !== null && row.qty >= optionMax)
				}
			},
			reset: () => {
				for (const row of rows) row.qty = 0
				sync()
			},
		}
	}

	function renderPizzaGroup(
		group: ModifierGroup,
		body: HTMLElement,
	): GroupBehaviour {
		const halves: Half[] = ['whole', 'left', 'right']
		const halfLabel: Record<Half, string> = {
			whole: labels.whole,
			left: labels.left,
			right: labels.right,
		}
		const halfPrice = (option: ModifierOption, half: Half) => {
			if (half === 'whole') return option.priceWhole ?? option.price ?? 0
			const side = half === 'left' ? option.priceLeft : option.priceRight
			return side ?? (option.price ? option.price / 2 : 0)
		}
		const rows: Array<{
			option: ModifierOption
			half: Half | null
			buttons: HTMLButtonElement[]
		}> = []

		const sync = () => {
			const list = selectedFor(group.id)
			list.length = 0
			for (const row of rows) {
				row.buttons.forEach((button) =>
					setSegment(
						button,
						row.half !== null && button.dataset.half === row.half,
					),
				)
				if (row.half) {
					list.push({
						groupId: group.id,
						groupName: group.name,
						optionId: row.option.id,
						optionName: row.option.displayName,
						priceDelta: halfPrice(row.option, row.half),
						half: row.half,
					})
				}
			}
			const view = findView(group.id)
			if (view) refreshGroup(view)
			updateAddButton()
		}

		for (const option of group.options) {
			const row = el(
				'div',
				'flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 py-2',
			)
			const unavailable = isUnavailable(option)
			row.appendChild(optionText(option))
			const suffix = unavailable
				? el('span', 'badge tone-neutral shrink-0', labels.soldOut)
				: priceSuffix(halfPrice(option, 'whole'))
			if (suffix) row.appendChild(suffix)
			const segmented = el('div', 'segmented shrink-0 gap-0.5 p-0.5')
			segmented.setAttribute('role', 'radiogroup')
			segmented.setAttribute('aria-label', option.displayName)
			const entry: {
				option: ModifierOption
				half: Half | null
				buttons: HTMLButtonElement[]
			} = {
				option,
				half: option.isDefault && !unavailable ? 'whole' : null,
				buttons: [],
			}
			for (const half of halves) {
				const button = el('button', undefined, halfLabel[half])
				button.type = 'button'
				button.dataset.half = half
				button.setAttribute('role', 'radio')
				button.disabled = unavailable
				setSegment(button, false)
				button.addEventListener('click', () => {
					entry.half = entry.half === half ? null : half
					sync()
				})
				entry.buttons.push(button)
				segmented.appendChild(button)
			}
			row.appendChild(segmented)
			body.appendChild(row)
			rows.push(entry)
		}

		sync()
		return {
			count: () => rows.filter((row) => row.half !== null).length,
			enforceMax: () => {
				const max = group.maxSelections
				const chosen = rows.filter((row) => row.half !== null).length
				for (const row of rows) {
					if (isUnavailable(row.option)) continue
					const blocked = max !== null && row.half === null && chosen >= max
					row.buttons.forEach((button) => (button.disabled = blocked))
				}
			},
			reset: () => {
				for (const row of rows) row.half = null
				sync()
			},
		}
	}

	function renderGroup(group: ModifierGroup, depth = 0): HTMLElement {
		const section = el(
			'fieldset',
			depth === 0 ? 'border-t border-border px-5 py-4 sm:px-6' : 'pt-2',
		)
		section.dataset.groupId = group.id
		const header = el('div', 'flex items-center justify-between gap-3')
		const titleTag = depth === 0 ? 'h3' : 'h4'
		const title = el(
			titleTag,
			depth === 0
				? 'min-w-0 text-base font-semibold text-foreground'
				: 'min-w-0 text-sm font-semibold text-foreground',
			group.name,
		)
		const legend = el('legend', 'sr-only', group.name)
		section.appendChild(legend)
		header.appendChild(title)
		const status = el('span', `${STATUS_BASE} ${STATUS_IDLE}`)
		header.appendChild(status)
		section.appendChild(header)
		const body = el('div', 'mt-1 divide-y divide-border/60')
		section.appendChild(body)

		// Register the view before rendering options so default selections can
		// refresh the header through `findView` while they sync.
		const view: GroupView = {
			group,
			element: section,
			status,
			statusText: requirementText(group),
			count: () => 0,
			enforceMax: () => {},
			reset: () => {},
		}
		groupViews.push(view)

		const behaviour =
			group.selectionType === 'quantity'
				? renderQuantityGroup(group, body)
				: group.selectionType === 'pizza'
					? renderPizzaGroup(group, body)
					: renderChoiceGroup(group, body, depth)
		view.count = behaviour.count
		view.enforceMax = behaviour.enforceMax
		view.reset = behaviour.reset
		refreshGroup(view)
		return section
	}

	function renderGroups() {
		if (!item) return
		groupsEl!.replaceChildren()
		groupViews = []
		selections = new Map()
		for (const group of item.modifierGroups ?? []) {
			if (group.availabilityStatus === 'unavailable') continue
			groupsEl!.appendChild(renderGroup(group))
		}
		// Defaults selected during render may have populated nested groups; make
		// sure every header reflects the final state.
		for (const view of groupViews) refreshGroup(view)
	}

	// ---------- validation and add ----------

	function validate(): boolean {
		if (variationBlocked()) {
			variationsEl!
				.querySelector<HTMLElement>('button:not([disabled])')
				?.focus()
			return false
		}
		for (const view of groupViews) {
			if (!isVisible(view.element)) continue
			const min = view.group.minSelections || 0
			if (min > 0 && view.count() < min) {
				paintStatus(view, 'error')
				view.element.scrollIntoView({
					block: 'center',
					behavior: prefersReducedMotion() ? 'auto' : 'smooth',
				})
				view.element
					.querySelector<HTMLElement>(
						'input:not([disabled]), button:not([disabled])',
					)
					?.focus({ preventScroll: true })
				return false
			}
		}
		return true
	}

	function buildLine(): CartItem | null {
		if (!item) return null
		const base = variant?.price ?? item.price
		const variationOptions: CartOption[] = item.variations.groups.map(
			(group, index) => ({
				groupId: group.id,
				groupName: group.name,
				optionId: variationValues[index] ?? '',
				optionName:
					group.values.find((value) => value.id === variationValues[index])
						?.name ?? '',
				priceDelta: 0,
				variation: true,
			}),
		)
		const flat: CartOption[] = []
		for (const view of groupViews) {
			if (!isVisible(view.element)) continue
			flat.push(...(selections.get(view.group.id) ?? []))
		}
		return {
			id: newLineId(),
			itemId: item.id,
			variantId: variant?.id,
			name: item.displayName,
			basePrice: base,
			unitPrice: unitPrice(),
			quantity,
			options: [...variationOptions, ...flat],
			instructions:
				item.specialInstructions === false
					? ''
					: (instructionsEl?.value.trim() ?? ''),
		}
	}

	function handleAdd() {
		if (!item || addBtn!.disabled) return
		if (!validate()) return
		const line = buildLine()
		if (!line) return
		options.onAdd(line)
		close()
	}

	// ---------- open / close ----------

	function setUrlParam(itemId: string | null) {
		if (!syncUrl || typeof history === 'undefined') return
		const url = new URL(window.location.href)
		if (itemId) url.searchParams.set('item', itemId)
		else url.searchParams.delete('item')
		history.replaceState(history.state, '', url)
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault()
			close()
		}
	}

	function open(itemId: string, from?: HTMLElement | null): boolean {
		const next = getItem(itemId)
		if (!next) return false
		item = next
		opener =
			from ??
			(document.activeElement instanceof HTMLElement
				? document.activeElement
				: null)
		quantity = 1
		variant = null
		const firstAvailable = next.variations.variants.find(
			(candidate) => candidate.availabilityStatus !== 'unavailable',
		)
		variationValues = firstAvailable
			? [...firstAvailable.valueIds]
			: next.variations.groups.map((group) => group.values[0]?.id ?? '')

		if (nameEl) nameEl.textContent = next.displayName
		if (descEl) {
			descEl.textContent = next.description ?? ''
			descEl.classList.toggle('hidden', !next.description)
		}
		if (instructionsEl) instructionsEl.value = ''
		instructionsField?.classList.toggle(
			'hidden',
			next.specialInstructions === false,
		)

		renderVariations()
		resolveVariant()
		renderGroups()
		refreshCap()
		updateAddButton()

		root.classList.remove('hidden')
		releaseScroll = lockScroll()
		releaseTrap = trapFocus(dialog!)
		document.addEventListener('keydown', onKeydown)
		dialog!.scrollTop = 0
		dialog!
			.querySelector<HTMLElement>('[data-modal-body]')
			?.scrollTo({ top: 0 })
		dialog!.focus({ preventScroll: true })
		setUrlParam(itemId)
		return true
	}

	function close() {
		if (root.classList.contains('hidden')) return
		root.classList.add('hidden')
		releaseTrap?.()
		releaseTrap = null
		releaseScroll?.()
		releaseScroll = null
		document.removeEventListener('keydown', onKeydown)
		setUrlParam(null)
		const target = opener
		item = null
		opener = null
		if (target && target.isConnected) target.focus({ preventScroll: true })
	}

	closeBtn?.addEventListener('click', close)
	root.addEventListener('click', (event) => {
		if (event.target === root) close()
	})
	qtyMinus?.addEventListener('click', () => {
		if (quantity <= 1) return
		quantity -= 1
		updateQuantity()
	})
	qtyPlus?.addEventListener('click', () => {
		if (cap.max !== null && quantity >= cap.max) return
		quantity += 1
		updateQuantity()
	})
	addBtn.addEventListener('click', handleAdd)

	return {
		open,
		close,
		isOpen: () => !root.classList.contains('hidden'),
		openFromUrl() {
			if (!syncUrl) return false
			const id = new URL(window.location.href).searchParams.get('item')
			return id ? open(id, null) : false
		},
	}
}
