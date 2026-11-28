import {
	GROUP_POLL_INTERVAL_MS,
	type GroupLineView,
	type GroupView,
} from '@repo/common/group-orders'
import { getLocalizedMenuValue } from '@repo/common/menu-types'

import { createCartStore } from './cart-store.ts'
import {
	cartFromGroupView,
	groupCartKey,
	saveGroupCheckout,
} from './group-checkout.ts'
import {
	addGroupLine,
	clearGroupSession,
	createGroup,
	endGroup,
	groupShareLink,
	joinGroup,
	leaveGroup,
	loadGroupSession,
	readGroup,
	removeGroupLine,
	saveGroupSession,
	setGroupDone,
	shareTokenFromHash,
	updateGroup,
	type GroupSession,
} from './group-client.ts'
import { fillTemplate } from './money.ts'
import { OrderRequestError, orderLines } from './order-client.ts'
import { type GroupOrderLabels } from '~/lib/ordering-labels'

/**
 * The group order page (#170), for the host and for friends. The region decides
 * everything (who may do what, limits, the deadline, the lock); the page draws
 * the group it is told about, polls it every 5 seconds (no sockets), and sends
 * the person's own token with each call. Every name and dish is put in the page
 * as text, never as markup.
 */

export type GroupPageOptions = {
	root: HTMLElement
	labels: GroupOrderLabels
	orgId: string
	locale: string
	defaultLocale: string
	currency: string
	formatMoney: (amount: number) => string
	locations: Array<{ id: string; name: string }>
	menuHref: string
	checkoutHref: string
	/** The order page (`/menu/success`), for the host's link to the placed order. */
	successHref: string
	/** This page's own path, for the share link. */
	pagePath: string
	signInHref: string
	/** Sends the guest to sign in and back here. */
	signInAndReturn: () => void
	isSignedIn: () => boolean
	defaultLocationId: string
}

/** The text for a refusal of the region, by its code. */
export function groupErrorText(
	labels: GroupOrderLabels,
	error: unknown,
): string {
	if (!(error instanceof OrderRequestError)) return labels.failed
	if (error.status === 429 && error.code === 'rate_limit_exceeded') {
		return labels.limited
	}
	switch (error.code) {
		case 'group_disabled':
			return labels.disabled
		case 'group_limit_reached':
			return labels.limitReached
		case 'group_full':
			return labels.full
		case 'group_lines_full':
			return labels.linesFull
		case 'group_host_limit':
			return labels.hostLimit
		case 'group_deadline_too_soon':
			return labels.deadlineTooSoon
		case 'group_deadline_too_far':
			return labels.deadlineTooFar
		case 'group_locked':
			return labels.locked
		case 'group_deadline_passed':
			return labels.pastDeadline
		case 'group_already_ordered':
			return labels.ordered
		case 'invalid_line':
			return labels.invalidLine
		case 'group_changed':
			return labels.changed
		case 'forbidden':
			return labels.forbidden
		case 'group_not_found':
			return labels.gone
		default:
			return labels.failed
	}
}

/** Money typed as "12.50" (major units) to minor units; null when it is not a plain amount. */
export function parseAmountMinor(text: string): number | null {
	const trimmed = text.trim()
	if (!trimmed) return null
	if (!/^\d{1,7}(\.\d{1,2})?$/.test(trimmed)) return null
	const minor = Math.round(Number(trimmed) * 100)
	return minor >= 1 ? minor : null
}

/** "From now: at least 15 minutes": a `datetime-local` value as an ISO instant, or null. */
export function deadlineIso(value: string): string | null {
	if (!value) return null
	const ms = new Date(value).getTime()
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag)
	if (className) node.className = className
	if (text !== undefined) node.textContent = text
	return node
}

function field(label: string, input: HTMLElement, hint?: string) {
	const wrap = el('div', 'space-y-1')
	const text = el('label', 'text-sm font-medium text-foreground', label)
	if (input.id) (text as HTMLLabelElement).htmlFor = input.id
	wrap.append(text, input)
	if (hint) wrap.appendChild(el('p', 'text-xs text-muted-foreground', hint))
	return wrap
}

export function mountGroupPage(options: GroupPageOptions) {
	const { root, labels } = options
	let session: GroupSession | null = loadGroupSession(options.orgId)
	let view: GroupView | null = null
	let timer: number | null = null
	let notice = ''
	let busy = false
	/** Set once for a friend who opened a link: the token to join with. */
	const linkToken = shareTokenFromHash(window.location.hash)
	const linkGroupId = new URLSearchParams(window.location.search).get('g')
	let joinPreview: GroupView | null = null
	let gone = false

	const localize = (value: string) =>
		getLocalizedMenuValue(value, options.locale, options.defaultLocale)

	function stopPolling() {
		if (timer !== null) window.clearInterval(timer)
		timer = null
	}
	function startPolling() {
		stopPolling()
		timer = window.setInterval(() => {
			if (document.visibilityState === 'visible' && !busy) void refresh()
		}, GROUP_POLL_INTERVAL_MS)
	}

	async function refresh() {
		if (!session) return
		try {
			view = await readGroup(session.groupId, session.personToken)
			gone = false
			draw()
		} catch (error) {
			if (error instanceof OrderRequestError && error.status === 404) {
				// The group ended, was purged, or this person left: forget it.
				clearGroupSession(options.orgId)
				session = null
				view = null
				gone = true
				stopPolling()
				draw()
			}
			// Anything else: keep what is shown and try again at the next poll.
		}
	}

	async function act<T>(run: () => Promise<T>): Promise<T | null> {
		if (busy) return null
		busy = true
		notice = ''
		try {
			return await run()
		} catch (error) {
			notice = groupErrorText(labels, error)
			if (
				error instanceof OrderRequestError &&
				error.code === 'group_not_found'
			) {
				clearGroupSession(options.orgId)
				session = null
				view = null
				gone = true
				stopPolling()
			}
			draw()
			return null
		} finally {
			busy = false
		}
	}

	function setView(next: GroupView | null) {
		if (next) view = next
		draw()
	}

	// ----- Not in a group: start one, or join the one the link names -----

	function drawStart(): HTMLElement {
		const form = el('form', 'surface space-y-4 p-5 text-start sm:p-6')
		form.noValidate = true
		form.dataset.groupStart = ''
		form.appendChild(
			el('h2', 'text-lg font-semibold text-foreground', labels.startHeading),
		)
		form.appendChild(el('p', 'text-sm text-foreground/80', labels.startIntro))
		if (!options.isSignedIn()) {
			form.appendChild(el('p', 'text-sm', labels.signInToStart))
			const button = el('button', 'btn-cta w-full sm:w-auto', labels.signIn)
			button.type = 'button'
			button.addEventListener('click', () => options.signInAndReturn())
			form.appendChild(button)
			return form
		}
		const place = el('select', 'input w-full')
		place.id = 'group-location'
		for (const location of options.locations) {
			const option = el('option', undefined, location.name)
			option.value = location.id
			option.selected = location.id === options.defaultLocationId
			place.appendChild(option)
		}
		if (options.locations.length > 1) {
			form.appendChild(field(labels.location, place))
		}
		const deadline = el('input', 'input w-full')
		deadline.type = 'datetime-local'
		deadline.id = 'group-deadline'
		form.appendChild(field(labels.deadline, deadline, labels.deadlineHint))
		const per = el('input', 'input w-full')
		per.type = 'text'
		per.inputMode = 'decimal'
		per.id = 'group-per-person'
		form.appendChild(field(labels.perPersonLimit, per))
		const total = el('input', 'input w-full')
		total.type = 'text'
		total.inputMode = 'decimal'
		total.id = 'group-total-limit'
		form.appendChild(field(labels.totalLimit, total))
		const error = el('p', 'text-sm font-medium text-destructive', notice)
		error.setAttribute('role', 'alert')
		form.appendChild(error)
		const submit = el('button', 'btn-cta w-full sm:w-auto', labels.start)
		submit.type = 'submit'
		form.appendChild(submit)
		form.addEventListener('submit', (event) => {
			event.preventDefault()
			const locationId =
				options.locations.length > 1 ? place.value : options.defaultLocationId
			const request: Parameters<typeof createGroup>[0] = { locationId }
			if (deadline.value) {
				const iso = deadlineIso(deadline.value)
				if (!iso) return void (error.textContent = labels.deadlineTooSoon)
				request.deadlineAt = iso
			}
			for (const [input, key] of [
				[per, 'perPersonLimitMinor'],
				[total, 'totalLimitMinor'],
			] as const) {
				if (input.value.trim()) {
					const minor = parseAmountMinor(input.value)
					if (minor === null) return void (error.textContent = labels.failed)
					request[key] = minor
				}
			}
			submit.disabled = true
			submit.textContent = labels.starting
			void act(async () => {
				const joined = await createGroup(request)
				session = {
					groupId: joined.groupId,
					personToken: joined.personToken,
					...(joined.shareToken ? { shareToken: joined.shareToken } : {}),
					isHost: true,
				}
				saveGroupSession(options.orgId, session)
				view = joined.view
				startPolling()
				draw()
			}).then((result) => {
				if (result === null && !session) {
					draw()
				}
			})
		})
		return form
	}

	function drawJoin(preview: GroupView | null): HTMLElement {
		const form = el('form', 'surface space-y-4 p-5 text-start sm:p-6')
		form.noValidate = true
		form.dataset.groupJoin = ''
		const host = preview?.hostFirstName ?? ''
		form.appendChild(
			el(
				'h2',
				'text-lg font-semibold text-foreground',
				fillTemplate(labels.joinHeading, { host }),
			),
		)
		form.appendChild(el('p', 'text-sm text-foreground/80', labels.joinIntro))
		const name = el('input', 'input w-full')
		name.type = 'text'
		name.id = 'group-first-name'
		name.maxLength = 40
		name.autocomplete = 'given-name'
		form.appendChild(field(labels.firstName, name))
		const error = el('p', 'text-sm font-medium text-destructive', notice)
		error.setAttribute('role', 'alert')
		form.appendChild(error)
		const submit = el('button', 'btn-cta w-full sm:w-auto', labels.join)
		submit.type = 'submit'
		form.appendChild(submit)
		form.addEventListener('submit', (event) => {
			event.preventDefault()
			const first = name.value.trim()
			if (!first || !linkGroupId || !linkToken) return
			submit.disabled = true
			submit.textContent = labels.joining
			void act(async () => {
				const joined = await joinGroup(linkGroupId, linkToken, first)
				session = { groupId: joined.groupId, personToken: joined.personToken }
				saveGroupSession(options.orgId, session)
				// The link's token has done its job: it leaves the address bar.
				history.replaceState(
					null,
					'',
					`${window.location.pathname}?g=${encodeURIComponent(joined.groupId)}`,
				)
				view = joined.view
				startPolling()
				draw()
			}).then(() => {
				if (!session) draw()
			})
		})
		return form
	}

	// ----- In a group -----

	function personLines(current: GroupView, personId: string) {
		return current.lines.filter((line) => line.personId === personId)
	}

	function drawLine(line: GroupLineView): HTMLElement {
		const row = el('li', 'flex items-start justify-between gap-3 py-1 text-sm')
		row.dataset.groupLine = line.id
		const text = el('div', 'min-w-0')
		const name = el(
			'span',
			undefined,
			`${line.line.quantity}× ${localize(line.itemName)}`,
		)
		name.setAttribute('dir', 'auto')
		text.appendChild(name)
		const detail = [
			...line.variantNames.map(localize),
			...line.options.map((option) => localize(option.optionName)),
		].join(', ')
		if (detail) {
			const extra = el('div', 'text-xs text-muted-foreground', detail)
			extra.setAttribute('dir', 'auto')
			text.appendChild(extra)
		}
		if (!line.available) {
			text.appendChild(
				el('div', 'text-xs font-medium text-destructive', labels.unavailable),
			)
		}
		const side = el('div', 'flex shrink-0 items-center gap-2')
		side.appendChild(
			el('span', 'tabular-nums', options.formatMoney(line.amountMinor / 100)),
		)
		if (line.canRemove) {
			const remove = el('button', 'text-xs underline', labels.remove)
			remove.type = 'button'
			remove.dataset.groupRemove = line.id
			remove.addEventListener('click', () => {
				if (!session) return
				const active = session
				void act(async () =>
					setView(
						await removeGroupLine(active.groupId, active.personToken, line.id),
					),
				)
			})
			side.appendChild(remove)
		}
		row.append(text, side)
		return row
	}

	function drawGroup(current: GroupView): HTMLElement {
		const wrap = el('div', 'space-y-5')
		wrap.dataset.groupView = current.id
		wrap.appendChild(
			el('h2', 'text-lg font-semibold text-foreground', labels.yourGroup),
		)

		const facts = el('div', 'space-y-1 text-sm text-foreground/80')
		if (current.deadlineAt) {
			const when = new Intl.DateTimeFormat(options.locale, {
				dateStyle: 'medium',
				timeStyle: 'short',
			}).format(new Date(current.deadlineAt))
			facts.appendChild(
				el('p', undefined, fillTemplate(labels.deadlineLine, { time: when })),
			)
		}
		if (current.perPersonLimitMinor != null) {
			facts.appendChild(
				el(
					'p',
					undefined,
					fillTemplate(labels.limitPerPerson, {
						amount: options.formatMoney(current.perPersonLimitMinor / 100),
					}),
				),
			)
		}
		if (current.totalLimitMinor != null) {
			facts.appendChild(
				el(
					'p',
					undefined,
					fillTemplate(labels.limitTotal, {
						amount: options.formatMoney(current.totalLimitMinor / 100),
					}),
				),
			)
		}
		if (facts.childElementCount > 0) wrap.appendChild(facts)

		const state =
			current.status === 'ordered'
				? labels.ordered
				: current.status === 'locked'
					? labels.locked
					: current.deadlineAt != null &&
						  current.serverNow >= current.deadlineAt
						? labels.pastDeadline
						: ''
		if (state) {
			const note = el(
				'p',
				'rounded-lg border border-border bg-muted p-3 text-sm font-medium',
				state,
			)
			note.dataset.groupState = current.status
			wrap.appendChild(note)
		}
		if (current.order) {
			const line = el(
				'p',
				'text-sm',
				fillTemplate(labels.orderStatus, {
					number: current.order.number,
					status: current.order.status,
				}),
			)
			line.dataset.groupOrder = current.order.id
			wrap.appendChild(line)
			// Only the host holds the order's receipt: friends see its status here.
			if (current.you?.isHost) {
				const link = el('a', 'btn-secondary w-full sm:w-auto', labels.viewOrder)
				link.href = `${options.successHref}${options.successHref.includes('?') ? '&' : '?'}order=${encodeURIComponent(current.order.id)}`
				wrap.appendChild(link)
			}
		}

		if (session?.isHost && session.shareToken) {
			const share = el('div', 'space-y-2')
			share.appendChild(el('p', 'text-sm font-medium', labels.shareHeading))
			const url = groupShareLink(
				window.location.origin,
				options.pagePath,
				current.id,
				session.shareToken,
			)
			const input = el('input', 'input w-full')
			input.type = 'text'
			input.readOnly = true
			input.value = url
			input.dataset.groupShare = ''
			input.addEventListener('focus', () => input.select())
			const copy = el('button', 'btn-secondary w-full sm:w-auto', labels.copy)
			copy.type = 'button'
			copy.addEventListener('click', () => {
				void navigator.clipboard
					?.writeText(url)
					.then(() => {
						copy.textContent = labels.copied
					})
					.catch(() => input.select())
			})
			share.append(input, copy)
			wrap.appendChild(share)
		}

		wrap.appendChild(
			el('h3', 'text-sm font-semibold text-foreground', labels.people),
		)
		const people = el('ul', 'space-y-3')
		for (const person of current.people) {
			const item = el('li', 'rounded-lg border border-border p-3')
			item.dataset.groupPerson = person.id
			const head = el('div', 'flex flex-wrap items-center gap-2')
			const name = el('span', 'font-medium', person.firstName)
			name.setAttribute('dir', 'auto')
			head.appendChild(name)
			if (person.isHost) head.appendChild(el('span', 'badge', labels.hostLabel))
			if (person.isYou) head.appendChild(el('span', 'badge', labels.youLabel))
			head.appendChild(
				el(
					'span',
					'text-xs text-muted-foreground',
					person.done ? labels.done : labels.notDone,
				),
			)
			if (current.you) {
				head.appendChild(
					el(
						'span',
						'ms-auto text-sm tabular-nums',
						fillTemplate(labels.subtotal, {
							amount: options.formatMoney(person.subtotalMinor / 100),
						}),
					),
				)
			}
			item.appendChild(head)
			const lines = personLines(current, person.id)
			if (current.you) {
				if (lines.length === 0) {
					item.appendChild(
						el('p', 'mt-1 text-xs text-muted-foreground', labels.noDishes),
					)
				} else {
					const list = el('ul', 'mt-1 divide-y divide-border')
					for (const line of lines) list.appendChild(drawLine(line))
					item.appendChild(list)
				}
			}
			people.appendChild(item)
		}
		wrap.appendChild(people)
		if (current.you) {
			wrap.appendChild(
				el(
					'p',
					'text-sm font-semibold tabular-nums',
					`${labels.total}: ${options.formatMoney(current.totalMinor / 100)}`,
				),
			)
		}

		if (notice) {
			const error = el('p', 'text-sm font-medium text-destructive', notice)
			error.setAttribute('role', 'alert')
			wrap.appendChild(error)
		}

		const actions = el('div', 'flex flex-col gap-2 sm:flex-row sm:flex-wrap')
		const menuLink = el(
			'a',
			'btn-secondary w-full sm:w-auto',
			labels.chooseDishes,
		)
		menuLink.href = options.menuHref
		actions.appendChild(menuLink)

		if (current.canAdd) {
			const addCart = el('button', 'btn-cta w-full sm:w-auto', labels.addCart)
			addCart.type = 'button'
			addCart.dataset.groupAddCart = ''
			addCart.addEventListener('click', () => {
				if (!session) return
				const active = session
				const store = createCartStore({ key: `menuza_cart_${options.orgId}` })
				const cart = store.lines()
				if (cart.length === 0) {
					notice = labels.cartEmpty
					draw()
					return
				}
				void act(async () => {
					const lines = orderLines(cart)
					let latest: GroupView | null = null
					for (let i = 0; i < lines.length; i += 1) {
						latest = await addGroupLine(
							active.groupId,
							active.personToken,
							lines[i]!,
						)
						// A dish that went in leaves the personal cart.
						store.remove(cart[i]!.id)
					}
					notice = labels.added
					setView(latest)
				})
			})
			actions.appendChild(addCart)
		}
		if (current.you && current.status !== 'ordered') {
			const me = current.people.find((p) => p.isYou)
			const done = el(
				'button',
				'btn-secondary w-full sm:w-auto',
				me?.done ? labels.notDone : labels.imDone,
			)
			done.type = 'button'
			done.dataset.groupDone = ''
			done.addEventListener('click', () => {
				if (!session) return
				const active = session
				void act(async () =>
					setView(
						await setGroupDone(active.groupId, active.personToken, !me?.done),
					),
				)
			})
			actions.appendChild(done)
		}
		wrap.appendChild(actions)

		if (current.you?.isHost && current.status !== 'ordered') {
			wrap.appendChild(drawHostPanel(current))
		} else if (
			current.you &&
			!current.you.isHost &&
			current.status !== 'ordered'
		) {
			const leave = el('button', 'text-sm underline', labels.leave)
			leave.type = 'button'
			leave.addEventListener('click', () => {
				if (!session || !window.confirm(labels.leaveConfirm)) return
				const active = session
				void act(async () => {
					await leaveGroup(active.groupId, active.personToken)
					clearGroupSession(options.orgId)
					session = null
					view = null
					stopPolling()
					draw()
				})
			})
			wrap.appendChild(leave)
		}
		return wrap
	}

	function drawHostPanel(current: GroupView): HTMLElement {
		const panel = el('div', 'surface space-y-3 p-4 text-start')
		panel.dataset.groupHost = ''
		const unavailable = current.lines.filter((line) => !line.available)
		if (unavailable.length > 0) {
			panel.appendChild(
				el('p', 'text-sm font-medium text-destructive', labels.unavailableHint),
			)
			const clear = el(
				'button',
				'btn-secondary w-full sm:w-auto',
				labels.removeUnavailable,
			)
			clear.type = 'button'
			clear.dataset.groupRemoveUnavailable = ''
			clear.addEventListener('click', () => {
				if (!session) return
				const active = session
				void act(async () => {
					let latest: GroupView | null = null
					for (const line of unavailable) {
						latest = await removeGroupLine(
							active.groupId,
							active.personToken,
							line.id,
						)
					}
					setView(latest)
				})
			})
			panel.appendChild(clear)
		}
		const row = el('div', 'flex flex-col gap-2 sm:flex-row sm:flex-wrap')
		const lock = el(
			'button',
			'btn-secondary w-full sm:w-auto',
			current.status === 'locked' ? labels.unlock : labels.lock,
		)
		lock.type = 'button'
		lock.dataset.groupLock = ''
		lock.addEventListener('click', () => {
			if (!session) return
			const active = session
			void act(async () =>
				setView(
					await updateGroup(active.groupId, active.personToken, {
						locked: current.status !== 'locked',
					}),
				),
			)
		})
		const checkout = el('button', 'btn-cta w-full sm:w-auto', labels.checkout)
		checkout.type = 'button'
		checkout.dataset.groupCheckout = ''
		checkout.disabled = current.lines.length === 0 || unavailable.length > 0
		checkout.addEventListener('click', () => {
			if (!session) return
			void act(async () => {
				// The group as it is right now: the version the host sees is the one
				// the region will insist on.
				const fresh = await readGroup(session!.groupId, session!.personToken)
				if (fresh.lines.length === 0) {
					notice = labels.emptyGroup
					return setView(fresh)
				}
				const cart = cartFromGroupView(
					fresh,
					options.locale,
					options.defaultLocale,
				)
				localStorage.setItem(groupCartKey(options.orgId), JSON.stringify(cart))
				saveGroupCheckout(sessionStorage, options.orgId, {
					groupId: fresh.id,
					version: fresh.version,
					token: session!.personToken,
				})
				window.location.assign(
					`${options.checkoutHref}${options.checkoutHref.includes('?') ? '&' : '?'}location=${encodeURIComponent(fresh.locationId)}`,
				)
			})
		})
		const end = el('button', 'text-sm underline', labels.end)
		end.type = 'button'
		end.addEventListener('click', () => {
			if (!session || !window.confirm(labels.endConfirm)) return
			const active = session
			void act(async () => {
				await endGroup(active.groupId, active.personToken)
				clearGroupSession(options.orgId)
				session = null
				view = null
				stopPolling()
				draw()
			})
		})
		row.append(lock, checkout)
		panel.append(row)
		panel.appendChild(
			el('p', 'text-xs text-muted-foreground', labels.checkoutHint),
		)
		panel.appendChild(end)
		return panel
	}

	function drawGone(): HTMLElement {
		const wrap = el('div', 'surface space-y-3 p-5 text-start')
		wrap.dataset.groupGone = ''
		wrap.appendChild(el('p', 'text-sm', labels.gone))
		const link = el('a', 'btn-secondary w-full sm:w-auto', labels.goneAction)
		link.href = options.menuHref
		wrap.appendChild(link)
		return wrap
	}

	function draw() {
		let node: HTMLElement
		if (session && view) node = drawGroup(view)
		else if (gone) node = drawGone()
		else if (!session && linkToken && linkGroupId) node = drawJoin(joinPreview)
		else if (!session) node = drawStart()
		else node = el('p', 'text-sm text-muted-foreground', labels.retry)
		root.replaceChildren(node)
	}

	async function init() {
		if (
			session &&
			linkGroupId &&
			session.groupId !== linkGroupId &&
			linkToken
		) {
			// A link to a different group than the one this browser is in: the link wins.
			session = null
		}
		if (!session && linkToken && linkGroupId) {
			// Who is hosting, for the heading (the link may have burned: say so).
			try {
				joinPreview = await readGroup(linkGroupId, linkToken)
			} catch {
				gone = true
			}
		}
		draw()
		if (session) {
			await refresh()
			startPolling()
		}
	}
	void init()
	return { stop: stopPolling, refresh }
}
