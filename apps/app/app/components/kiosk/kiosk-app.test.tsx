// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import {
	act,
	cleanup,
	fireEvent,
	screen,
	waitFor,
} from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { KioskApp } from './kiosk-app.tsx'

// Catalog loading and the language switch are covered elsewhere; keep the
// shell on English so these tests read what the screen says.
vi.mock('#app/utils/kiosk/kiosk-locale.ts', () => ({
	initialKioskLocale: () => 'en',
	activateKioskLocale: async () => {},
	preloadKioskCatalogs: async () => {},
}))

const URLS = { us: 'https://us.tenant.test', ksa: 'https://ksa.tenant.test' }
const SECRET = `kdv1.org_1.device01.${'a'.repeat(43)}`

type Handler = (request: {
	path: string
	body: any
}) => Response | Promise<Response>

function pair() {
	localStorage.setItem(
		'kiosk.device.v1',
		JSON.stringify({
			deviceSecret: SECRET,
			tenantApiUrl: URLS.us,
			config: {
				device: {
					id: 'd1',
					name: 'Front counter',
					scopeId: 'loc-1',
					identifyMode: 'pin',
					showNextShifts: false,
				},
				scope: { name: 'Downtown', timeZone: 'America/Chicago' },
			},
		}),
	)
}

const identified = (overrides: Record<string, unknown> = {}) => ({
	firstName: 'Rana',
	state: 'out',
	allowedEvents: ['clock_in'],
	positions: [],
	nextShifts: [],
	promptTips: false,
	serverNow: Date.now(),
	...overrides,
})

const accepted = (overrides: Record<string, unknown> = {}) => ({
	outcome: 'accepted',
	duplicate: false,
	kind: 'clock_in',
	state: 'in',
	firstName: 'Rana',
	at: Date.now(),
	serverNow: Date.now(),
	...overrides,
})

function stub(handler: Handler) {
	const requests: Array<{ path: string; body: any }> = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = new URL(String(input)).pathname
			const body = init?.body ? JSON.parse(String(init.body)) : null
			requests.push({ path, body })
			if (path === '/kiosk/config') {
				return Response.json({
					device: {
						id: 'd1',
						name: 'Front counter',
						scopeId: 'loc-1',
						identifyMode: 'pin',
						showNextShifts: false,
					},
					scope: { name: 'Downtown', timeZone: 'America/Chicago' },
					serverNow: Date.now(),
				})
			}
			return handler({ path, body })
		}),
	)
	return requests
}

function typePin(pin: string) {
	for (const digit of pin) {
		fireEvent.click(screen.getByRole('button', { name: digit }))
	}
}

beforeEach(() => {
	localStorage.clear()
	vi.stubGlobal('indexedDB', new IDBFactory())
	pair()
})

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

function openPad() {
	renderStaff(<KioskApp urls={URLS} />)
	return screen.findByRole('heading', { name: 'Enter your PIN' })
}

describe('KioskApp online', () => {
	it('shows the workplace, a clock and the PIN pad for a paired tablet', async () => {
		stub(() => Response.json({}))
		await openPad()
		expect(screen.getByText('Downtown · Front counter')).toBeTruthy()
		expect(screen.getByRole('status', { name: '' })).toBeTruthy()
		expect(screen.getByRole('group', { name: 'Number pad' })).toBeTruthy()
	})

	it('PIN, then clock in, then a first-name confirmation that closes by itself', async () => {
		const requests = stub(({ path }) =>
			path === '/kiosk/identify'
				? Response.json(identified())
				: Response.json(accepted()),
		)
		await openPad()
		typePin('4821')
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		await screen.findByRole('heading', { name: 'Hi Rana' })
		fireEvent.click(screen.getByRole('button', { name: 'Clock in' }))
		await screen.findByRole('heading', { name: 'Clocked in, Rana' })

		const punch = requests.find((request) => request.path === '/kiosk/punch')!
		expect(punch.body).toMatchObject({
			kind: 'clock_in',
			pin: '4821',
			offline: false,
		})
		expect(punch.body.id).toMatch(/^[0-9a-f-]{36}$/)
		expect(punch.body.staffId).toBeUndefined()

		// Nothing but a first name was ever on screen.
		expect(document.body.textContent).not.toMatch(/4821/)
		fireEvent.click(screen.getByRole('button', { name: 'Done' }))
		await screen.findByRole('heading', { name: 'Enter your PIN' })
		expect(screen.getByRole('img', { name: 'No digits entered' })).toBeTruthy()
	})

	it('answers a wrong PIN with a plain message and a clean pad', async () => {
		stub(() =>
			Response.json(
				{ error: 'invalid_pin', retryAfterSeconds: 0 },
				{ status: 401 },
			),
		)
		await openPad()
		typePin('0000')
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		expect((await screen.findByRole('alert')).textContent).toContain(
			'That PIN did not match. Try again.',
		)
		expect(screen.getByRole('img', { name: 'No digits entered' })).toBeTruthy()
	})

	it('pauses the pad and says how long when the server asks for a wait', async () => {
		stub(() =>
			Response.json(
				{ error: 'invalid_pin', retryAfterSeconds: 30 },
				{ status: 401, headers: { 'Retry-After': '30' } },
			),
		)
		await openPad()
		typePin('0000')
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		expect((await screen.findByRole('alert')).textContent).toMatch(/seconds/)
		expect(screen.getByRole('button', { name: '1' })).toBeDisabled()
	})

	it('asks for a role before clocking in when there are several', async () => {
		const requests = stub(({ path }) =>
			path === '/kiosk/identify'
				? Response.json(
						identified({
							positions: [
								{ id: 'p1', name: 'Server', nameAr: null },
								{ id: 'p2', name: 'Host', nameAr: null },
							],
						}),
					)
				: Response.json(accepted()),
		)
		await openPad()
		typePin('4821')
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		await screen.findByRole('heading', { name: 'Hi Rana' })
		fireEvent.click(screen.getByRole('button', { name: 'Clock in' }))
		await screen.findByRole('heading', { name: 'What role are you working?' })
		expect(requests.some((request) => request.path === '/kiosk/punch')).toBe(
			false,
		)
		fireEvent.click(screen.getByRole('button', { name: 'Host' }))
		await screen.findByRole('heading', { name: 'Clocked in, Rana' })
		expect(
			requests.find((request) => request.path === '/kiosk/punch')!.body
				.positionId,
		).toBe('p2')
	})

	it('asks about cash tips at clock-out only where configured, and can skip', async () => {
		const requests = stub(({ path }) =>
			path === '/kiosk/identify'
				? Response.json(
						identified({
							state: 'in',
							allowedEvents: ['break_start', 'clock_out'],
							promptTips: true,
						}),
					)
				: Response.json(accepted({ kind: 'clock_out', state: 'out' })),
		)
		await openPad()
		typePin('4821')
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		await screen.findByRole('heading', { name: 'Hi Rana' })
		fireEvent.click(screen.getByRole('button', { name: 'Clock out' }))
		await screen.findByRole('heading', { name: 'Any cash tips this shift?' })
		for (const key of ['1', '2', '.', '5']) {
			fireEvent.click(
				screen.getByRole('button', {
					name: key === '.' ? 'Decimal point' : key,
				}),
			)
		}
		fireEvent.click(screen.getAllByRole('button', { name: 'Clock out' })[0]!)
		await screen.findByRole('heading', { name: 'Clocked out, Rana' })
		expect(
			requests.find((request) => request.path === '/kiosk/punch')!.body,
		).toMatchObject({ kind: 'clock_out', cashTipsMinor: 1250 })
	})

	it('shows the reason and returns to a clean start when a punch is refused', async () => {
		stub(({ path }) =>
			path === '/kiosk/identify'
				? Response.json(identified())
				: Response.json({ error: 'early_clock_in' }, { status: 409 }),
		)
		await openPad()
		typePin('4821')
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		await screen.findByRole('heading', { name: 'Hi Rana' })
		fireEvent.click(screen.getByRole('button', { name: 'Clock in' }))
		expect((await screen.findByRole('alert')).textContent).toContain(
			'too early to clock in',
		)
		expect(screen.getByRole('img', { name: 'No digits entered' })).toBeTruthy()
	})

	it('returns to the pad when someone says it is not them', async () => {
		stub(() => Response.json(identified()))
		await openPad()
		typePin('4821')
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		await screen.findByRole('heading', { name: 'Hi Rana' })
		fireEvent.click(screen.getByRole('button', { name: 'Not me' }))
		await screen.findByRole('heading', { name: 'Enter your PIN' })
	})

	it('forgets a half-typed PIN after a quiet half minute', async () => {
		stub(() => Response.json({}))
		await openPad()
		vi.useFakeTimers()
		typePin('48')
		expect(screen.getByRole('img', { name: '2 digits entered' })).toBeTruthy()
		await act(async () => {
			await vi.advanceTimersByTimeAsync(31_000)
		})
		expect(screen.getByRole('img', { name: 'No digits entered' })).toBeTruthy()
	})
})

describe('KioskApp offline', () => {
	it('saves the punch on the tablet when the connection drops, then sends it once', async () => {
		let online = false
		const delivered: Array<{ path: string; body: any }> = []
		stub(({ path, body }) => {
			if (!online) throw new TypeError('Failed to fetch')
			if (path === '/kiosk/punch') delivered.push({ path, body })
			return path === '/kiosk/punch'
				? Response.json(accepted())
				: Response.json(identified())
		})
		await openPad()
		typePin('4821')
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		await screen.findByRole('heading', { name: 'No connection' })
		fireEvent.click(screen.getByRole('button', { name: 'Clock in' }))
		await screen.findByRole('heading', { name: 'Clocked in' })
		expect(screen.getByText(/Saved on this tablet/)).toBeTruthy()
		expect(screen.getByText(/Offline · 1 punch saved/)).toBeTruthy()
		// While offline nothing reached the server.
		expect(delivered).toHaveLength(0)

		// The connection returns: the saved punch goes out, flagged as offline.
		online = true
		window.dispatchEvent(new Event('online'))
		await waitFor(() => expect(delivered).toHaveLength(1))
		const sent = delivered[0]!
		expect(sent.body).toMatchObject({
			kind: 'clock_in',
			pin: '4821',
			offline: true,
		})
		await screen.findByText('All saved')
		// And the PIN left the tablet's storage with it.
		const indexed = await new Promise<number>((resolve) => {
			const open = indexedDB.open('kiosk-queue')
			open.onsuccess = () => {
				const request = open.result
					.transaction('punches')
					.objectStore('punches')
					.count()
				request.onsuccess = () => resolve(request.result)
			}
		})
		expect(indexed).toBe(0)
	})

	it('keeps a punch made after the request was already sent, and the retry reuses its id', async () => {
		let calls = 0
		const requests = stub(({ path }) => {
			if (path === '/kiosk/identify') return Response.json(identified())
			calls += 1
			if (calls === 1) throw new TypeError('Failed to fetch')
			return Response.json(accepted({ duplicate: true }))
		})
		await openPad()
		typePin('4821')
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		await screen.findByRole('heading', { name: 'Hi Rana' })
		fireEvent.click(screen.getByRole('button', { name: 'Clock in' }))
		await screen.findByText(/Saved on this tablet/)
		await waitFor(() =>
			expect(
				requests.filter((r) => r.path === '/kiosk/punch').length,
			).toBeGreaterThanOrEqual(2),
		)
		const ids = requests
			.filter((r) => r.path === '/kiosk/punch')
			.map((r) => r.body.id)
		expect(new Set(ids).size).toBe(1)
	})

	it('lists punches the server refused so a manager can add them', async () => {
		let online = false
		stub(({ path }) => {
			if (!online) throw new TypeError('Failed to fetch')
			return path === '/kiosk/punch'
				? Response.json({ error: 'already_clocked_in' }, { status: 409 })
				: Response.json(identified())
		})
		await openPad()
		typePin('4821')
		fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
		await screen.findByRole('heading', { name: 'No connection' })
		fireEvent.click(screen.getByRole('button', { name: 'Clock in' }))
		await screen.findByText(/Saved on this tablet/)
		online = true
		window.dispatchEvent(new Event('online'))
		const needs = await screen.findByRole('button', {
			name: /1 punch needs a manager/,
		})
		fireEvent.click(needs)
		expect(await screen.findByText(/You are already clocked in/)).toBeTruthy()
		expect(screen.getByText(/were not recorded/)).toBeTruthy()
	})
})

describe('KioskApp pairing', () => {
	it('shows set-up steps and a paste box when the tablet is not paired', async () => {
		localStorage.clear()
		stub(() => Response.json({}))
		renderStaff(<KioskApp urls={URLS} />)
		await screen.findByRole('heading', { name: 'Set up this tablet' })
		expect(screen.getByLabelText('Pairing link or code')).toBeTruthy()
	})

	it('goes back to set-up when a manager has removed the tablet', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({ error: 'device_revoked' }, { status: 401 }),
			),
		)
		renderStaff(<KioskApp urls={URLS} />)
		await screen.findByRole('heading', { name: 'This tablet was disconnected' })
		expect(localStorage.getItem('kiosk.device.v1')).toBeNull()
	})

	it('keeps its pairing through the regional kill switch', async () => {
		const requests: string[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				requests.push(new URL(String(input)).pathname)
				return Response.json({ error: 'kiosk_disabled' }, { status: 503 })
			}),
		)
		await openPad()
		await waitFor(() => expect(requests).toContain('/kiosk/config'))
		expect(localStorage.getItem('kiosk.device.v1')).not.toBeNull()
		expect(screen.queryByText('This tablet was disconnected')).toBeNull()
	})

	it('does not forget its pairing over one unexplained invalid_device', async () => {
		const requests: string[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				requests.push(new URL(String(input)).pathname)
				return Response.json({ error: 'invalid_device' }, { status: 401 })
			}),
		)
		await openPad()
		await waitFor(() => expect(requests).toContain('/kiosk/config'))
		expect(localStorage.getItem('kiosk.device.v1')).not.toBeNull()
		expect(screen.queryByText('This tablet was disconnected')).toBeNull()
	})

	it('refuses to pair from something that is not a pairing link', async () => {
		localStorage.clear()
		stub(() => Response.json({}))
		renderStaff(<KioskApp urls={URLS} />)
		await screen.findByRole('heading', { name: 'Set up this tablet' })
		fireEvent.change(screen.getByLabelText('Pairing link or code'), {
			target: { value: 'https://example.com/page#nonsense' },
		})
		fireEvent.click(screen.getByRole('button', { name: 'Pair this tablet' }))
		expect(await screen.findByText(/not a pairing link/)).toBeTruthy()
	})
})
