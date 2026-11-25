// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { PrintersManager } from './printers-manager.tsx'

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

const API = 'https://api-us.example.com'
const locations = [{ id: 'loc1', name: 'Downtown' }]

function printer(over: Record<string, unknown> = {}) {
	return {
		id: 'p1',
		ref: 'org_1.p1',
		locationId: 'loc1',
		name: 'Kitchen printer',
		protocol: 'star_cloudprnt',
		widthMm: 80,
		copies: 1,
		routes: { kitchen: 'all', stationIds: [], receipts: false, isDefault: false, deliveryAddress: false, arabicFont: false },
		health: 'online',
		lastSeenAt: Date.now() - 10_000,
		lastTestAt: null,
		lastTestResult: null,
		flaggedJobs: 0,
		...over,
	}
}

type Call = { url: string; method: string; body: unknown }

function stubApi(options: {
	printers?: unknown[]
	testResponse?: () => Response
	jobs?: Array<{ status: string; reason: string | null }>
}) {
	const calls: Call[] = []
	let jobIndex = 0
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
			const url = typeof input === 'string' ? input : input.toString()
			const method = init.method ?? 'GET'
			calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined })
			if (url.includes('/orders-token')) {
				return Response.json({ jwt: 'token', tenantApiUrl: API })
			}
			if (url === `${API}/operator/pos/printers` && method === 'GET') {
				return Response.json({
					printers: options.printers ?? [],
					enabled: true,
					killSwitch: false,
				})
			}
			if (url.endsWith('/test') && method === 'POST') {
				return options.testResponse?.() ?? Response.json({ jobId: 'job1' }, { status: 202 })
			}
			if (url.includes('/jobs/job1')) {
				const job = options.jobs?.[Math.min(jobIndex++, options.jobs.length - 1)] ?? { status: 'printed', reason: null }
				return Response.json({ job })
			}
			if (url.includes('/kds-stations')) return Response.json({ stations: [{ id: 'grill', name: 'Grill' }] })
			if (url === `${API}/operator/pos/printers` && method === 'POST') {
				return Response.json(
					{ printer: printer({ id: 'p2', ref: 'org_1.p2', name: 'Bar', health: 'never_seen', lastSeenAt: null }), password: 'A'.repeat(32) },
					{ status: 201 },
				)
			}
			return new Response('nope', { status: 404 })
		}),
	)
	return calls
}

describe('Settings, Terminals, Printers (#117, #426)', () => {
	it('shows nothing while the organization does not have cloud printers', () => {
		stubApi({})
		renderStaff(<PrintersManager orgSlug="acme" canWrite enabled={false} locations={locations} />)
		expect(screen.queryByTestId('printers-manager')).toBeNull()
	})

	it('shows each printer with its status and what it prints', async () => {
		stubApi({ printers: [printer(), printer({ id: 'p3', name: 'Bar', health: 'out_of_paper' })] })
		renderStaff(<PrintersManager orgSlug="acme" canWrite enabled locations={locations} />)
		await waitFor(() => expect(screen.getAllByTestId('printer-row')).toHaveLength(2))
		const health = screen.getAllByTestId('printer-health')
		expect(health[0]).toHaveTextContent('Online')
		expect(health[1]).toHaveTextContent('Out of paper')
		expect(screen.getAllByText(/All kitchen tickets/)).toHaveLength(2)
	})

	it('says a disconnected printer cannot print, with the reason from the node', async () => {
		stubApi({
			printers: [printer({ health: 'online' })],
			testResponse: () =>
				Response.json(
					{ error: 'printer_not_ready', reason: 'offline', message: 'x' },
					{ status: 409 },
				),
		})
		const user = userEvent.setup()
		renderStaff(<PrintersManager orgSlug="acme" canWrite enabled locations={locations} />)
		await screen.findByTestId('printer-row')
		await user.click(screen.getByRole('button', { name: 'Print a test ticket' }))
		const notice = await screen.findByTestId('printer-notice')
		expect(notice).toHaveTextContent(/disconnected/i)
		expect(notice).toHaveTextContent(/power and network/)
	})

	it('reports a test ticket as printed once the printer confirms it', async () => {
		stubApi({ printers: [printer()], jobs: [{ status: 'printed', reason: null }] })
		const user = userEvent.setup()
		renderStaff(<PrintersManager orgSlug="acme" canWrite enabled locations={locations} />)
		await screen.findByTestId('printer-row')
		await user.click(screen.getByRole('button', { name: 'Print a test ticket' }))
		await waitFor(
			() => expect(screen.getByTestId('printer-notice')).toHaveTextContent('The test ticket printed.'),
			{ timeout: 5000 },
		)
	})

	it('names the reason when the printer cannot do it', async () => {
		stubApi({ printers: [printer()], jobs: [{ status: 'offered', reason: 'unsupported' }] })
		const user = userEvent.setup()
		renderStaff(<PrintersManager orgSlug="acme" canWrite enabled locations={locations} />)
		await screen.findByTestId('printer-row')
		await user.click(screen.getByRole('button', { name: 'Open drawer' }))
		await waitFor(
			() => expect(screen.getByTestId('printer-notice')).toHaveTextContent(/does not support/),
			{ timeout: 5000 },
		)
	})

	it('warns about tickets that were never confirmed', async () => {
		stubApi({ printers: [printer({ flaggedJobs: 2 })] })
		renderStaff(<PrintersManager orgSlug="acme" canWrite enabled locations={locations} />)
		expect(await screen.findByTestId('printer-flagged')).toHaveTextContent('2 ticket(s) did not print')
	})

	it('adds a printer and shows its address and password once', async () => {
		const calls = stubApi({ printers: [] })
		const user = userEvent.setup()
		renderStaff(<PrintersManager orgSlug="acme" canWrite enabled locations={locations} />)
		await user.click(await screen.findByRole('button', { name: 'Add a printer' }))
		await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Bar')
		await user.click(screen.getByRole('button', { name: 'Add printer' }))
		expect(await screen.findByTestId('printer-url')).toHaveTextContent(`${API}/print/org_1.p2/poll`)
		expect(screen.getByTestId('printer-password')).toHaveTextContent('A'.repeat(32))
		const created = calls.find((c) => c.method === 'POST' && c.url === `${API}/operator/pos/printers`)!
		expect(created.body).toMatchObject({ locationId: 'loc1', name: 'Bar', protocol: 'star_cloudprnt', widthMm: 80 })
	})

	it('hides every change for a member who may only look', async () => {
		stubApi({ printers: [printer()] })
		renderStaff(<PrintersManager orgSlug="acme" canWrite={false} enabled locations={locations} />)
		await screen.findByTestId('printer-row')
		expect(screen.queryByRole('button', { name: 'Add a printer' })).toBeNull()
		expect(screen.queryByRole('button', { name: 'Print a test ticket' })).toBeNull()
	})
})
