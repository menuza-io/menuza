import {
	ORDER_PROBLEM_ITEM_KINDS,
	ORDER_PROBLEM_KINDS,
	ORDER_PROBLEM_NOTE_MAX,
	ORDER_PROBLEM_PHOTO_MAX_BYTES,
	guestOrderProblemsResponseSchema,
	isPhotoType,
	type GuestOrderProblem,
	type GuestOrderProblemsResponse,
	type OrderProblemKind,
} from '@repo/common/order-problems'

import { fillTemplate } from './money.ts'
import {
	OrderRequestError,
	fetchOrderProblems,
	randomAttemptKey,
	submitOrderProblem,
	uploadOrderProblemPhoto,
} from './order-client.ts'
import { type OrderCredential } from './order-link.ts'

/**
 * "Something wrong?" on the order page (#191). The region decides whether a
 * report may be filed and what was answered; this draws it and sends the form.
 * Every word the guest or the restaurant wrote is put in the page as text,
 * never as markup. Nothing here goes through Sites SSR or App.
 */

export type OrderProblemLabels = {
	heading: string
	open: string
	intro: string
	kindLegend: string
	kinds: Record<OrderProblemKind, string>
	itemsLegend: string
	itemQuantity: string
	noteLabel: string
	noteHint: string
	photoLabel: string
	photoHint: string
	send: string
	sending: string
	cancel: string
	sent: string
	added: string
	photoFailed: string
	photoInvalid: string
	photoTooBig: string
	needItems: string
	failed: string
	limited: string
	windowClosed: string
	notReportable: string
	limitReached: string
	yourReports: string
	waiting: string
	refunded: string
	refundedOpen: string
	credit: string
	useCredit: string
	replied: string
	closed: string
	you: string
	restaurant: string
	photoAttached: string
}

/** The label that explains a refusal of the region, by its code and status. */
export function problemErrorText(
	labels: OrderProblemLabels,
	error: unknown,
): string {
	if (!(error instanceof OrderRequestError)) return labels.failed
	if (error.status === 429) {
		return error.code === 'problem_limit_reached'
			? labels.limitReached
			: labels.limited
	}
	switch (error.code) {
		case 'problem_window_closed':
			return labels.windowClosed
		case 'order_not_reportable':
		case 'problem_reports_disabled':
			return labels.notReportable
		case 'photo_too_large':
			return labels.photoTooBig
		case 'photo_invalid':
			return labels.photoInvalid
		default:
			return labels.failed
	}
}

/** A photo is checked here only to save a trip; the region checks the bytes again. */
export function photoProblem(
	file: { type: string; size: number } | null,
): 'photoInvalid' | 'photoTooBig' | null {
	if (!file) return null
	if (!isPhotoType(file.type)) return 'photoInvalid'
	if (file.size > ORDER_PROBLEM_PHOTO_MAX_BYTES) return 'photoTooBig'
	return null
}

export function kindNeedsItems(kind: OrderProblemKind): boolean {
	return ORDER_PROBLEM_ITEM_KINDS.includes(kind)
}

type Options = {
	root: HTMLElement
	orderId: string
	credential: () => OrderCredential | null
	labels: OrderProblemLabels
	locale: string
	currency: string
	formatMoney: (amount: number) => string
	/** The menu link a credit goes to (`/menu?coupon=CODE`), built by the page. */
	creditHref: (code: string) => string
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

/**
 * Reads the reports and draws the section: hidden unless the restaurant takes
 * reports (and this order can still have one, or already has some). Returns a
 * refresh function the page calls after its own status poll.
 */
export async function mountOrderProblems(
	options: Options,
): Promise<{ refresh: () => Promise<void> }> {
	const { root, labels } = options
	let view: GuestOrderProblemsResponse | null = null
	let formOpen = false
	/** One key per sending attempt; kept until the report is accepted. */
	let attemptKey = randomAttemptKey()
	let status = ''
	// The section is a fixed shell (heading, reports, a status line that stays in
	// the page so screen readers announce what it says, and the form or its
	// button). A poll that finds nothing new changes nothing, and one that finds
	// a new answer redraws the reports only, never a form someone is filling in.
	const heading = el(
		'h2',
		'text-base font-semibold text-foreground',
		labels.heading,
	)
	const reportsHost = el('div')
	const statusNode = el('p', 'text-sm font-medium text-foreground')
	statusNode.setAttribute('role', 'status')
	statusNode.setAttribute('dir', 'auto')
	const actionHost = el('div')
	let shellBuilt = false
	let drawnReports = ''
	let drawnAction = ''

	async function load() {
		const credential = options.credential()
		if (!credential) return
		try {
			view = guestOrderProblemsResponseSchema.parse(
				await fetchOrderProblems(options.orderId, credential),
			)
		} catch {
			// The section stays as it was: a failed read is not a reason to hide a report.
			if (!view) root.hidden = true
			return
		}
		draw()
	}

	function draw() {
		if (!view) return
		const hasReports = view.problems.length > 0
		const canReport = view.enabled && view.reportable.allowed
		if (!view.enabled || (!hasReports && !canReport)) {
			root.hidden = true
			root.replaceChildren()
			shellBuilt = false
			drawnReports = ''
			drawnAction = ''
			return
		}
		root.hidden = false
		if (!shellBuilt) {
			root.replaceChildren(heading, reportsHost, statusNode, actionHost)
			shellBuilt = true
			drawnReports = ''
			drawnAction = ''
		}
		if (statusNode.textContent !== status) statusNode.textContent = status
		const reportsKey = JSON.stringify(view.problems)
		if (reportsKey !== drawnReports) {
			drawnReports = reportsKey
			reportsHost.replaceChildren(
				...(hasReports ? [drawReports(view.problems)] : []),
			)
		}
		const actionKey = canReport ? (formOpen ? 'form' : 'button') : 'none'
		if (actionKey !== drawnAction) {
			drawnAction = actionKey
			actionHost.replaceChildren(
				...(canReport ? [formOpen ? drawForm(view) : drawOpenButton()] : []),
			)
		}
	}

	function drawOpenButton(): HTMLElement {
		const button = el('button', 'btn-secondary w-full sm:w-auto', labels.open)
		button.type = 'button'
		button.dataset.problemOpen = ''
		button.addEventListener('click', () => {
			formOpen = true
			status = ''
			draw()
			root.querySelector<HTMLElement>('input[name="kind"]')?.focus()
		})
		return button
	}

	function drawReports(problems: readonly GuestOrderProblem[]): HTMLElement {
		const list = el('ul', 'space-y-3')
		list.dataset.problemList = ''
		for (const problem of problems) {
			const item = el(
				'li',
				'rounded-lg border border-border bg-muted p-4 text-start',
			)
			item.dataset.problem = problem.id
			item.dataset.problemStatus = problem.status
			item.appendChild(
				el('p', 'font-medium text-foreground', labels.kinds[problem.kind]),
			)
			if (problem.items.length > 0) {
				const names = el(
					'p',
					'text-sm text-foreground/80',
					problem.items.map((i) => `${i.quantity} × ${i.name}`).join(', '),
				)
				names.setAttribute('dir', 'auto')
				item.appendChild(names)
			}
			if (problem.status === 'open') {
				item.appendChild(
					el('p', 'text-sm text-muted-foreground', labels.waiting),
				)
			}
			if (problem.refund) {
				const line = el(
					'p',
					'text-sm font-medium text-foreground',
					fillTemplate(labels.refunded, {
						amount: options.formatMoney(problem.refund.amountCents / 100),
					}),
				)
				line.dataset.problemRefund = ''
				item.appendChild(line)
			}
			if (problem.credit) {
				const date = new Intl.DateTimeFormat(options.locale, {
					dateStyle: 'medium',
				}).format(new Date(problem.credit.expiresAt))
				const line = el(
					'p',
					'text-sm font-medium text-foreground',
					fillTemplate(labels.credit, {
						amount: options.formatMoney(problem.credit.amountCents / 100),
						code: problem.credit.code,
						date,
					}),
				)
				line.dataset.problemCredit = problem.credit.code
				item.appendChild(line)
				const link = el('a', 'btn-cta mt-2 w-full sm:w-auto', labels.useCredit)
				link.href = options.creditHref(problem.credit.code)
				item.appendChild(link)
			}
			const thread = el('ol', 'mt-2 space-y-1 text-sm')
			for (const entry of problem.entries) {
				if (!entry.body && entry.kind === 'report') continue
				const row = el('li')
				const who = entry.author === 'guest' ? labels.you : labels.restaurant
				row.appendChild(el('span', 'text-muted-foreground', `${who}: `))
				const text = el(
					'span',
					'whitespace-pre-wrap',
					entry.body ??
						(entry.kind === 'refund'
							? labels.refundedOpen
							: entry.kind === 'close'
								? labels.closed
								: entry.kind === 'reply'
									? labels.replied
									: ''),
				)
				text.setAttribute('dir', 'auto')
				row.appendChild(text)
				thread.appendChild(row)
			}
			if (thread.childElementCount > 0) item.appendChild(thread)
			if (problem.hasPhoto) {
				item.appendChild(
					el('p', 'mt-1 text-xs text-muted-foreground', labels.photoAttached),
				)
			}
			list.appendChild(item)
		}
		return list
	}

	function drawForm(current: GuestOrderProblemsResponse): HTMLElement {
		const form = el('form', 'space-y-4 text-start')
		form.dataset.problemForm = ''
		form.noValidate = true
		form.appendChild(el('p', 'text-sm text-foreground/80', labels.intro))

		const kinds = el('fieldset', 'space-y-2')
		kinds.appendChild(
			el('legend', 'text-sm font-medium text-foreground', labels.kindLegend),
		)
		ORDER_PROBLEM_KINDS.forEach((kind, index) => {
			const row = el('label', 'flex items-center gap-2 text-sm')
			const input = el('input')
			input.type = 'radio'
			input.name = 'kind'
			input.value = kind
			input.checked = index === 0
			row.append(input, el('span', undefined, labels.kinds[kind]))
			kinds.appendChild(row)
		})
		form.appendChild(kinds)

		const items = el('fieldset', 'space-y-2')
		items.dataset.problemItems = ''
		items.appendChild(
			el('legend', 'text-sm font-medium text-foreground', labels.itemsLegend),
		)
		for (const line of current.lines) {
			const row = el('label', 'flex items-center gap-2 text-sm')
			const input = el('input')
			input.type = 'checkbox'
			input.name = 'item'
			input.value = String(line.lineIndex)
			const name = el('span', undefined, line.name)
			name.setAttribute('dir', 'auto')
			row.append(
				input,
				name,
				el(
					'span',
					'text-muted-foreground',
					fillTemplate(labels.itemQuantity, { count: line.quantity }),
				),
			)
			items.appendChild(row)
		}
		form.appendChild(items)

		const noteId = `problem-note-${options.orderId}`
		const noteWrap = el('div', 'space-y-1')
		const noteLabel = el(
			'label',
			'text-sm font-medium text-foreground',
			labels.noteLabel,
		)
		noteLabel.htmlFor = noteId
		const note = el('textarea', 'input min-h-24 w-full')
		note.id = noteId
		note.name = 'note'
		note.maxLength = ORDER_PROBLEM_NOTE_MAX
		note.rows = 4
		note.setAttribute('dir', 'auto')
		noteWrap.append(
			noteLabel,
			note,
			el('p', 'text-xs text-muted-foreground', labels.noteHint),
		)
		form.appendChild(noteWrap)

		const photoId = `problem-photo-${options.orderId}`
		const photoWrap = el('div', 'space-y-1')
		const photoLabel = el(
			'label',
			'text-sm font-medium text-foreground',
			labels.photoLabel,
		)
		photoLabel.htmlFor = photoId
		const photo = el('input')
		photo.type = 'file'
		photo.id = photoId
		photo.name = 'photo'
		photo.accept = 'image/jpeg,image/png,image/webp'
		photoWrap.append(
			photoLabel,
			photo,
			el('p', 'text-xs text-muted-foreground', labels.photoHint),
		)
		form.appendChild(photoWrap)

		const error = el('p', 'text-sm font-medium text-destructive')
		error.setAttribute('role', 'alert')
		error.dataset.problemError = ''
		form.appendChild(error)

		const actions = el('div', 'flex flex-col gap-2 sm:flex-row')
		const send = el('button', 'btn-cta w-full sm:w-auto', labels.send)
		send.type = 'submit'
		const cancel = el('button', 'btn-secondary w-full sm:w-auto', labels.cancel)
		cancel.type = 'button'
		cancel.addEventListener('click', () => {
			formOpen = false
			draw()
			root.querySelector<HTMLElement>('[data-problem-open]')?.focus()
		})
		actions.append(send, cancel)
		form.appendChild(actions)

		const syncItems = () => {
			const selected = form.querySelector<HTMLInputElement>(
				'input[name="kind"]:checked',
			)
			const kind = (selected?.value ?? 'other') as OrderProblemKind
			items.hidden = !kindNeedsItems(kind) || current.lines.length === 0
		}
		form.addEventListener('change', syncItems)
		syncItems()

		form.addEventListener('submit', (event) => {
			event.preventDefault()
			void submit(form, { send, error, note, photo })
		})
		return form
	}

	async function submit(
		form: HTMLFormElement,
		parts: {
			send: HTMLButtonElement
			error: HTMLElement
			note: HTMLTextAreaElement
			photo: HTMLInputElement
		},
	) {
		const credential = options.credential()
		if (!credential) return
		parts.error.textContent = ''
		const kind = (form.querySelector<HTMLInputElement>(
			'input[name="kind"]:checked',
		)?.value ?? 'other') as OrderProblemKind
		const lineIndexes = Array.from(
			form.querySelectorAll<HTMLInputElement>('input[name="item"]:checked'),
		).map((input) => Number(input.value))
		if (
			kindNeedsItems(kind) &&
			lineIndexes.length === 0 &&
			(view?.lines.length ?? 0) > 0
		) {
			parts.error.textContent = labels.needItems
			return
		}
		const file = parts.photo.files?.[0] ?? null
		const photoIssue = photoProblem(file)
		if (photoIssue) {
			parts.error.textContent = labels[photoIssue]
			return
		}
		parts.send.disabled = true
		parts.send.textContent = labels.sending
		try {
			const answer = (await submitOrderProblem(
				options.orderId,
				credential,
				{
					kind,
					items: kindNeedsItems(kind)
						? lineIndexes.map((lineIndex) => ({ lineIndex }))
						: [],
					...(parts.note.value.trim() ? { note: parts.note.value.trim() } : {}),
				},
				attemptKey,
			)) as { problemId?: string; added?: boolean; canAttachPhoto?: boolean }
			attemptKey = randomAttemptKey()
			status = answer.added ? labels.added : labels.sent
			if (file && answer.problemId && answer.canAttachPhoto !== false) {
				try {
					await uploadOrderProblemPhoto(
						options.orderId,
						answer.problemId,
						credential,
						file,
					)
				} catch {
					status = `${status} ${labels.photoFailed}`
				}
			}
			formOpen = false
			await load()
			draw()
			root.querySelector<HTMLElement>('[data-problem-open]')?.focus()
		} catch (caught) {
			parts.error.textContent = problemErrorText(labels, caught)
			parts.send.disabled = false
			parts.send.textContent = labels.send
			// A refusal that will not change on retry gets a fresh key next time.
			if (caught instanceof OrderRequestError && caught.status < 500) {
				attemptKey = randomAttemptKey()
			}
		}
	}

	await load()
	return { refresh: load }
}
