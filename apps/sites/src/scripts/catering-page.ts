import {
	cateringDateIn,
	cateringDateStatus,
	cateringEventInstantMs,
	formatCateringMoney,
	type CateringSettings,
} from '@repo/common/catering'
import {
	CateringClientError,
	fetchOptions,
	placeOrder,
	requestQuote,
	startPayment,
	type CateringOptions,
} from '~/lib/catering/client'
import {
	fillCateringTemplate,
	readCateringLabels,
} from '~/lib/catering/read-labels'
import { browserLocale } from '~/lib/locale'
import { createChallenge } from '~/lib/reservations/ui'

/**
 * The catering page (#124, #255, #361): the catering dishes with their choices,
 * the event date and time (with the order-by moment next to a date a cutoff
 * covers, and the cutoff message once it has passed), the head count and the
 * guest's details, then pay now (deposit first when the location asks for one)
 * or request a quote. The region checks every rule again.
 */

type Group = {
	id: string
	name: string
	min: number
	max: number | null
	single: boolean
	options: Array<{ id: string; name: string; priceCents: number }>
}
type Item = {
	id: string
	category: string
	name: string
	description: string
	priceCents: number
	variants: Array<{ id: string; label: string; priceCents: number }>
	groups: Group[]
	unsupported: boolean
}
type Config = {
	locationId: string
	locations: Array<{ id: string; name: string }>
	timeZone: string
	currency: string
	quotes: boolean
	quoteRequired: boolean
	settings: {
		noticeHours: number
		maxDaysAhead: number
		fulfillments: { pickup: boolean; delivery: boolean }
		depositPercent: number
		cutoffs: CateringSettings['cutoffs']
		maxGuests: number | null
	}
	items: Item[]
}

const root = document.getElementById('catering-root')
const labels = readCateringLabels()
let config: Config | null = null
try {
	config = JSON.parse(
		document.getElementById('catering-config')?.textContent || 'null',
	) as Config | null
} catch {
	config = null
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = '',
	text = '',
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag)
	if (className) node.className = className
	if (text) node.textContent = text
	return node
}

const INPUT =
	'h-11 w-full rounded-md border border-input bg-background px-3 text-base'

function field(label: string, input: HTMLElement, id: string): HTMLElement {
	const wrap = el('div', 'flex flex-col gap-1')
	const l = el('label', 'text-sm font-medium', label)
	l.htmlFor = id
	input.id = id
	wrap.append(l, input)
	return wrap
}

const ERROR_LABELS: Record<string, keyof typeof labels> = {
	catering_too_soon: 'errTooSoon',
	catering_too_far: 'errTooFar',
	catering_closed: 'errClosed',
	catering_cutoff_passed: 'errCutoff',
	catering_minimum: 'errMinimum',
	catering_maximum: 'errMaximum',
	catering_guests: 'errGuestsMax',
	catering_fulfillment: 'errFulfillment',
	verification_failed: 'errVerify',
	unknown_item: 'errSelection',
	required_modifier: 'errSelection',
	modifier_limit: 'errSelection',
	variant_required: 'errSelection',
}

if (root && config) {
	const cfg = config
	const mount = root.querySelector<HTMLElement>('[data-ct-form]')!
	const locale = browserLocale()
	const money = (minor: number) =>
		formatCateringMoney(minor, cfg.currency, locale)
	const form = el('form', 'flex flex-col gap-8')
	form.noValidate = true
	const challenge = createChallenge(
		el('div'),
		root.dataset.turnstileSiteKey ?? '',
	)
	let options: CateringOptions | null = null
	let clockOffset = 0
	const now = () => Date.now() + clockOffset

	// ---- Menu ----------------------------------------------------------
	const quantities = new Map<string, HTMLInputElement>()
	const variantSelects = new Map<string, HTMLSelectElement>()
	const optionInputs = new Map<string, HTMLInputElement[]>()
	const menu = el('section', 'flex flex-col gap-4')
	menu.append(el('h2', 'text-2xl font-semibold', labels.menuHeading))
	let currentCategory = ''
	const subtotalEl = el('p', 'text-sm font-medium')
	for (const item of cfg.items) {
		if (item.category !== currentCategory) {
			currentCategory = item.category
			if (currentCategory)
				menu.append(el('h3', 'text-lg font-medium', currentCategory))
		}
		const row = el('div', 'flex flex-col gap-2 rounded-md border p-3')
		const head = el('div', 'flex items-baseline justify-between gap-3')
		head.append(
			el('span', 'font-medium', item.name),
			el('span', 'tabular-nums', money(item.priceCents)),
		)
		row.append(head)
		if (item.description)
			row.append(el('p', 'text-sm text-muted-foreground', item.description))
		if (item.unsupported) {
			row.append(el('p', 'text-sm text-muted-foreground', labels.notOnline))
			menu.append(row)
			continue
		}
		const qty = el('input', INPUT + ' max-w-28')
		qty.type = 'number'
		qty.min = '0'
		qty.max = '50'
		qty.value = '0'
		qty.inputMode = 'numeric'
		qty.addEventListener('input', recompute)
		quantities.set(item.id, qty)
		const controls = el('div', 'flex flex-wrap items-end gap-3')
		controls.append(field(labels.quantity, qty, `ct-qty-${item.id}`))
		if (item.variants.length > 0) {
			const select = el('select', INPUT + ' max-w-xs')
			select.append(new Option(labels.chooseOption, ''))
			for (const variant of item.variants) {
				select.append(
					new Option(
						`${variant.label} (${money(variant.priceCents)})`,
						variant.id,
					),
				)
			}
			select.addEventListener('change', recompute)
			variantSelects.set(item.id, select)
			controls.append(
				field(labels.chooseOption, select, `ct-variant-${item.id}`),
			)
		}
		row.append(controls)
		for (const group of item.groups) {
			const set = el('fieldset', 'flex flex-col gap-1')
			const legend = el('legend', 'text-sm font-medium', group.name)
			set.append(legend)
			if (group.max) {
				set.append(
					el(
						'p',
						'text-xs text-muted-foreground',
						fillCateringTemplate(labels.chooseUpTo, { max: String(group.max) }),
					),
				)
			}
			const inputs: HTMLInputElement[] = []
			for (const option of group.options) {
				const label = el('label', 'flex items-center gap-2 text-sm')
				const input = el('input')
				input.type = group.single ? 'radio' : 'checkbox'
				input.name = `ct-group-${item.id}-${group.id}`
				input.value = option.id
				input.dataset.price = String(option.priceCents)
				input.addEventListener('change', recompute)
				inputs.push(input)
				label.append(
					input,
					el(
						'span',
						'',
						option.priceCents > 0
							? `${option.name} (+${money(option.priceCents)})`
							: option.name,
					),
				)
				set.append(label)
			}
			optionInputs.set(`${item.id}:${group.id}`, inputs)
			row.append(set)
		}
		menu.append(row)
	}
	menu.append(subtotalEl)

	function selectedLines(): {
		lines: Array<Record<string, unknown>>
		ok: boolean
	} {
		const lines: Array<Record<string, unknown>> = []
		let ok = true
		for (const item of cfg.items) {
			const qty = quantities.get(item.id)
			const quantity = Math.max(
				0,
				Math.min(50, Math.round(Number(qty?.value || 0))),
			)
			if (!qty || quantity < 1) continue
			const variantId = variantSelects.get(item.id)?.value ?? ''
			if (item.variants.length > 0 && !variantId) ok = false
			const picked: Array<{ groupId: string; optionId: string }> = []
			for (const group of item.groups) {
				const chosen = (
					optionInputs.get(`${item.id}:${group.id}`) ?? []
				).filter((i) => i.checked)
				if (
					chosen.length < group.min ||
					(group.max !== null && chosen.length > group.max)
				)
					ok = false
				for (const input of chosen)
					picked.push({ groupId: group.id, optionId: input.value })
			}
			lines.push({
				itemId: item.id,
				...(variantId ? { variantId } : {}),
				quantity,
				options: picked,
			})
		}
		return { lines, ok }
	}

	function recompute() {
		let total = 0
		for (const item of cfg.items) {
			const quantity = Math.round(Number(quantities.get(item.id)?.value || 0))
			if (!quantity) continue
			const variant = item.variants.find(
				(v) => v.id === variantSelects.get(item.id)?.value,
			)
			let unit = variant ? variant.priceCents : item.priceCents
			for (const input of Array.from(
				root!.querySelectorAll<HTMLInputElement>(
					`input[name^="ct-group-${item.id}-"]:checked`,
				),
			)) {
				unit += Number(input.dataset.price || 0)
			}
			total += unit * quantity
		}
		subtotalEl.textContent = fillCateringTemplate(labels.subtotal, {
			amount: money(total),
		})
		return total
	}

	// ---- Event ---------------------------------------------------------
	const event = el('section', 'flex flex-col gap-3')
	event.append(el('h2', 'text-2xl font-semibold', labels.eventHeading))
	const locationSelect = el('select', INPUT)
	for (const l of cfg.locations)
		locationSelect.append(
			new Option(l.name, l.id, false, l.id === cfg.locationId),
		)
	locationSelect.addEventListener('change', () => {
		const url = new URL(location.href)
		url.searchParams.set('location', locationSelect.value)
		location.assign(url.toString())
	})
	if (cfg.locations.length > 1)
		event.append(field(labels.location, locationSelect, 'ct-location'))
	const dateInput = el('input', INPUT)
	dateInput.type = 'date'
	const timeInput = el('input', INPUT)
	timeInput.type = 'time'
	timeInput.step = '900'
	timeInput.value = '12:00'
	const dateNote = el('p', 'text-sm text-muted-foreground')
	dateNote.setAttribute('aria-live', 'polite')
	const guestsInput = el('input', INPUT)
	guestsInput.type = 'number'
	guestsInput.min = '1'
	guestsInput.inputMode = 'numeric'
	if (cfg.settings.maxGuests) guestsInput.max = String(cfg.settings.maxGuests)
	const notesInput = el('textarea', INPUT + ' h-24 py-2')
	notesInput.maxLength = 500
	const fulfillmentSelect = el('select', INPUT)
	if (cfg.settings.fulfillments.pickup)
		fulfillmentSelect.append(new Option(labels.pickup, 'pickup'))
	// Delivery is priced by the restaurant, so it goes through a quote.
	if (cfg.settings.fulfillments.delivery && cfg.quotes)
		fulfillmentSelect.append(new Option(labels.delivery, 'delivery'))
	const addressInput = el('input', INPUT)
	const cityInput = el('input', INPUT)
	const addressBox = el('div', 'flex flex-col gap-3')
	addressBox.hidden = true
	addressBox.append(
		field(labels.deliveryAddress, addressInput, 'ct-address'),
		field(labels.deliveryCity, cityInput, 'ct-city'),
	)
	fulfillmentSelect.addEventListener('change', syncButtons)
	const earliestDate = () =>
		cateringDateIn(now() + cfg.settings.noticeHours * 3_600_000, cfg.timeZone)
	dateInput.min = earliestDate()
	dateInput.max = cateringDateIn(now(), cfg.timeZone, cfg.settings.maxDaysAhead)
	event.append(
		field(labels.eventDate, dateInput, 'ct-date'),
		dateNote,
		field(labels.eventTime, timeInput, 'ct-time'),
		field(labels.guests, guestsInput, 'ct-guests'),
	)
	if (fulfillmentSelect.options.length > 1)
		event.append(
			field(labels.pickupOrDelivery, fulfillmentSelect, 'ct-fulfillment'),
			addressBox,
		)
	event.append(field(labels.notes, notesInput, 'ct-notes'))

	const when = (ms: number) =>
		new Intl.DateTimeFormat(locale, {
			dateStyle: 'medium',
			timeStyle: 'short',
			timeZone: cfg.timeZone,
		}).format(new Date(ms))
	const day = (date: string) =>
		new Intl.DateTimeFormat(locale, {
			dateStyle: 'medium',
			timeZone: 'UTC',
		}).format(new Date(`${date}T12:00:00Z`))

	/** The order-by moment for the chosen date, or the cutoff message once it has passed. Returns false when the date is closed. */
	function checkDate(): boolean {
		dateNote.textContent = fillCateringTemplate(labels.earliest, {
			date: day(earliestDate()),
		})
		if (!dateInput.value) return true
		const result = cateringDateStatus(
			{ cutoffs: cfg.settings.cutoffs },
			now(),
			dateInput.value,
			cfg.timeZone,
		)
		if (!result.orderable) {
			const c = result.cutoff
			const text =
				c.from === c.to
					? fillCateringTemplate(labels.cutoffClosedDay, {
							from: day(c.from),
							when: when(c.orderByAtMs),
						})
					: fillCateringTemplate(labels.cutoffClosed, {
							from: day(c.from),
							to: day(c.to),
							when: when(c.orderByAtMs),
						})
			dateNote.textContent = [text, c.note ? localizedNote(c.note) : '']
				.filter(Boolean)
				.join(' ')
			return false
		}
		if (result.orderBy) {
			dateNote.textContent = fillCateringTemplate(labels.orderBy, {
				when: when(result.orderBy.orderByAtMs),
			})
		}
		return true
	}
	function localizedNote(note: unknown): string {
		const map = note as Record<string, string> | null
		if (!map) return ''
		const base = locale.split('-')[0]!
		return map[locale] || map[base] || Object.values(map).find(Boolean) || ''
	}
	dateInput.addEventListener('input', () => {
		checkDate()
		showError('')
	})

	// ---- Guest ---------------------------------------------------------
	const guest = el('section', 'flex flex-col gap-3')
	guest.append(el('h2', 'text-2xl font-semibold', labels.yourDetails))
	const nameInput = el('input', INPUT)
	nameInput.autocomplete = 'name'
	const phoneInput = el('input', INPUT)
	phoneInput.type = 'tel'
	phoneInput.autocomplete = 'tel'
	const emailInput = el('input', INPUT)
	emailInput.type = 'email'
	emailInput.autocomplete = 'email'
	guest.append(
		field(labels.name, nameInput, 'ct-name'),
		field(labels.phone, phoneInput, 'ct-phone'),
		field(labels.email, emailInput, 'ct-email'),
	)

	// ---- Actions ---------------------------------------------------------
	const actions = el('div', 'flex flex-col gap-3')
	const BTN = 'h-12 rounded-md px-6 text-base font-medium '
	const payButton = el('button', BTN + 'bg-primary text-primary-foreground')
	payButton.type = 'button'
	payButton.textContent =
		cfg.settings.depositPercent > 0 && cfg.settings.depositPercent < 100
			? labels.payDeposit
			: labels.payNow
	const quoteButton = el('button', BTN + 'border border-input bg-background')
	quoteButton.type = 'button'
	quoteButton.textContent = labels.requestQuote
	const depositNote = el('p', 'text-sm text-muted-foreground')
	if (cfg.settings.depositPercent > 0 && cfg.settings.depositPercent < 100) {
		depositNote.textContent = fillCateringTemplate(labels.depositNote, {
			percent: String(cfg.settings.depositPercent),
		})
	}
	const errorEl = el('p', 'text-sm text-destructive')
	errorEl.setAttribute('role', 'alert')
	const doneEl = el('p', 'text-base font-medium')
	doneEl.setAttribute('role', 'status')
	doneEl.hidden = true
	if (!cfg.quoteRequired) actions.append(depositNote, payButton)
	if (cfg.quotes) actions.append(quoteButton)
	actions.append(errorEl, doneEl)

	function syncButtons() {
		const delivery = fulfillmentSelect.value === 'delivery'
		addressBox.hidden = !delivery
		payButton.hidden = delivery
	}
	function showError(text: string) {
		errorEl.textContent = text
	}
	function errorFor(caught: unknown): string {
		if (caught instanceof CateringClientError) {
			const key = ERROR_LABELS[caught.code]
			if (key) return labels[key] as string
		}
		return labels.errGeneric
	}

	function collect(forQuote: boolean): Record<string, unknown> | string {
		const { lines, ok } = selectedLines()
		if (lines.length === 0) return labels.errChooseDishes
		if (!ok) return labels.errSelection
		if (!dateInput.value || !timeInput.value) return labels.errChooseDate
		if (!checkDate()) return labels.errCutoff
		const at = cateringEventInstantMs(
			dateInput.value,
			timeInput.value,
			cfg.timeZone,
		)
		if (at === null) return labels.errChooseDate
		const guests = Math.round(Number(guestsInput.value))
		if (!guests || guests < 1) return labels.errGuests
		if (
			!nameInput.value.trim() ||
			!phoneInput.value.trim() ||
			!emailInput.value.trim()
		)
			return labels.errDetails
		const contact = {
			name: nameInput.value.trim(),
			phone: phoneInput.value.trim(),
			email: emailInput.value.trim(),
		}
		const idempotencyKey = crypto.randomUUID()
		const notes = notesInput.value.trim()
		const base = { idempotencyKey, locale, locationId: cfg.locationId, contact }
		if (forQuote) {
			const delivery = fulfillmentSelect.value === 'delivery'
			return {
				...base,
				fulfillment: delivery ? 'delivery' : 'pickup',
				eventAt: new Date(at).toISOString(),
				guestCount: guests,
				...(notes ? { notes } : {}),
				...(delivery
					? {
							delivery: {
								address: addressInput.value.trim(),
								city: cityInput.value.trim(),
							},
						}
					: {}),
				lines: lines.map(({ options, ...rest }) => ({ ...rest, options })),
			}
		}
		return {
			...base,
			fulfillment: 'pickup',
			paymentMethod: 'online',
			scheduledFor: new Date(at).toISOString(),
			guestCount: guests,
			catering: notes ? { notes } : {},
			lines,
		}
	}

	async function run(button: HTMLButtonElement, task: () => Promise<void>) {
		showError('')
		button.disabled = true
		const text = button.textContent
		button.textContent = labels.working
		try {
			await task()
		} catch (caught) {
			showError(errorFor(caught))
		} finally {
			button.disabled = false
			button.textContent = text
		}
	}

	payButton.addEventListener('click', () => {
		const body = collect(false)
		if (typeof body === 'string') return showError(body)
		void run(payButton, async () => {
			const placed = await placeOrder(body)
			location.assign(
				await startPayment(placed.orderId, placed.paymentToken, locale),
			)
		})
	})
	quoteButton.addEventListener('click', () => {
		const body = collect(true)
		if (typeof body === 'string') return showError(body)
		void run(quoteButton, async () => {
			const token = challenge.token()
			await requestQuote({
				...body,
				...(token ? { turnstileToken: token } : {}),
			})
			challenge.reset()
			doneEl.textContent = labels.requestSent
			doneEl.hidden = false
			actions.querySelectorAll('button').forEach((b) => (b.hidden = true))
		})
	})

	form.append(menu, event, guest, actions)
	form.addEventListener('submit', (e) => e.preventDefault())
	mount.replaceChildren(form)
	syncButtons()
	checkDate()
	recompute()

	// The live clock, and the cutoffs as the region reads them now.
	void fetchOptions(cfg.locationId, locale).then((found) => {
		if (!found) return
		options = found
		clockOffset = found.serverNow - Date.now()
		dateInput.min = earliestDate()
		checkDate()
	})
	void options
}
