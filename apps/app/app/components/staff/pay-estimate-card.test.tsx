// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import { renderStaff } from '#tests/staff-render.tsx'
import { PayEstimateCard } from './pay-estimate-card.tsx'

type Call = { method: string; url: string; body?: any }

function stub(options: { grants?: string[]; on?: boolean }) {
	const calls: Call[] = []
	let on = options.on ?? false
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			const method = init?.method ?? 'GET'
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'jwt',
					tenantApiUrl: 'https://us.tenant.test',
					scope: 'schedule',
					grants: options.grants ?? [
						'read:schedule:any',
						'update:schedule:any',
					],
					expiresAt: Date.now() + 600_000,
				})
			}
			const body = init?.body ? JSON.parse(String(init.body)) : undefined
			calls.push({ method, url, body })
			if (method === 'PUT') on = body.showStaffPayEstimate
			return Response.json({
				minRestMinutes: 480,
				timeOffMinNoticeDays: 0,
				showStaffPayEstimate: on,
				updatedAt: null,
			})
		}),
	)
	return calls
}

const view = (canEdit = true) =>
	renderStaff(
		<StaffClientProvider orgSlug="acme">
			<PayEstimateCard canEdit={canEdit} />
		</StaffClientProvider>,
	)

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

describe('pay estimate for staff (#514)', () => {
	it('is off until turned on, and turning it on is saved', async () => {
		const calls = stub({})
		view()
		const toggle = await screen.findByRole('switch', {
			name: /Show staff an estimate of their pay/,
		})
		expect(toggle.getAttribute('aria-checked')).toBe('false')
		fireEvent.click(toggle)
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'PUT')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
			showStaffPayEstimate: true,
		})
	})

	it('cannot be changed without access to every workplace or the schedule grant', async () => {
		stub({})
		view(false)
		const toggle = await screen.findByRole('switch', {
			name: /Show staff an estimate of their pay/,
		})
		expect(
			(toggle as HTMLButtonElement).disabled ||
				toggle.getAttribute('aria-disabled') === 'true',
		).toBe(true)
	})

	it('is not shown to someone who cannot read the schedule settings', async () => {
		stub({ grants: ['read:staff:any'] })
		view()
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(screen.queryByText('Pay estimate for staff')).toBeNull()
	})
})
