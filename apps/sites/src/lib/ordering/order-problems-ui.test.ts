/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OrderRequestError } from './order-client'

const fetchOrderProblems = vi.fn()
const submitOrderProblem = vi.fn()
const uploadOrderProblemPhoto = vi.fn()

vi.mock('./order-client.ts', async () => {
	const actual =
		await vi.importActual<typeof import('./order-client')>('./order-client')
	return {
		...actual,
		fetchOrderProblems: (...args: unknown[]) => fetchOrderProblems(...args),
		submitOrderProblem: (...args: unknown[]) => submitOrderProblem(...args),
		uploadOrderProblemPhoto: (...args: unknown[]) =>
			uploadOrderProblemPhoto(...args),
	}
})

import {
	kindNeedsItems,
	mountOrderProblems,
	photoProblem,
	problemErrorText,
	type OrderProblemLabels,
} from './order-problems-ui'

const labels: OrderProblemLabels = {
	heading: 'Something wrong?',
	open: 'Report a problem',
	intro: 'Tell us',
	kindLegend: 'What went wrong?',
	kinds: {
		missing_item: 'An item is missing',
		wrong_item: 'Wrong item',
		late: 'Late',
		quality: 'Quality',
		other: 'Else',
	},
	itemsLegend: 'Which items?',
	itemQuantity: '{count} ordered',
	noteLabel: 'More?',
	noteHint: 'Up to 1,000',
	photoLabel: 'Photo',
	photoHint: 'JPEG',
	send: 'Send report',
	sending: 'Sending…',
	cancel: 'Cancel',
	sent: 'Thank you, sent.',
	added: 'Added to your open report.',
	photoFailed: 'Photo failed.',
	photoInvalid: 'Not a picture.',
	photoTooBig: 'Too big.',
	needItems: 'Choose an item.',
	failed: 'Could not send.',
	limited: 'Too many.',
	windowClosed: 'Too late.',
	notReportable: 'Not here.',
	limitReached: 'Limit.',
	yourReports: 'Your reports',
	waiting: 'Waiting for the restaurant',
	refunded: 'Refunded {amount}',
	refundedOpen: 'Refunded the items.',
	credit: 'Credit {amount}: code {code} before {date}',
	useCredit: 'Order with credit',
	replied: 'Replied.',
	closed: 'Closed.',
	you: 'You',
	restaurant: 'The restaurant',
	photoAttached: 'Photo attached',
}

function view(overrides: Record<string, unknown> = {}) {
	return {
		enabled: true,
		reportable: { allowed: true, reason: null, until: null },
		lines: [{ lineIndex: 0, name: 'Burger', quantity: 2 }],
		problems: [],
		...overrides,
	}
}

async function mount() {
	document.body.innerHTML = '<section id="root" hidden></section>'
	const root = document.getElementById('root')!
	const handle = await mountOrderProblems({
		root,
		orderId: 'o1',
		credential: () => ({ kind: 'receipt', token: 'r'.repeat(40) }),
		labels,
		locale: 'en',
		currency: 'USD',
		formatMoney: (amount) => `$${amount.toFixed(2)}`,
		creditHref: (code) => `/menu?coupon=${code}`,
	})
	return { root, handle }
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('helpers', () => {
	it('names the refusal the region gave', () => {
		expect(problemErrorText(labels, new OrderRequestError('x', 429))).toBe(
			'Too many.',
		)
		expect(
			problemErrorText(
				labels,
				new OrderRequestError('problem_limit_reached', 429),
			),
		).toBe('Limit.')
		expect(
			problemErrorText(
				labels,
				new OrderRequestError('problem_window_closed', 409),
			),
		).toBe('Too late.')
		expect(
			problemErrorText(
				labels,
				new OrderRequestError('order_not_reportable', 409),
			),
		).toBe('Not here.')
		expect(problemErrorText(labels, new Error('network'))).toBe(
			'Could not send.',
		)
	})

	it('checks the photo by type and size before sending it', () => {
		expect(photoProblem(null)).toBeNull()
		expect(photoProblem({ type: 'image/png', size: 1000 })).toBeNull()
		expect(photoProblem({ type: 'text/html', size: 10 })).toBe('photoInvalid')
		expect(photoProblem({ type: 'image/jpeg', size: 6 * 1024 * 1024 })).toBe(
			'photoTooBig',
		)
		expect(kindNeedsItems('missing_item')).toBe(true)
		expect(kindNeedsItems('late')).toBe(false)
	})
})

describe('the order page section (#191)', () => {
	it('stays hidden while the restaurant takes no reports, or the window is closed with nothing to show', async () => {
		fetchOrderProblems.mockResolvedValue(view({ enabled: false }))
		expect((await mount()).root.hidden).toBe(true)
		fetchOrderProblems.mockResolvedValue(
			view({
				reportable: { allowed: false, reason: 'window_closed', until: 1 },
			}),
		)
		expect((await mount()).root.hidden).toBe(true)
		fetchOrderProblems.mockRejectedValue(new Error('down'))
		expect((await mount()).root.hidden).toBe(true)
	})

	it('offers the form, and sends the kind, the items and the note with one key; the photo follows', async () => {
		fetchOrderProblems.mockResolvedValue(view())
		submitOrderProblem.mockResolvedValue({
			problemId: 'p1',
			added: false,
			canAttachPhoto: true,
		})
		uploadOrderProblemPhoto.mockResolvedValue({ hasPhoto: true })
		const { root } = await mount()
		expect(root.hidden).toBe(false)
		root.querySelector<HTMLButtonElement>('[data-problem-open]')!.click()
		const form = root.querySelector<HTMLFormElement>('[data-problem-form]')!
		expect(form).toBeTruthy()
		form.querySelector<HTMLInputElement>('input[name="item"]')!.checked = true
		form.querySelector<HTMLTextAreaElement>('textarea')!.value =
			'  never came  '
		const file = new File([new Uint8Array([1, 2, 3])], 'a.png', {
			type: 'image/png',
		})
		Object.defineProperty(form.querySelector('input[type="file"]')!, 'files', {
			value: [file],
		})
		fetchOrderProblems.mockResolvedValue(
			view({
				reportable: { allowed: false, reason: 'limit_reached', until: null },
				problems: [
					{
						id: 'p1',
						kind: 'missing_item',
						status: 'open',
						resolution: null,
						createdAt: Date.now(),
						items: [{ name: 'Burger', quantity: 2 }],
						note: 'never came',
						hasPhoto: true,
						refund: null,
						credit: null,
						entries: [],
					},
				],
			}),
		)
		form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
		await vi.waitFor(() => expect(uploadOrderProblemPhoto).toHaveBeenCalled())
		expect(submitOrderProblem).toHaveBeenCalledTimes(1)
		const [orderId, credential, body, key] = submitOrderProblem.mock.calls[0]!
		expect(orderId).toBe('o1')
		expect(credential).toEqual({ kind: 'receipt', token: 'r'.repeat(40) })
		expect(body).toEqual({
			kind: 'missing_item',
			items: [{ lineIndex: 0 }],
			note: 'never came',
		})
		expect(String(key).length).toBeGreaterThanOrEqual(16)
		expect(uploadOrderProblemPhoto).toHaveBeenCalledWith(
			'o1',
			'p1',
			credential,
			file,
		)
		await vi.waitFor(() =>
			expect(root.querySelector('[data-problem="p1"]')).toBeTruthy(),
		)
		expect(root.textContent).toContain('Thank you, sent.')
		expect(root.textContent).toContain('Waiting for the restaurant')
		expect(root.textContent).toContain('2 × Burger')
	})

	it('asks for an item when the problem names dishes, and a wrong file is refused before sending', async () => {
		fetchOrderProblems.mockResolvedValue(view())
		const { root } = await mount()
		root.querySelector<HTMLButtonElement>('[data-problem-open]')!.click()
		const form = root.querySelector<HTMLFormElement>('[data-problem-form]')!
		form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
		expect(form.querySelector('[data-problem-error]')!.textContent).toBe(
			'Choose an item.',
		)
		expect(submitOrderProblem).not.toHaveBeenCalled()
		form.querySelector<HTMLInputElement>('input[name="item"]')!.checked = true
		Object.defineProperty(form.querySelector('input[type="file"]')!, 'files', {
			value: [new File(['<html>'], 'x.html', { type: 'text/html' })],
		})
		form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
		expect(form.querySelector('[data-problem-error]')!.textContent).toBe(
			'Not a picture.',
		)
		expect(submitOrderProblem).not.toHaveBeenCalled()
	})

	it('hides the item list for a problem that names none, and sends no items', async () => {
		fetchOrderProblems.mockResolvedValue(view())
		submitOrderProblem.mockResolvedValue({
			problemId: 'p1',
			added: true,
			canAttachPhoto: false,
		})
		const { root } = await mount()
		root.querySelector<HTMLButtonElement>('[data-problem-open]')!.click()
		const form = root.querySelector<HTMLFormElement>('[data-problem-form]')!
		const late = form.querySelector<HTMLInputElement>('input[value="late"]')!
		late.checked = true
		form.dispatchEvent(new Event('change', { bubbles: true }))
		expect(
			form.querySelector<HTMLElement>('[data-problem-items]')!.hidden,
		).toBe(true)
		form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
		await vi.waitFor(() => expect(submitOrderProblem).toHaveBeenCalled())
		expect(submitOrderProblem.mock.calls[0]![2]).toEqual({
			kind: 'late',
			items: [],
		})
		await vi.waitFor(() =>
			expect(root.textContent).toContain('Added to your open report.'),
		)
	})

	it('says why a refusal happened and lets the guest try again', async () => {
		fetchOrderProblems.mockResolvedValue(view())
		submitOrderProblem.mockRejectedValue(
			new OrderRequestError('problem_window_closed', 409),
		)
		const { root } = await mount()
		root.querySelector<HTMLButtonElement>('[data-problem-open]')!.click()
		const form = root.querySelector<HTMLFormElement>('[data-problem-form]')!
		form.querySelector<HTMLInputElement>('input[name="item"]')!.checked = true
		form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
		await vi.waitFor(() =>
			expect(form.querySelector('[data-problem-error]')!.textContent).toBe(
				'Too late.',
			),
		)
		expect(
			form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled,
		).toBe(false)
	})

	it('shows the refund, the credit code with its link, and the restaurant’s words as text only', async () => {
		fetchOrderProblems.mockResolvedValue(
			view({
				reportable: { allowed: false, reason: 'window_closed', until: 1 },
				problems: [
					{
						id: 'p1',
						kind: 'missing_item',
						status: 'answered',
						resolution: 'credit',
						createdAt: Date.now(),
						items: [],
						note: null,
						hasPhoto: false,
						refund: { amountCents: 1000 },
						credit: {
							code: 'CR-ABCD1234',
							amountCents: 500,
							expiresAt: Date.UTC(2027, 0, 15),
						},
						entries: [
							{
								id: 'e1',
								kind: 'credit',
								author: 'operator',
								body: 'Sorry <img src=x onerror=alert(1)>',
								at: 1,
							},
						],
					},
				],
			}),
		)
		const { root } = await mount()
		expect(root.hidden).toBe(false)
		expect(root.querySelector('[data-problem-refund]')!.textContent).toBe(
			'Refunded $10.00',
		)
		expect(root.querySelector('[data-problem-credit]')!.textContent).toContain(
			'CR-ABCD1234',
		)
		expect(
			root.querySelector<HTMLAnchorElement>('a')!.getAttribute('href'),
		).toBe('/menu?coupon=CR-ABCD1234')
		// Words are text: the markup in them never becomes an element.
		expect(root.querySelector('img')).toBeNull()
		expect(root.textContent).toContain('Sorry <img src=x onerror=alert(1)>')
		expect(root.querySelector('[data-problem-open]')).toBeNull()
	})
})
