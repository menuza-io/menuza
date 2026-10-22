// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { suggestCode, TerminalsManager } from './terminals-manager.tsx'

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

const API = 'https://api-us.example.com'
const NOW = Date.now()
const CODE = `ppc1.org_1.${'a'.repeat(43)}`

type Call = { url: string; method: string; body: unknown; auth: string | null }

function terminal(overrides: Record<string, unknown> = {}) {
	return {
		id: 'd1',
		label: 'Front counter',
		terminalCode: 'T1',
		locationId: null,
		scopeId: 'main',
		signInRequired: false,
		pairedAt: NOW - 86_400_000,
		lastSeenAt: NOW - 2 * 60_000,
		revokedAt: null,
		...overrides,
	}
}

function stubApi(
	options: {
		devices?: unknown[]
		pending?: unknown[]
		createError?: { status: number; body: unknown }
		afterCreate?: () => void
		staff?: unknown[]
		staffError?: boolean
		held?: unknown[]
	} = {},
) {
	const calls: Call[] = []
	let devices = options.devices ?? []
	let pending = options.pending ?? []
	let staff = options.staff ?? []
	let held = options.held ?? []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
			const url = typeof input === 'string' ? input : input.toString()
			const method = init.method ?? 'GET'
			const headers = new Headers(init.headers)
			calls.push({
				url,
				method,
				auth: headers.get('authorization'),
				body: init.body ? JSON.parse(String(init.body)) : undefined,
			})
			if (url.includes('/orders-token')) {
				return Response.json({
					jwt: url.includes('write=1') ? 'write-token' : 'read-token',
					tenantApiUrl: API,
				})
			}
			if (url.endsWith('/operator/pos/staff') && method === 'GET') {
				return options.staffError
					? new Response('off', { status: 503 })
					: Response.json({ staff })
			}
			if (url.includes('/operator/pos/managers/')) {
				const id = decodeURIComponent(url.split('/').pop()!)
				staff = staff.map((p) =>
					(p as { id: string }).id === id
						? { ...(p as object), isManager: method === 'PUT' }
						: p,
				)
				return Response.json({ ok: true })
			}
			if (url.includes('/operator/pos/terminals/') && method === 'PATCH') {
				const id = decodeURIComponent(url.split('/').pop()!)
				devices = devices.map((d) =>
					(d as { id: string }).id === id
						? {
								...(d as object),
								...(JSON.parse(String(init?.body)) as object),
							}
						: d,
				)
				return Response.json({ ok: true })
			}
			if (url.endsWith('/operator/pos/terminals') && method === 'GET') {
				return Response.json({
					devices,
					pendingCodes: pending,
					heldUploads: held.length,
				})
			}
			if (url.endsWith('/operator/pos/held') && method === 'GET') {
				return Response.json({ held })
			}
			if (url.includes('/operator/pos/held/') && method === 'POST') {
				const id = decodeURIComponent(url.split('/').at(-2)!)
				held = held.filter((h) => (h as { id: string }).id !== id)
				return Response.json({ ok: true })
			}
			if (url.endsWith('/operator/pos/pairing-codes') && method === 'POST') {
				if (options.createError) {
					return Response.json(options.createError.body, {
						status: options.createError.status,
					})
				}
				const body = JSON.parse(String(init.body)) as {
					label: string
					terminalCode: string
				}
				pending = [
					{
						id: 'c1',
						label: body.label,
						terminalCode: body.terminalCode,
						expiresAt: NOW + 600_000,
					},
				]
				options.afterCreate?.()
				return Response.json(
					{
						id: 'c1',
						code: CODE,
						expiresAt: NOW + 600_000,
						terminalCode: body.terminalCode,
					},
					{ status: 201 },
				)
			}
			if (url.includes('/operator/pos/terminals/') && method === 'DELETE') {
				const id = decodeURIComponent(url.split('/').pop()!)
				devices = devices.map((d) =>
					(d as { id: string }).id === id
						? { ...(d as object), revokedAt: Date.now() }
						: d,
				)
				return Response.json({ ok: true })
			}
			if (url.includes('/operator/pos/pairing-codes/') && method === 'DELETE') {
				pending = []
				return Response.json({ ok: true })
			}
			return new Response('not found', { status: 404 })
		}),
	)
	return {
		calls,
		redeem: () => {
			pending = []
		},
		pair: (device: unknown) => {
			devices = [...devices, device]
		},
	}
}

const render = (props: Partial<Parameters<typeof TerminalsManager>[0]> = {}) =>
	renderStaff(
		<TerminalsManager
			orgSlug="joes"
			canWrite
			posUrl="https://pos.example.com"
			appUrl="https://app.example.com"
			{...props}
		/>,
	)

describe('TerminalsManager', () => {
	it('lists paired terminals with their code and last seen, and pending codes apart', async () => {
		stubApi({
			devices: [
				terminal(),
				terminal({
					id: 'd2',
					label: 'Bar tablet',
					terminalCode: 'T2',
					lastSeenAt: null,
				}),
			],
			pending: [
				{
					id: 'c9',
					label: 'Patio',
					terminalCode: 'T3',
					expiresAt: NOW + 300_000,
				},
			],
		})
		render()
		const list = await screen.findByRole('list', { name: 'Paired terminals' })
		expect(within(list).getByText('Front counter')).toBeTruthy()
		expect(within(list).getByText('T1')).toBeTruthy()
		expect(within(list).getByText('Bar tablet')).toBeTruthy()
		expect(within(list).getByText('Not seen yet')).toBeTruthy()
		const waiting = screen.getByRole('region', { name: 'Waiting to be paired' })
		expect(within(waiting).getByText('Patio')).toBeTruthy()
		expect(within(waiting).getByText('T3')).toBeTruthy()
	})

	it('shows an empty state when there is nothing yet', async () => {
		stubApi()
		render()
		expect(await screen.findByText('No terminals yet')).toBeTruthy()
	})

	it('hides removed terminals behind a toggle', async () => {
		stubApi({
			devices: [
				terminal(),
				terminal({
					id: 'old',
					label: 'Lost phone',
					terminalCode: 'T9',
					revokedAt: NOW - 1000,
				}),
			],
		})
		render()
		await screen.findByText('Front counter')
		expect(screen.queryByText('Lost phone')).toBeNull()
		fireEvent.click(screen.getByRole('button', { name: /Show 1 removed/ }))
		expect(screen.getByText('Lost phone')).toBeTruthy()
	})

	it('a read-only member sees terminals but cannot pair, cancel or remove', async () => {
		stubApi({
			devices: [terminal()],
			pending: [
				{
					id: 'c9',
					label: 'Patio',
					terminalCode: 'T3',
					expiresAt: NOW + 300_000,
				},
			],
		})
		render({ canWrite: false })
		await screen.findByText('Front counter')
		expect(screen.queryByRole('button', { name: 'Pair a terminal' })).toBeNull()
		expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull()
		expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
	})

	it('reads with a read token and writes with a write token', async () => {
		const api = stubApi({ devices: [terminal()] })
		render()
		await screen.findByText('Front counter')
		fireEvent.click(
			screen.getByRole('button', { name: 'Remove Front counter' }),
		)
		fireEvent.click(
			await screen.findByRole('button', { name: 'Remove terminal' }),
		)
		await waitFor(() =>
			expect(api.calls.some((c) => c.method === 'DELETE')).toBe(true),
		)
		const get = api.calls.find(
			(c) => c.url.endsWith('/operator/pos/terminals') && c.method === 'GET',
		)!
		const del = api.calls.find((c) => c.method === 'DELETE')!
		expect(get.auth).toBe('Bearer read-token')
		expect(del.auth).toBe('Bearer write-token')
		expect(del.url).toBe(`${API}/operator/pos/terminals/d1`)
		expect(
			api.calls.filter((c) => c.url.includes('orders-token?write=1')).length,
		).toBeGreaterThan(0)
	})

	it('removing asks first, says what happens to saved orders, and refreshes the list', async () => {
		stubApi({ devices: [terminal()] })
		render()
		await screen.findByText('Front counter')
		fireEvent.click(
			screen.getByRole('button', { name: 'Remove Front counter' }),
		)
		const dialog = await screen.findByRole('alertdialog')
		expect(
			within(dialog).getByText(
				/stay on that device and send after it is paired again/,
			),
		).toBeTruthy()
		fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it' }))
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
		expect(screen.getByText('Front counter')).toBeTruthy()
		fireEvent.click(
			screen.getByRole('button', { name: 'Remove Front counter' }),
		)
		fireEvent.click(
			await screen.findByRole('button', { name: 'Remove terminal' }),
		)
		await waitFor(() => expect(screen.queryByText('Front counter')).toBeNull())
	})

	it('pairing suggests the next free code, creates a code and shows a one-use link with everything in the fragment', async () => {
		const api = stubApi({ devices: [terminal()] })
		render()
		await screen.findByText('Front counter')
		fireEvent.click(screen.getByRole('button', { name: 'Pair a terminal' }))
		const dialog = await screen.findByRole('dialog')
		expect(
			(within(dialog).getByLabelText('Terminal code') as HTMLInputElement)
				.value,
		).toBe('T2')
		fireEvent.change(within(dialog).getByLabelText('Name'), {
			target: { value: 'Waiter phone' },
		})
		fireEvent.click(
			within(dialog).getByRole('button', { name: 'Create pairing code' }),
		)

		const link = (await within(dialog).findByLabelText(
			'Pairing link',
		)) as HTMLInputElement
		const url = new URL(link.value)
		expect(url.origin).toBe('https://pos.example.com')
		expect(url.search).toBe('')
		const params = new URLSearchParams(url.hash.slice(1))
		expect(params.get('c')).toBe(CODE)
		expect(params.get('a')).toBe(API)
		expect(params.get('u')).toBe('https://app.example.com')
		expect(params.get('s')).toBe('joes')
		const create = api.calls.find((c) => c.method === 'POST')!
		expect(create.body).toEqual({
			label: 'Waiter phone',
			terminalCode: 'T2',
			signInRequired: true,
			dayStartMinutes: 240,
		})
		expect(create.auth).toBe('Bearer write-token')
		expect(within(dialog).getByText('Waiting for the terminal…')).toBeTruthy()
	})

	it('uppercases the terminal code as it is typed', async () => {
		stubApi()
		render()
		await screen.findByText('No terminals yet')
		fireEvent.click(screen.getByRole('button', { name: 'Pair a terminal' }))
		const dialog = await screen.findByRole('dialog')
		const input = within(dialog).getByLabelText(
			'Terminal code',
		) as HTMLInputElement
		fireEvent.change(input, { target: { value: 'bar' } })
		expect(input.value).toBe('BAR')
	})

	it('without POS_URL it shows the bare code to type in, not a broken link', async () => {
		stubApi()
		render({ posUrl: '' })
		await screen.findByText('No terminals yet')
		fireEvent.click(screen.getByRole('button', { name: 'Pair a terminal' }))
		const dialog = await screen.findByRole('dialog')
		fireEvent.change(within(dialog).getByLabelText('Name'), {
			target: { value: 'Counter' },
		})
		fireEvent.click(
			within(dialog).getByRole('button', { name: 'Create pairing code' }),
		)
		const field = (await within(dialog).findByLabelText(
			'Pairing code',
		)) as HTMLInputElement
		expect(field.value).toBe(CODE)
		expect(within(dialog).queryByLabelText('Pairing link')).toBeNull()
	})

	it("shows the server's own explanation when the code is taken", async () => {
		stubApi({
			devices: [terminal()],
			createError: {
				status: 409,
				body: {
					error: 'terminal_code_taken',
					message: 'Terminal code T1 is already in use.',
				},
			},
		})
		render()
		await screen.findByText('Front counter')
		fireEvent.click(screen.getByRole('button', { name: 'Pair a terminal' }))
		const dialog = await screen.findByRole('dialog')
		fireEvent.change(within(dialog).getByLabelText('Name'), {
			target: { value: 'Second' },
		})
		fireEvent.change(within(dialog).getByLabelText('Terminal code'), {
			target: { value: 'T1' },
		})
		fireEvent.click(
			within(dialog).getByRole('button', { name: 'Create pairing code' }),
		)
		expect(
			await within(dialog).findByText('Terminal code T1 is already in use.'),
		).toBeTruthy()
		// Still on the form, nothing shown as paired.
		expect(within(dialog).queryByLabelText('Pairing link')).toBeNull()
	})

	it('cannot be submitted without a name', async () => {
		stubApi()
		render()
		await screen.findByText('No terminals yet')
		fireEvent.click(screen.getByRole('button', { name: 'Pair a terminal' }))
		const dialog = await screen.findByRole('dialog')
		expect(
			within(dialog).getByRole('button', { name: 'Create pairing code' }),
		).toBeDisabled()
	})

	it('notices when the terminal redeems the code', async () => {
		const api = stubApi()
		render()
		await screen.findByText('No terminals yet')
		fireEvent.click(screen.getByRole('button', { name: 'Pair a terminal' }))
		const dialog = await screen.findByRole('dialog')
		fireEvent.change(within(dialog).getByLabelText('Name'), {
			target: { value: 'Counter' },
		})
		fireEvent.click(
			within(dialog).getByRole('button', { name: 'Create pairing code' }),
		)
		await within(dialog).findByLabelText('Pairing link')
		// The terminal pairs: the code leaves the pending list.
		api.redeem()
		api.pair(terminal({ label: 'Counter', terminalCode: 'T1' }))
		expect(
			await within(dialog).findByText('Terminal paired', {}, { timeout: 6000 }),
		).toBeTruthy()
		expect(
			within(dialog).getByText('Counter is ready to take orders.'),
		).toBeTruthy()
	}, 12_000)

	it('does not call a removed code paired', async () => {
		const api = stubApi()
		render()
		await screen.findByText('No terminals yet')
		fireEvent.click(screen.getByRole('button', { name: 'Pair a terminal' }))
		const dialog = await screen.findByRole('dialog')
		fireEvent.change(within(dialog).getByLabelText('Name'), {
			target: { value: 'Counter' },
		})
		fireEvent.click(
			within(dialog).getByRole('button', { name: 'Create pairing code' }),
		)
		await within(dialog).findByLabelText('Pairing link')
		// The code leaves the pending list, but no terminal redeemed it.
		api.redeem()
		expect(
			await within(dialog).findByText(
				'This code was removed. Make a new one.',
				{},
				{ timeout: 6000 },
			),
		).toBeTruthy()
		expect(within(dialog).queryByText('Terminal paired')).toBeNull()
	}, 12_000)

	it('explains a load failure and lets you retry', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('no', { status: 500 })),
		)
		render()
		expect(
			await screen.findByRole('button', { name: 'Try again' }),
		).toBeTruthy()
	})
})

const person = (over: Record<string, unknown> = {}) => ({
	id: 's1',
	name: 'Ana K.',
	hasPin: true,
	isManager: false,
	...over,
})

describe('PIN sign-in', () => {
	it('shows whether each terminal asks for a PIN', async () => {
		stubApi({
			devices: [
				terminal({ signInRequired: true }),
				terminal({
					id: 'd2',
					label: 'Bar tablet',
					terminalCode: 'T2',
					signInRequired: false,
				}),
			],
		})
		render()
		const list = await screen.findByRole('list', { name: 'Paired terminals' })
		const front = within(list).getByText('Front counter').closest('li')!
		const bar = within(list).getByText('Bar tablet').closest('li')!
		expect(within(front).getByText('PIN sign-in on')).toBeTruthy()
		expect(within(bar).getByText('PIN sign-in off')).toBeTruthy()
	})

	it('turns PIN sign-in off for a terminal, with a write token, and shows the result', async () => {
		const api = stubApi({ devices: [terminal({ signInRequired: true })] })
		render()
		await screen.findByText('Front counter')
		const pinToggle = screen.getByRole('button', {
			name: 'Turn off PIN sign-in for Front counter',
		})
		expect(pinToggle).toHaveAttribute('aria-pressed', 'true')
		fireEvent.click(pinToggle)
		expect(await screen.findByText('PIN sign-in off')).toBeTruthy()
		expect(
			screen.getByRole('button', {
				name: 'Turn on PIN sign-in for Front counter',
			}),
		).toHaveAttribute('aria-pressed', 'false')
		const patch = api.calls.find((c) => c.method === 'PATCH')!
		expect(patch.url).toBe(`${API}/operator/pos/terminals/d1`)
		expect(patch.body).toEqual({ signInRequired: false })
		expect(patch.auth).toBe('Bearer write-token')
		fireEvent.click(
			await screen.findByRole('button', {
				name: 'Turn on PIN sign-in for Front counter',
			}),
		)
		expect(await screen.findByText('PIN sign-in on')).toBeTruthy()
	})

	it('a read-only member cannot change it', async () => {
		stubApi({
			devices: [terminal({ signInRequired: true })],
			staff: [person()],
		})
		render({ canWrite: false })
		await screen.findByText('Front counter')
		expect(
			screen.queryByRole('button', { name: /Turn (on|off) PIN sign-in/ }),
		).toBeNull()
		expect(screen.queryByRole('button', { name: /manager/i })).toBeNull()
	})

	it('pairing asks for a PIN by default, and a manager can switch that off for this terminal', async () => {
		const api = stubApi()
		render()
		await screen.findByText('No terminals yet')
		fireEvent.click(screen.getByRole('button', { name: 'Pair a terminal' }))
		const dialog = await screen.findByRole('dialog')
		const box = within(dialog).getByRole('checkbox', {
			name: /Require a staff PIN/,
		})
		expect(box.getAttribute('aria-checked')).toBe('true')
		fireEvent.click(box)
		fireEvent.change(within(dialog).getByLabelText('Name'), {
			target: { value: 'Back office' },
		})
		fireEvent.click(
			within(dialog).getByRole('button', { name: 'Create pairing code' }),
		)
		await within(dialog).findByLabelText('Pairing link')
		expect(api.calls.find((c) => c.method === 'POST')!.body).toMatchObject({
			label: 'Back office',
			signInRequired: false,
		})
	})
})

describe('who can manage terminals', () => {
	it('lists staff, who is a manager, and who still needs a PIN', async () => {
		stubApi({
			devices: [terminal()],
			staff: [
				person({ isManager: true }),
				person({ id: 's2', name: 'Omar R.', hasPin: false }),
			],
		})
		render()
		const section = await screen.findByRole('region', {
			name: 'Who can manage terminals',
		})
		const ana = within(section).getByText('Ana K.').closest('li')!
		const omar = within(section).getByText('Omar R.').closest('li')!
		expect(within(ana).getByText('Manager')).toBeTruthy()
		expect(within(ana).queryByText('No PIN yet')).toBeNull()
		expect(within(omar).getByText('No PIN yet')).toBeTruthy()
	})

	it('makes someone a manager and removes them again, with a write token', async () => {
		const api = stubApi({ devices: [terminal()], staff: [person()] })
		render()
		await screen.findByRole('region', { name: 'Who can manage terminals' })
		fireEvent.click(
			screen.getByRole('button', { name: 'Make Ana K. a manager' }),
		)
		expect(await screen.findByText('Manager')).toBeTruthy()
		const put = api.calls.find((c) => c.method === 'PUT')!
		expect(put.url).toBe(`${API}/operator/pos/managers/s1`)
		expect(put.auth).toBe('Bearer write-token')
		fireEvent.click(
			await screen.findByRole('button', { name: 'Remove Ana K. as manager' }),
		)
		await waitFor(() => expect(screen.queryByText('Manager')).toBeNull())
		expect(
			api.calls.some(
				(c) => c.method === 'DELETE' && c.url.endsWith('/managers/s1'),
			),
		).toBe(true)
	})

	it('the page still works when the staff list cannot be loaded, and the section is simply absent', async () => {
		stubApi({ devices: [terminal()], staffError: true })
		render()
		expect(await screen.findByText('Front counter')).toBeTruthy()
		expect(
			screen.queryByRole('region', { name: 'Who can manage terminals' }),
		).toBeNull()
	})

	it('no section at all when nobody is on the roster', async () => {
		stubApi({ devices: [terminal()], staff: [] })
		render()
		await screen.findByText('Front counter')
		expect(
			screen.queryByRole('region', { name: 'Who can manage terminals' }),
		).toBeNull()
	})
})

describe('suggestCode', () => {
	it('picks the first free T-number, counting pending codes and ignoring removed terminals', () => {
		const t = (code: string, revokedAt: number | null = null) =>
			({ ...terminal({ terminalCode: code, revokedAt }) }) as never
		expect(suggestCode([], [])).toBe('T1')
		expect(suggestCode([t('T1'), t('T2')], [])).toBe('T3')
		expect(suggestCode([t('T1')], [{ terminalCode: 'T2' }])).toBe('T3')
		expect(suggestCode([t('T1', 123), t('T2')], [])).toBe('T1')
		expect(suggestCode([t('T1'), t('T3')], [])).toBe('T2')
	})

	it('shows sales a terminal sent that the server held for review, until a manager settles them', async () => {
		const api = stubApi({
			devices: [terminal()],
			held: [
				{
					id: 'h1',
					terminalLabel: 'Front counter',
					terminalCode: 'T1',
					orderId: null,
					error: 'invalid_request',
					message: null,
					receivedAt: Date.now(),
				},
			],
		})
		render()
		const section = await screen.findByRole('region', {
			name: 'Sales held for review',
		})
		expect(within(section).getByText(/out of date/)).toBeTruthy()
		fireEvent.click(
			within(section).getByRole('button', { name: 'Mark settled' }),
		)
		await waitFor(() =>
			expect(
				screen.queryByRole('region', { name: 'Sales held for review' }),
			).toBeNull(),
		)
		expect(
			api.calls.some(
				(c) =>
					c.url.endsWith('/operator/pos/held/h1/resolve') &&
					c.method === 'POST',
			),
		).toBe(true)
	})

	it("lets a manager choose when a terminal's business day ends", async () => {
		stubApi({ devices: [terminal()] })
		render()
		expect(
			await screen.findByRole('combobox', {
				name: 'When the business day ends for Front counter',
			}),
		).toBeTruthy()
	})

	it('exposes the cash drawer shift toggle state and saves changes', async () => {
		const api = stubApi({ devices: [terminal()] })
		render()
		const toggle = await screen.findByRole('button', {
			name: 'Require a cash drawer shift before Front counter sells',
		})
		expect(toggle).toHaveAttribute('aria-pressed', 'false')
		fireEvent.click(toggle)
		const enabled = await screen.findByRole('button', {
			name: 'Stop requiring cash drawer shifts on Front counter',
		})
		expect(enabled).toHaveAttribute('aria-pressed', 'true')
		expect(api.calls.find((call) => call.method === 'PATCH')?.body).toEqual({
			shiftsRequired: true,
		})
	})
})
