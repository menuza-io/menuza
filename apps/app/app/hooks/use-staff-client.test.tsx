// @vitest-environment jsdom

import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import { useStaffClient, useStaffQuery } from './use-staff-client.ts'

afterEach(() => {
	vi.unstubAllGlobals()
})

function tokenBody(grants: string[]) {
	return {
		jwt: 'jwt-1',
		tenantApiUrl: 'https://us.tenant.test',
		scope: 'staff',
		grants,
		expiresAt: Date.now() + 10 * 60_000,
	}
}

function Probe() {
	const { can, ready, unavailable } = useStaffClient('staff')
	return (
		<p data-testid="probe">
			{unavailable
				? 'unavailable'
				: !ready
					? 'loading'
					: `pay:${can(P.READ_STAFF_PAY)} write:${can(P.UPDATE_STAFF)} read:${can(P.READ_STAFF)}`}
		</p>
	)
}

describe('useStaffClient', () => {
	it('reports exactly the grants the token carries, so pay UI stays hidden without them', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json(tokenBody(['read:staff:any', 'update:staff:any'])),
			),
		)
		render(
			<StaffClientProvider orgSlug="acme">
				<Probe />
			</StaffClientProvider>,
		)
		expect(screen.getByTestId('probe').textContent).toBe('loading')
		await waitFor(() =>
			expect(screen.getByTestId('probe').textContent).toBe(
				'pay:false write:true read:true',
			),
		)
	})

	it('lets an update grant satisfy the matching read', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json(tokenBody(['update:staff_pay:any']))),
		)
		render(
			<StaffClientProvider orgSlug="acme">
				<Probe />
			</StaffClientProvider>,
		)
		await waitFor(() =>
			expect(screen.getByTestId('probe').textContent).toContain('pay:true'),
		)
	})

	it('says unavailable when no token can be minted', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('no', { status: 404 })),
		)
		render(
			<StaffClientProvider orgSlug="acme">
				<Probe />
			</StaffClientProvider>,
		)
		await waitFor(() =>
			expect(screen.getByTestId('probe').textContent).toBe('unavailable'),
		)
	})

	it('shares one token between components of the same layout', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes('/staff/token')) {
				return Response.json(tokenBody(['read:staff:any']))
			}
			return Response.json({ items: [] })
		})
		vi.stubGlobal('fetch', fetchMock)
		render(
			<StaffClientProvider orgSlug="acme">
				<Probe />
				<Probe />
			</StaffClientProvider>,
		)
		await waitFor(() =>
			expect(screen.getAllByTestId('probe')[1]!.textContent).toContain(
				'read:true',
			),
		)
		const mints = fetchMock.mock.calls.filter(([url]) =>
			String(url).includes('/staff/token'),
		)
		expect(mints).toHaveLength(1)
	})
})

describe('useStaffQuery', () => {
	function List({ path }: { path: string | null }) {
		const { client } = useStaffClient('staff')
		const query = useStaffQuery(
			client,
			path,
			z.object({ items: z.array(z.string()) }),
		)
		return (
			<p data-testid="list">
				{query.loading
					? 'loading'
					: query.error
						? `error:${query.error.message}`
						: (query.data?.items ?? []).join(',')}
			</p>
		)
	}

	it('parses the response and rejects a malformed one', async () => {
		let body: unknown = { items: ['a', 'b'] }
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).includes('/staff/token')
					? Response.json(tokenBody(['read:staff:any']))
					: Response.json(body),
			),
		)
		const { unmount } = render(
			<StaffClientProvider orgSlug="acme">
				<List path="/" />
			</StaffClientProvider>,
		)
		await waitFor(() =>
			expect(screen.getByTestId('list').textContent).toBe('a,b'),
		)
		unmount()

		body = { items: 'nope' }
		render(
			<StaffClientProvider orgSlug="acme">
				<List path="/" />
			</StaffClientProvider>,
		)
		await waitFor(() =>
			expect(screen.getByTestId('list').textContent).toBe(
				'error:malformed_response',
			),
		)
	})

	it('waits while the path is null', async () => {
		const fetchMock = vi.fn(async () => Response.json(tokenBody([])))
		vi.stubGlobal('fetch', fetchMock)
		render(
			<StaffClientProvider orgSlug="acme">
				<List path={null} />
			</StaffClientProvider>,
		)
		expect(screen.getByTestId('list').textContent).toBe('')
	})
})
