// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { ReprintButtons } from './reprint-buttons.tsx'

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

function stub(queued: number) {
	const bodies: unknown[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
			const url = typeof input === 'string' ? input : input.toString()
			if (url.includes('/orders-token')) {
				return Response.json({ jwt: 't', tenantApiUrl: 'https://api.example.com' })
			}
			if (url.endsWith('/operator/pos/printers/reprint')) {
				bodies.push(JSON.parse(String(init.body)))
				return Response.json({ queued, printers: 1 }, { status: 202 })
			}
			return new Response('no', { status: 404 })
		}),
	)
	return bodies
}

describe('Reprint on an order (#117)', () => {
	it('sends the kitchen ticket to the location\'s printers, one request id per press', async () => {
		const bodies = stub(1)
		const user = userEvent.setup()
		renderStaff(<ReprintButtons orgSlug="acme" orderId="o1" locationId="loc1" />)
		await user.click(screen.getByRole('button', { name: 'Reprint kitchen ticket' }))
		await waitFor(() => expect(screen.getByTestId('order-reprint-result')).toHaveTextContent('Sent to the printer.'))
		await user.click(screen.getByRole('button', { name: 'Reprint kitchen ticket' }))
		await waitFor(() => expect(bodies).toHaveLength(2))
		const [first, second] = bodies as Array<{ requestId: string; kind: string; source: string }>
		expect(first).toMatchObject({ source: 'online', kind: 'kitchen' })
		expect(first!.requestId).not.toBe(second!.requestId)
	})

	it('says so when no printer takes the ticket', async () => {
		stub(0)
		const user = userEvent.setup()
		renderStaff(<ReprintButtons orgSlug="acme" orderId="o1" locationId="loc1" />)
		await user.click(screen.getByRole('button', { name: 'Reprint receipt' }))
		await waitFor(() =>
			expect(screen.getByTestId('order-reprint-result')).toHaveTextContent('No printer at this location'),
		)
	})
})
