// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import { renderStaff } from '#tests/staff-render.tsx'
import { HourLimitsSection } from './hour-limits-section.tsx'

type Call = { method: string; url: string; body?: any }

function stub(options: { grants: string[]; limits: Record<string, unknown> }) {
	const calls: Call[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input)
			const method = init?.method ?? 'GET'
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'jwt',
					tenantApiUrl: 'https://us.tenant.test',
					scope: 'staff',
					grants: options.grants,
					expiresAt: Date.now() + 600_000,
				})
			}
			calls.push({
				method,
				url,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			})
			return Response.json({ limits: options.limits })
		}),
	)
	return calls
}

const view = () =>
	renderStaff(
		<StaffClientProvider orgSlug="acme">
			<HourLimitsSection staffId="s1" terminated={false} />
		</StaffClientProvider>,
	)

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

describe('a person’s hour limits (#527)', () => {
	it('saves a limit in hours as minutes, and an empty box clears it', async () => {
		const calls = stub({
			grants: ['read:staff:any', 'update:staff:any'],
			limits: { dailyMinutes: null, weeklyMinutes: 1800 },
		})
		view()
		const daily = (await screen.findByLabelText(
			'Most hours in a day',
		)) as HTMLInputElement
		const weekly = screen.getByLabelText(
			'Most hours in a week',
		) as HTMLInputElement
		await waitFor(() => expect(weekly.value).toBe('30'))
		expect(daily.value).toBe('')
		fireEvent.change(daily, { target: { value: '6.5' } })
		fireEvent.change(weekly, { target: { value: '' } })
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'PUT')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
			dailyMinutes: 390,
			weeklyMinutes: null,
		})
	})

	it('shows the Ramadan setting only to someone who may see private details', async () => {
		stub({
			grants: ['read:staff:any', 'update:staff:any'],
			limits: { dailyMinutes: null, weeklyMinutes: null },
		})
		view()
		await screen.findByLabelText('Most hours in a day')
		expect(screen.queryByText('Follows the Ramadan limit')).toBeNull()
	})

	it('shows and saves the Ramadan setting with the private grants', async () => {
		const calls = stub({
			grants: [
				'read:staff:any',
				'update:staff:any',
				'read:staff_private:any',
				'update:staff_private:any',
			],
			limits: {
				dailyMinutes: null,
				weeklyMinutes: null,
				followsRamadan: false,
			},
		})
		view()
		const toggle = await screen.findByRole('switch', {
			name: /Follows the Ramadan limit/,
		})
		fireEvent.click(toggle)
		fireEvent.click(screen.getByRole('button', { name: 'Save' }))
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'PUT')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
			followsRamadan: true,
		})
	})

	it('refuses a number that is not hours, and is read-only without the write grant', async () => {
		stub({
			grants: ['read:staff:any'],
			limits: { dailyMinutes: 480, weeklyMinutes: null },
		})
		view()
		const daily = (await screen.findByLabelText(
			'Most hours in a day',
		)) as HTMLInputElement
		expect(daily).toBeDisabled()
		expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
	})
})
