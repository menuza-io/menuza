import { type ReservationsApi } from './api.ts'
import { reservationErrorKey } from './errors.ts'
import { clearStoredManageToken } from './fragment.ts'
import { type ReservationLabels } from './labels.ts'
import {
	addDaysIso,
	formatClock,
	formatDateLong,
	todayIn,
	zoneNote,
} from './time.ts'
import {
	type Availability,
	type ManageView,
	type ReservationLocation,
} from './types.ts'
import {
	bannerErrorClass,
	bannerInfoClass,
	cardClass,
	chipClass,
	downloadBlob,
	formatInstant,
	guestsLabel,
	inputClass,
	labelClass,
	primaryButtonClass,
	secondaryButtonClass,
	statusLabel,
} from './ui.ts'
import { el } from '~/lib/ordering/dom'
import { fillTemplate } from '~/lib/ordering/money'

export type ManageDeps = {
	api: ReservationsApi
	labels: ReservationLabels
	locale: string
	token: string | null
	bookHref: string
}

const LATE_CHOICES = [5, 10, 15, 20, 30]
const LIVE = new Set(['booked', 'confirmed', 'requested', 'pending_payment'])

export async function initManagePage(root: HTMLElement, deps: ManageDeps) {
	const { api, labels, locale } = deps
	const token = deps.token
	root.replaceChildren()

	const statusBox = el('div')
	statusBox.setAttribute('aria-live', 'polite')
	const card = el('section', cardClass)
	card.setAttribute('aria-labelledby', 'rsv-manage-heading')
	root.append(statusBox, card)

	function say(text: string | null, kind: 'error' | 'info' = 'info') {
		statusBox.replaceChildren()
		if (!text) return
		const note = el(
			'p',
			kind === 'error' ? bannerErrorClass : bannerInfoClass,
			text,
		)
		if (kind === 'error') note.setAttribute('role', 'alert')
		statusBox.append(note)
	}

	function bookAgain() {
		const link = el('a', secondaryButtonClass, labels.bookAnother)
		link.href = deps.bookHref
		return link
	}

	if (!token) {
		card.append(
			heading(labels.manageTitle),
			el('p', 'text-sm text-muted-foreground', labels.manageNoToken),
			bookAgain(),
		)
		return
	}

	let view: ManageView
	try {
		view = await api.manage.view(token)
	} catch (error) {
		const key = reservationErrorKey(error)
		if (key === 'errorNotFound') clearStoredManageToken()
		card.append(
			heading(labels.manageTitle),
			el('p', 'text-sm text-muted-foreground', labels[key]),
			bookAgain(),
		)
		return
	}

	let locations: ReservationLocation[] | null = null
	async function locationFor(id: string) {
		if (!locations) locations = (await api.config(locale)).locations
		return locations.find((item) => item.id === id) ?? locations[0] ?? null
	}

	function heading(text: string) {
		const h = el('h2', 'text-xl font-semibold text-foreground', text)
		h.id = 'rsv-manage-heading'
		return h
	}

	function render(next: ManageView, options: { focus?: boolean } = {}) {
		view = next
		const r = view.reservation
		card.replaceChildren()
		const h = heading(labels.manageTitle)
		const badge = el(
			'p',
			'inline-flex w-fit rounded-full border border-border bg-muted/40 px-3 py-1 text-sm font-medium text-foreground',
			statusLabel(labels, view.status),
		)
		badge.dataset.status = view.status
		card.append(h, badge)
		if (view.firstName) {
			card.append(
				el(
					'p',
					'text-sm text-muted-foreground',
					fillTemplate(labels.manageHello, { name: view.firstName }),
				),
			)
		}

		const rows = el('dl', 'grid gap-3 sm:grid-cols-2')
		const add = (term: string, value: string, ltr = false) => {
			if (!value) return
			const wrap = el('div', 'flex flex-col gap-1')
			wrap.append(
				el('dt', 'text-xs uppercase tracking-wide text-muted-foreground', term),
			)
			const dd = el('dd', 'text-base font-medium text-foreground', value)
			if (ltr) dd.dir = 'ltr'
			dd.className += ' wrap-anywhere'
			wrap.append(dd)
			rows.append(wrap)
		}
		add(labels.confirmationCode, r.confirmationCode, true)
		add(labels.whereLabel, r.location.name ?? r.locationName ?? '')
		add(
			labels.whenLabel,
			`${formatDateLong(r.date, locale)}, ${formatClock(r.localMin, locale)}`,
		)
		add(labels.partyLabel, guestsLabel(labels, r.partySize))
		add(
			labels.contactHeading,
			[view.contact.phone, view.contact.email].filter(Boolean).join(' · '),
			true,
		)
		if (r.occasion) add(labels.occasionLabel, r.occasion.name)
		if (r.requests) add(labels.requestsLabel, r.requests)
		if (r.dietary) add(labels.dietaryLabel, r.dietary)
		card.append(rows)

		const zone = zoneNote(r.timeZone)
		if (zone)
			card.append(
				el(
					'p',
					'text-sm text-muted-foreground',
					fillTemplate(labels.restaurantZone, { zone }),
				),
			)
		if (r.runningLateMin) {
			card.append(
				el(
					'p',
					'text-sm text-foreground',
					fillTemplate(labels.lateStatus, { count: r.runningLateMin }),
				),
			)
		}

		const live = LIVE.has(view.status)
		if (view.status === 'cancelled') {
			card.append(
				el('p', 'text-sm font-medium text-foreground', labels.cancelledBody),
				bookAgain(),
			)
		}
		if (live && view.cancelDeadline && view.canCancel) {
			card.append(
				el(
					'p',
					'text-sm text-muted-foreground',
					fillTemplate(labels.cancelDeadline, {
						time: formatInstant(view.cancelDeadline, r.timeZone, locale),
					}),
				),
			)
		}

		if (live) {
			const actions = el('div', 'flex flex-wrap gap-3')
			const panel = el('div', 'flex flex-col gap-4')
			panel.hidden = true
			if (view.canModify) {
				const button = el('button', primaryButtonClass, labels.modifyOpen)
				button.type = 'button'
				button.dataset.action = 'modify'
				button.addEventListener('click', () => {
					panel.hidden = false
					void openModify(panel)
				})
				actions.append(button)
			}
			if (view.status === 'booked') {
				const button = el(
					'button',
					secondaryButtonClass,
					labels.confirmAttendance,
				)
				button.type = 'button'
				button.dataset.action = 'confirm'
				button.addEventListener('click', () => {
					void run(button, async () => {
						render(await api.manage.confirm(token!))
						say(labels.attendanceConfirmed)
					})
				})
				actions.append(button)
			}
			const ics = el('button', secondaryButtonClass, labels.addToCalendar)
			ics.type = 'button'
			ics.addEventListener('click', () => {
				void run(ics, async () => {
					downloadBlob(
						await api.manage.ics(token!),
						`reservation-${r.confirmationCode}.ics`,
					)
				})
			})
			actions.append(ics)
			if (view.canCancel) {
				const button = el('button', secondaryButtonClass, labels.cancelOpen)
				button.type = 'button'
				button.dataset.action = 'cancel'
				button.addEventListener('click', () => {
					panel.hidden = false
					openCancel(panel)
				})
				actions.append(button)
			}
			card.append(actions, panel)
			if (
				todayIn(r.timeZone, Date.parse(view.now) || Date.now()) === r.date &&
				view.status !== 'requested'
			) {
				card.append(lateControl())
			}
		}
		if (options.focus) {
			h.tabIndex = -1
			h.focus()
		}
	}

	function lateControl() {
		const wrap = el('div', 'flex flex-wrap items-end gap-3')
		const field = el('div', 'flex flex-col gap-2')
		const label = el('label', labelClass, labels.runningLate)
		label.htmlFor = 'rsv-late'
		const select = el('select', inputClass)
		select.id = 'rsv-late'
		for (const minutes of LATE_CHOICES) {
			const option = el(
				'option',
				undefined,
				fillTemplate(labels.lateMinutes, { count: minutes }),
			)
			option.value = String(minutes)
			select.append(option)
		}
		field.append(label, select)
		const send = el('button', secondaryButtonClass, labels.runningLate)
		send.type = 'button'
		send.dataset.action = 'late'
		send.addEventListener('click', () => {
			void run(send, async () => {
				render(await api.manage.runningLate(token!, Number(select.value)))
				say(labels.lateSent)
			})
		})
		wrap.append(field, send)
		return wrap
	}

	function openCancel(panel: HTMLElement) {
		panel.replaceChildren()
		const title = el(
			'p',
			'font-medium text-foreground',
			labels.cancelConfirmTitle,
		)
		const row = el('div', 'flex flex-wrap gap-3')
		const yes = el('button', primaryButtonClass, labels.cancelConfirmYes)
		yes.type = 'button'
		yes.dataset.action = 'cancel-confirm'
		yes.addEventListener('click', () => {
			void run(yes, async () => {
				render(await api.manage.cancel(token!), { focus: true })
				say(labels.cancelledBody)
			})
		})
		const keep = el('button', secondaryButtonClass, labels.cancelKeep)
		keep.type = 'button'
		keep.addEventListener('click', () => {
			panel.hidden = true
			panel.replaceChildren()
		})
		row.append(yes, keep)
		panel.append(title, row)
		yes.focus()
	}

	async function openModify(panel: HTMLElement) {
		panel.replaceChildren(
			el('p', 'text-sm text-muted-foreground', labels.loading),
		)
		const r = view.reservation
		let place: ReservationLocation | null = null
		try {
			place = await locationFor(r.locationId)
		} catch (error) {
			say(labels[reservationErrorKey(error)], 'error')
		}
		const serverNow = Date.parse(view.now) || Date.now()
		const today = todayIn(r.timeZone, serverNow)
		const min = place?.partySize.min ?? 1
		const max = Math.max(place?.partySize.max ?? r.partySize, r.partySize)

		const title = el('p', 'font-medium text-foreground', labels.modifyPickTime)
		const controls = el('div', 'grid gap-4 sm:grid-cols-3')
		const dateInput = el('input', inputClass)
		dateInput.type = 'date'
		dateInput.id = 'rsv-modify-date'
		dateInput.min = today
		dateInput.max = addDaysIso(today, place?.horizonDays ?? 60)
		dateInput.value = r.date
		const party = el('select', inputClass)
		party.id = 'rsv-modify-party'
		for (let size = min; size <= max; size++) {
			const option = el('option', undefined, guestsLabel(labels, size))
			option.value = String(size)
			party.append(option)
		}
		party.value = String(r.partySize)
		const wrapField = (id: string, text: string, control: HTMLElement) => {
			const wrap = el('div', 'flex flex-col gap-2')
			const label = el('label', labelClass, text)
			label.htmlFor = id
			wrap.append(label, control)
			return wrap
		}
		const find = el('button', secondaryButtonClass, labels.findButton)
		find.type = 'button'
		const findWrap = el('div', 'flex items-end')
		findWrap.append(find)
		controls.append(
			wrapField('rsv-modify-date', labels.fieldDate, dateInput),
			wrapField('rsv-modify-party', labels.fieldParty, party),
			findWrap,
		)
		const chips = el('div', 'flex flex-wrap gap-2')
		chips.setAttribute('role', 'group')
		chips.setAttribute('aria-label', labels.modifyPickTime)
		const save = el('button', primaryButtonClass, labels.modifySave)
		save.type = 'button'
		save.dataset.action = 'modify-save'
		save.disabled = true
		const cancel = el('button', secondaryButtonClass, labels.cancelKeep)
		cancel.type = 'button'
		cancel.addEventListener('click', () => {
			panel.hidden = true
			panel.replaceChildren()
		})
		const row = el('div', 'flex flex-wrap gap-3')
		row.append(save, cancel)
		panel.replaceChildren(title, controls, chips, row)

		let chosen: number | null = null
		function renderChips(result: Availability) {
			chips.replaceChildren()
			chosen = null
			save.disabled = true
			if (result.slots.length === 0) {
				chips.append(
					el('p', 'text-sm text-muted-foreground', labels.noSlotsTitle),
				)
				return
			}
			for (const slot of result.slots) {
				const chip = el('button', chipClass, formatClock(slot.localMin, locale))
				chip.type = 'button'
				chip.dataset.localMin = String(slot.localMin)
				chip.setAttribute('aria-pressed', 'false')
				chip.addEventListener('click', () => {
					for (const other of chips.querySelectorAll('button'))
						other.setAttribute('aria-pressed', 'false')
					chip.setAttribute('aria-pressed', 'true')
					chosen = slot.localMin
					save.disabled = false
				})
				chips.append(chip)
			}
		}
		find.addEventListener('click', () => {
			void run(find, async () => {
				renderChips(
					await api.manage.availability(token!, {
						date: dateInput.value,
						partySize: Number(party.value),
					}),
				)
			})
		})
		save.addEventListener('click', () => {
			if (chosen === null) return
			const localMin = chosen
			void run(save, async () => {
				render(
					await api.manage.modify(token!, {
						date: dateInput.value,
						localMin,
						partySize: Number(party.value),
					}),
					{ focus: true },
				)
				say(labels.modifySaved)
			})
		})
		find.click()
	}

	async function run(button: HTMLButtonElement, action: () => Promise<void>) {
		button.disabled = true
		say(null)
		try {
			await action()
		} catch (error) {
			say(labels[reservationErrorKey(error)], 'error')
		} finally {
			if (button.isConnected) button.disabled = false
		}
	}

	render(view)
}
