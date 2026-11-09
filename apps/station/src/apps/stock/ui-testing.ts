import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'
import catalogFixture from './fixtures/catalog.json'
import countSheet from './fixtures/count-sheet.json'

/** Shared set-up for the Stock screen tests (jsdom): a page to draw in, DOM stand-ins, and a recording region behind `fetch`. */

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

export type Page = {
	host: HTMLDivElement
	root: Root
	draw: (node: ReactNode) => Promise<void>
	unmount: () => Promise<void>
}

export function installDom() {
	// jsdom has no modal dialog: the sheet only needs `open` to be set.
	HTMLDialogElement.prototype.showModal = function showModal() {
		this.setAttribute('open', '')
	}
	HTMLDialogElement.prototype.close = function close() {
		this.removeAttribute('open')
	}
	vi.stubGlobal('matchMedia', () => ({
		matches: true,
		addEventListener() {},
		removeEventListener() {},
	}))
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			disconnect() {}
		},
	)
	HTMLElement.prototype.scrollIntoView = vi.fn()
	HTMLElement.prototype.showPopover = function showPopover() {}
	HTMLElement.prototype.hidePopover = function hidePopover() {}
}

export function mount(): Page {
	const host = document.createElement('div')
	document.body.append(host)
	const root = createRoot(host)
	return {
		host,
		root,
		async draw(node) {
			await act(async () => {
				root.render(h(I18nProvider, { i18n }, node))
			})
		},
		async unmount() {
			await act(async () => root.unmount())
			host.remove()
		},
	}
}

const nameOf = (element: Element) =>
	(element.getAttribute('aria-label') ?? element.textContent ?? '')
		.replace(/\s+/g, ' ')
		.trim()

const matches = (text: string, name: string | RegExp) =>
	typeof name === 'string' ? text === name : name.test(text)

export function button(scope: ParentNode, name: string | RegExp) {
	const found = [...scope.querySelectorAll('button')].find((candidate) =>
		matches(nameOf(candidate), name),
	)
	if (!found) {
		const all = [...scope.querySelectorAll('button')].map(nameOf)
		throw new Error(`No button "${String(name)}" among: ${all.join(' | ')}`)
	}
	return found
}

/** Every button with that name (a name can appear on a card and again in a list). */
export const buttons = (scope: ParentNode, name: string | RegExp) =>
	[...scope.querySelectorAll('button')].filter((candidate) =>
		matches(nameOf(candidate), name),
	)

export const hasButton = (scope: ParentNode, name: string | RegExp) =>
	[...scope.querySelectorAll('button')].some((candidate) =>
		matches(nameOf(candidate), name),
	)

export const text = (scope: ParentNode) =>
	(scope.textContent ?? '').replace(/\s+/g, ' ')

export async function click(element: Element) {
	await act(async () => {
		;(element as HTMLElement).click()
	})
}

/** Types into a controlled field the way a person does: input event, then leaving the field. */
export async function type(
	input: HTMLInputElement,
	value: string,
	leave = true,
) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			'value',
		)!.set!.call(input, value)
		input.dispatchEvent(new Event('input', { bubbles: true }))
	})
	if (leave)
		await act(async () => {
			input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
		})
}

export const flush = () => act(async () => {})

export type Request = {
	method: string
	path: string
	headers: Headers
	body: any
}

/**
 * A regional node behind `fetch`: it answers `/pos/inventory/*` from the
 * recorded fixtures, accepts every write, and keeps each request for the
 * test to read. `online` false makes every call fail like a dropped network.
 */
export function region(options: { online?: boolean } = {}) {
	const requests: Request[] = []
	const state = { online: options.online ?? true, serial: 0 }
	const fetchImpl = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input))
			const method = init?.method ?? 'GET'
			const body =
				init?.body && typeof init.body === 'string'
					? JSON.parse(init.body)
					: null
			if (!state.online) throw new TypeError('Failed to fetch')
			requests.push({
				method,
				path: url.pathname,
				headers: new Headers(init?.headers),
				body,
			})
			const path = url.pathname
			if (path === '/pos/inventory/catalog') {
				if (
					new Headers(init?.headers).get('If-None-Match') ===
					`"${catalogFixture.version}"`
				)
					return new Response(null, { status: 304 })
				return Response.json(catalogFixture)
			}
			const summary = {
				...catalogFixture.counts[0]!,
				id: 'cnt_srv_1',
				itemsCounted: 0,
			}
			if (path === '/pos/inventory/counts' && method === 'POST')
				return Response.json({ count: summary, joined: false })
			let match = /^\/pos\/inventory\/counts\/([^/]+)\/entries$/.exec(path)
			if (match)
				return Response.json({
					accepted: body.entries.map((entry: { clientId: string }) => ({
						clientId: entry.clientId,
						quantity: null,
					})),
					duplicates: [],
					refused: [],
				})
			match = /^\/pos\/inventory\/counts\/([^/]+)\/send$/.exec(path)
			if (match) return Response.json({ ...summary, status: 'in_review' })
			match = /^\/pos\/inventory\/counts\/([^/]+)$/.exec(path)
			if (match) return Response.json(countSheet)
			if (path === '/pos/inventory/waste')
				return Response.json({
					accepted: body.entries.map((entry: { clientId: string }) => ({
						clientId: entry.clientId,
						id: `wst_${++state.serial}`,
						quantity: 1000,
					})),
					duplicates: [],
					refused: [],
					lateSync: [],
				})
			if (path === '/pos/inventory/waste/dishes')
				return Response.json({
					logged: body.lines.length,
					withoutRecipe: 0,
					duplicate: false,
				})
			if (/\/waste\/[^/]+\/undo$/.test(path))
				return Response.json({ id: 'rev_1' })
			if (path === '/pos/inventory/deliveries')
				return Response.json({
					id: `dlv_${++state.serial}`,
					lineCount: body.lines.length,
					receivedAt: Date.now(),
					pricesPending: true,
					lateSync: false,
					duplicate: false,
					order: null,
					orderLinkIgnored: null,
				})
			return Response.json({ error: 'not_found' }, { status: 404 })
		},
	)
	return {
		requests,
		fetchImpl,
		state,
		install: () => vi.stubGlobal('fetch', fetchImpl),
		writes: (path: string | RegExp) =>
			requests.filter(
				(request) =>
					request.method === 'POST' &&
					(typeof path === 'string'
						? request.path === path
						: path.test(request.path)),
			),
	}
}
