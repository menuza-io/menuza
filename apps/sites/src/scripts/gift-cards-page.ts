import { type GiftCardOptions } from '@repo/common/gift-card-contract'
import { type GiftCardDesignKey } from '@repo/common/gift-cards'
import {
	fetchOptions,
	GiftCardClientError,
	purchase,
	startPayment,
} from '~/lib/gift-cards/client'
import { fillGiftCardTemplate, readGiftCardLabels } from '~/lib/gift-cards/read-labels'
import { browserLocale } from '~/lib/locale'
import { createChallenge } from '~/lib/reservations/ui'

/**
 * The buy page: presets and a custom amount, a design, To or Send to myself,
 * From, a note and Deliver now or later in the location's time zone. The
 * total is shown before paying (a processing fee, when the restaurant passes
 * one on, is its own line and never part of the card). Nothing about the
 * buyer or recipient leaves the browser except to the regional tenant-api.
 */

const root = document.getElementById('gift-card-buy-root')
const labels = readGiftCardLabels()

function money(minor: number, currency: string): string {
	return new Intl.NumberFormat(browserLocale(), { style: 'currency', currency }).format(minor / 100)
}

/** A wall-clock date and time in `timeZone` as epoch milliseconds. */
export function zonedTimeToEpoch(date: string, time: string, timeZone: string | null): number {
	const naive = Date.parse(`${date}T${time}:00Z`)
	if (!Number.isFinite(naive) || !timeZone) return Date.parse(`${date}T${time}:00`)
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		}).formatToParts(new Date(naive))
		const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
		const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
		return naive - (asUtc - naive)
	} catch {
		return Date.parse(`${date}T${time}:00`)
	}
}

const DESIGN_LABEL: Record<GiftCardDesignKey, keyof typeof labels> = {
	classic: 'designClassic',
	birthday: 'designBirthday',
	holidays: 'designHolidays',
	thank_you: 'designThankYou',
	eid: 'designEid',
	ramadan: 'designRamadan',
	national_day: 'designNationalDay',
	custom: 'designCustom',
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag)
	for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
	if (text !== undefined) node.textContent = text
	return node
}

function field(labelText: string, input: HTMLElement, id: string): HTMLElement {
	const wrap = el('div', { class: 'flex flex-col gap-1' })
	wrap.append(el('label', { for: id, class: 'text-sm font-medium' }, labelText), input)
	return wrap
}

const INPUT = 'h-11 w-full rounded-md border border-input bg-background px-3 text-base'

async function init(host: HTMLElement) {
	const params = new URLSearchParams(window.location.search)
	const status = host.querySelector<HTMLElement>('[data-gc-status]')!
	if (params.get('paid')) {
		status.textContent = labels.returning
		return
	}
	if (params.get('cancelled')) status.textContent = labels.cancelled
	const options = await fetchOptions()
	if (!options?.enabled || !options.currency) {
		status.textContent = labels.unavailable
		return
	}
	render(host, status, options)
}

function render(host: HTMLElement, status: HTMLElement, options: GiftCardOptions) {
	const currency = options.currency!
	const form = el('form', { class: 'flex flex-col gap-5', novalidate: '' })
	const challengeHost = el('div')
	const challenge = createChallenge(challengeHost, host.dataset.turnstileSiteKey ?? '')

	// Amount
	let amountMinor = options.presetsMinor[0] ?? options.minAmountMinor
	const amountGroup = el('div', { class: 'flex flex-wrap gap-2', role: 'group', 'aria-label': labels.amount })
	const custom = el('input', { id: 'gc-custom', class: INPUT, inputmode: 'decimal', autocomplete: 'off' })
	const buttons = options.presetsMinor.map((preset) => {
		const button = el('button', { type: 'button', class: 'h-11 rounded-md border border-input px-4 text-base' }, money(preset, currency))
		button.addEventListener('click', () => {
			amountMinor = preset
			custom.value = ''
			refresh()
		})
		return { button, preset }
	})
	amountGroup.append(...buttons.map((entry) => entry.button))
	custom.addEventListener('input', () => {
		const typed = Number(custom.value.replace(/,/g, '.'))
		amountMinor = Number.isFinite(typed) ? Math.round(typed * 100) : 0
		refresh()
	})
	form.append(amountGroup)
	if (options.allowCustomAmount) form.append(field(labels.customAmount, custom, 'gc-custom'))

	// Design
	let designKey: GiftCardDesignKey = options.defaultDesign
	if (options.designs.length > 1) {
		const select = el('select', { id: 'gc-design', class: INPUT })
		for (const design of options.designs) {
			select.append(el('option', { value: design.key }, labels[DESIGN_LABEL[design.key]] as string))
		}
		select.value = designKey
		select.addEventListener('change', () => {
			designKey = select.value as GiftCardDesignKey
		})
		form.append(field(labels.design, select, 'gc-design'))
	}
	const query = new URLSearchParams(window.location.search).get('design')
	if (query && options.designs.some((design) => design.key === query)) {
		designKey = query as GiftCardDesignKey
		const select = form.querySelector<HTMLSelectElement>('#gc-design')
		if (select) select.value = designKey
	}

	// Who it is for
	const self = el('input', { id: 'gc-self', type: 'checkbox' })
	const selfLabel = el('label', { class: 'flex items-center gap-2 text-sm', for: 'gc-self' })
	selfLabel.append(self, document.createTextNode(labels.sendToMyself))
	const recipientName = el('input', { id: 'gc-to-name', class: INPUT, autocomplete: 'off' })
	const recipientEmail = el('input', { id: 'gc-to-email', class: INPUT, type: 'email', autocomplete: 'off' })
	const recipientBox = el('div', { class: 'flex flex-col gap-3' })
	recipientBox.append(field(labels.recipientName, recipientName, 'gc-to-name'), field(labels.recipientEmail, recipientEmail, 'gc-to-email'))
	self.addEventListener('change', () => {
		recipientBox.hidden = self.checked
	})
	form.append(selfLabel, recipientBox)

	const fromName = el('input', { id: 'gc-from', class: INPUT, autocomplete: 'name' })
	const message = el('textarea', { id: 'gc-message', class: `${INPUT} h-24 py-2`, maxlength: '500' })
	form.append(field(labels.fromName, fromName, 'gc-from'), field(labels.message, message, 'gc-message'))

	// Delivery
	const later = el('input', { id: 'gc-later', type: 'checkbox' })
	const laterLabel = el('label', { class: 'flex items-center gap-2 text-sm', for: 'gc-later' })
	laterLabel.append(later, document.createTextNode(labels.deliverLater))
	const date = el('input', { id: 'gc-date', class: INPUT, type: 'date' })
	const time = el('input', { id: 'gc-time', class: INPUT, type: 'time', value: '09:00' })
	const laterBox = el('div', { class: 'grid grid-cols-2 gap-3' })
	laterBox.hidden = true
	laterBox.append(field(labels.deliverDate, date, 'gc-date'), field(labels.deliverTime, time, 'gc-time'))
	later.addEventListener('change', () => {
		laterBox.hidden = !later.checked
	})
	form.append(laterLabel, laterBox)

	let locationId: string | null = null
	if (options.locations.length > 1) {
		const select = el('select', { id: 'gc-location', class: INPUT })
		select.append(el('option', { value: '' }, labels.anyLocation))
		for (const location of options.locations) {
			select.append(el('option', { value: location.id }, location.name ?? location.id))
		}
		select.addEventListener('change', () => {
			locationId = select.value || null
		})
		form.append(field(labels.location, select, 'gc-location'))
	}

	// Buyer
	const buyerName = el('input', { id: 'gc-buyer-name', class: INPUT, autocomplete: 'name' })
	const buyerEmail = el('input', { id: 'gc-buyer-email', class: INPUT, type: 'email', autocomplete: 'email' })
	form.append(field(labels.yourName, buyerName, 'gc-buyer-name'), field(labels.yourEmail, buyerEmail, 'gc-buyer-email'))

	const total = el('p', { class: 'text-lg font-semibold', 'aria-live': 'polite' })
	const error = el('p', { class: 'text-sm text-destructive', role: 'alert' })
	const submit = el('button', { type: 'submit', class: 'h-12 rounded-md bg-primary px-6 text-base font-medium text-primary-foreground' }, labels.payAndSend)
	form.append(total, error, challengeHost, submit)

	function refresh() {
		total.textContent = `${labels.total}: ${amountMinor > 0 ? money(amountMinor, currency) : '—'}`
		for (const { button, preset } of buttons) {
			button.setAttribute('aria-pressed', String(preset === amountMinor && !custom.value))
			button.classList.toggle('bg-primary', preset === amountMinor && !custom.value)
			button.classList.toggle('text-primary-foreground', preset === amountMinor && !custom.value)
		}
	}
	refresh()

	// One key per intent: a double click is one purchase.
	let key = `gc-buy-${crypto.randomUUID()}`
	form.addEventListener('submit', async (event) => {
		event.preventDefault()
		error.textContent = ''
		if (amountMinor < options.minAmountMinor || amountMinor > options.maxAmountMinor) {
			error.textContent = fillGiftCardTemplate(labels.errorAmount, {
				min: money(options.minAmountMinor, currency),
				max: money(options.maxAmountMinor, currency),
			})
			return
		}
		const emailOk = (value: string) => /^\S+@\S+\.\S+$/.test(value.trim())
		if (!emailOk(buyerEmail.value) || (!self.checked && !emailOk(recipientEmail.value))) {
			error.textContent = self.checked || !recipientEmail.value ? labels.errorEmail : labels.errorRecipient
			return
		}
		let deliverAt: number | undefined
		if (later.checked) {
			const zone =
				options.locations.find((entry) => entry.id === locationId)?.timeZone ??
				options.locations[0]?.timeZone ??
				null
			deliverAt = zonedTimeToEpoch(date.value, time.value || '09:00', zone)
			const year = 366 * 24 * 60 * 60_000
			if (!Number.isFinite(deliverAt) || deliverAt < Date.now() || deliverAt > Date.now() + year) {
				error.textContent = labels.errorDeliver
				return
			}
		}
		submit.disabled = true
		status.textContent = labels.processing
		try {
			const started = await purchase(
				{
					amountMinor,
					designKey,
					sendToSelf: self.checked,
					recipient: self.checked
						? null
						: { name: recipientName.value.trim() || undefined, email: recipientEmail.value.trim() },
					senderName: fromName.value.trim() || undefined,
					message: message.value.trim() || undefined,
					deliverAt,
					purchaser: {
						name: buyerName.value.trim() || undefined,
						email: buyerEmail.value.trim(),
					},
					locationId: locationId ?? undefined,
					locale: browserLocale(),
					turnstileToken: challenge.token() ?? undefined,
				},
				key,
			)
			window.location.assign(await startPayment(started.orderRef, started.paymentToken, browserLocale()))
		} catch (caught) {
			submit.disabled = false
			status.textContent = ''
			challenge.reset()
			key = `gc-buy-${crypto.randomUUID()}`
			const code = caught instanceof GiftCardClientError ? caught.code : ''
			error.textContent =
				code === 'purchase_limit'
					? labels.errorLimit
					: code === 'rate_limited'
						? labels.errorRate
						: code === 'verification_failed'
							? labels.errorVerify
							: labels.errorGeneric
		}
	})

	host.querySelector('[data-gc-form]')!.replaceChildren(form)
}

if (root) void init(root)
