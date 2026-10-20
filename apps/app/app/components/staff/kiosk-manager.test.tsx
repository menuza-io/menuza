// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import { renderStaff } from '#tests/staff-render.tsx'
import { KioskManager } from './kiosk-manager.tsx'

afterEach(() => {
	vi.unstubAllGlobals()
})

type Call = { url: string; method: string; body: unknown }

const NOW = Date.now()
const CODE = `kpc1.org_1.${'a'.repeat(43)}`

function device(overrides: Record<string, unknown> = {}) {
	return {
		id: 'd1',
		scopeId: 'loc-1',
		name: 'Front counter',
		identifyMode: 'pin',
		showNextShifts: false,
		pairedAt: NOW - 86_400_000,
		lastSeenAt: NOW - 2 * 60_000,
		revokedAt: null,
		status: 'active',
		backoffSeconds: 0,
		failuresLastHour: 0,
		...overrides,
	}
}

function stubApi(
	options: {
		devices?: unknown[]
		codes?: unknown[]
		grants?: string[]
		createError?: Response
	} = {},
) {
	const calls: Call[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'jwt',
					tenantApiUrl: 'https://us.tenant.test',
					scope: 'timeclock',
					grants: options.grants ?? [
						'read:labor_policy:any',
						'update:labor_policy:any',
					],
					expiresAt: Date.now() + 600_000,
				})
			}
			const call: Call = {
				url,
				method: init?.method ?? 'GET',
				body: init?.body ? JSON.parse(String(init.body)) : null,
			}
			calls.push(call)
			if (url.endsWith('/kiosk/devices') && call.method === 'GET') {
				return Response.json({ devices: options.devices ?? [] })
			}
			if (url.endsWith('/kiosk/pairing-codes') && call.method === 'GET') {
				return Response.json({ codes: options.codes ?? [] })
			}
			if (url.endsWith('/kiosk/pairing-codes') && call.method === 'POST') {
				if (options.createError) return options.createError
				return Response.json(
					{
						id: 'c1',
						code: CODE,
						expiresAt: Date.now() + 600_000,
						scopeId: (call.body as { scopeId: string }).scopeId,
						deviceName: (call.body as { deviceName: string }).deviceName,
						fragment: `#r=us&c=${CODE}`,
					},
					{ status: 201 },
				)
			}
			return Response.json({ ok: true })
		}),
	)
	return calls
}

/**
 * Mutations refresh the lists when they land, and those refreshes are
 * fire-and-forget: wait for them before the test ends. A refresh GET that
 * slips out after the test runs on MSW's fetch again (the stub is gone), and
 * its unhandled-request warning fails the whole run.
 */
async function waitForListReload(
	calls: Call[],
	path: '/kiosk/devices' | '/kiosk/pairing-codes',
) {
	await waitFor(() =>
		expect(
			calls.filter((call) => call.method === 'GET' && call.url.endsWith(path))
				.length,
		).toBeGreaterThan(1),
	)
}

const scopes = [{ id: 'loc-1', name: 'Downtown', timeZone: 'America/Chicago' }]

function view(props: Partial<Parameters<typeof KioskManager>[0]> = {}) {
	return renderStaff(
		<StaffClientProvider orgSlug="acme">
			<KioskManager scopes={scopes} {...props} />
		</StaffClientProvider>,
	)
}

describe('KioskManager', () => {
	it('lists tablets with how they sign in and when they were last seen', async () => {
		stubApi({
			devices: [
				device(),
				device({
					id: 'd2',
					name: 'Floor',
					identifyMode: 'pick_name',
					lastSeenAt: null,
				}),
			],
		})
		view()
		await screen.findByText('Front counter')
		expect(screen.getByText('Enter PIN')).toBeTruthy()
		expect(screen.getByText('Pick name, then PIN')).toBeTruthy()
		expect(screen.getByText('Seen 2 minutes ago')).toBeTruthy()
		expect(screen.getByText('Not seen yet')).toBeTruthy()
	})

	it('warns when PIN attempts are paused on a tablet', async () => {
		stubApi({ devices: [device({ backoffSeconds: 60, failuresLastHour: 7 })] })
		view()
		expect(await screen.findByText('PIN attempts paused')).toBeTruthy()
	})

	it('moves removed tablets out of the way', async () => {
		stubApi({
			devices: [
				device(),
				device({
					id: 'd9',
					name: 'Old tablet',
					status: 'revoked',
					revokedAt: NOW,
				}),
			],
		})
		view()
		await screen.findByText('Front counter')
		expect(screen.getByText(/Removed tablets \(1\)/)).toBeTruthy()
	})

	it('teaches the first step when nothing is paired', async () => {
		stubApi()
		view()
		await screen.findByText('No tablets paired yet')
		expect(
			screen.getAllByRole('button', { name: 'Pair a tablet' }).length,
		).toBeGreaterThan(0)
	})

	it('creates a pairing code with the workplace facts and shows a link whose code is in the fragment', async () => {
		const calls = stubApi()
		view()
		fireEvent.click(
			(await screen.findAllByRole('button', { name: 'Pair a tablet' }))[0]!,
		)
		const dialog = await screen.findByRole('dialog')
		fireEvent.change(within(dialog).getByLabelText('Tablet name'), {
			target: { value: 'Pass' },
		})
		fireEvent.click(
			within(dialog).getByRole('button', { name: 'Create pairing code' }),
		)
		const link = (await within(dialog).findByLabelText(
			'Pairing link',
		)) as HTMLInputElement
		const url = new URL(link.value)
		expect(url.pathname).toBe('/kiosk/pair')
		expect(url.search).toBe('')
		expect(url.hash).toContain(encodeURIComponent(CODE))
		const post = calls.find((call) => call.method === 'POST')!
		expect(post.body).toEqual({
			scopeId: 'loc-1',
			deviceName: 'Pass',
			identifyMode: 'pin',
			showNextShifts: false,
			timeZone: 'America/Chicago',
			scopeName: 'Downtown',
		})
		expect(
			within(dialog).getByText(/Expires in 9:5|Expires in 10:00/),
		).toBeTruthy()
		// The pairing step polls the pending list; an empty list reads as "the
		// code was used", which refreshes both lists. Let that land here.
		await waitForListReload(calls, '/kiosk/pairing-codes')
		await waitForListReload(calls, '/kiosk/devices')
	})

	it('asks for a name before creating anything', async () => {
		const calls = stubApi()
		view()
		fireEvent.click(
			(await screen.findAllByRole('button', { name: 'Pair a tablet' }))[0]!,
		)
		const dialog = await screen.findByRole('dialog')
		fireEvent.click(
			within(dialog).getByRole('button', { name: 'Create pairing code' }),
		)
		expect(
			await within(dialog).findByText(/Give the tablet a name/),
		).toBeTruthy()
		expect(calls.some((call) => call.method === 'POST')).toBe(false)
	})

	it('explains why a code could not be made', async () => {
		stubApi({
			createError: Response.json(
				{ error: 'too_many_pending_codes' },
				{ status: 409 },
			),
		})
		view()
		fireEvent.click(
			(await screen.findAllByRole('button', { name: 'Pair a tablet' }))[0]!,
		)
		const dialog = await screen.findByRole('dialog')
		fireEvent.change(within(dialog).getByLabelText('Tablet name'), {
			target: { value: 'Pass' },
		})
		fireEvent.click(
			within(dialog).getByRole('button', { name: 'Create pairing code' }),
		)
		expect((await within(dialog).findByRole('alert')).textContent).toMatch(
			/several unused pairing codes/,
		)
	})

	it('removes a tablet only after a confirmation that says what happens', async () => {
		const calls = stubApi({ devices: [device()] })
		view()
		fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
		const confirm = await screen.findByRole('alertdialog')
		expect(within(confirm).getByText(/stops working right away/)).toBeTruthy()
		expect(calls.some((call) => call.url.endsWith('/revoke'))).toBe(false)
		fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }))
		await waitFor(() =>
			expect(
				calls.find((call) => call.url.endsWith('/kiosk/devices/d1/revoke'))
					?.method,
			).toBe('POST'),
		)
		// Removing a tablet refreshes the device list; wait for that round trip.
		await waitForListReload(calls, '/kiosk/devices')
	})

	it('keeping a tablet sends nothing', async () => {
		const calls = stubApi({ devices: [device()] })
		view()
		fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
		fireEvent.click(await screen.findByRole('button', { name: 'Keep it' }))
		expect(calls.some((call) => call.method === 'POST')).toBe(false)
	})

	it('lists unused pairing codes and lets a manager cancel one', async () => {
		const calls = stubApi({
			devices: [device()],
			codes: [
				{
					id: 'c9',
					scopeId: 'loc-1',
					deviceName: 'Bar tablet',
					identifyMode: 'pin',
					showNextShifts: false,
					expiresAt: NOW + 5 * 60_000,
					createdAt: NOW - 60_000,
				},
			],
		})
		view()
		await screen.findByText('Bar tablet')
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
		await waitFor(() =>
			expect(calls.find((call) => call.method === 'DELETE')?.url).toMatch(
				/pairing-codes\/c9$/,
			),
		)
		// Cancelling a code refreshes the pending list; wait for that round trip.
		await waitForListReload(calls, '/kiosk/pairing-codes')
	})

	it('is read-only without the update grant', async () => {
		stubApi({ devices: [device()], grants: ['read:labor_policy:any'] })
		view()
		await screen.findByText('Front counter')
		expect(screen.queryByRole('button', { name: 'Pair a tablet' })).toBeNull()
		expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
		expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
		cleanup()
	})
})
