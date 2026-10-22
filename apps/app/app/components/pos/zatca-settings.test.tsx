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
import { ZatcaSettings } from './zatca-settings.tsx'

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

const settings = {
	environment: 'sandbox',
	sellerName: 'Al Hara Kitchen',
	vatNumber: '399999999900003',
	crNumber: '1010010000',
	street: 'Prince Sultan',
	buildingNumber: '2322',
	district: 'Al-Murabba',
	city: 'Riyadh',
	postalCode: '23333',
	businessCategory: 'Restaurant',
	branchName: 'Riyadh Branch',
}

function stubApi(
	options: {
		settings?: typeof settings | null
		units?: unknown[]
		submissions?: Record<string, number>
	} = {},
) {
	const calls: Array<{ url: string; method: string; body: unknown }> = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
			const url = typeof input === 'string' ? input : input.toString()
			const method = init.method ?? 'GET'
			calls.push({
				url,
				method,
				body: init.body ? JSON.parse(String(init.body)) : undefined,
			})
			if (url.includes('/orders-token'))
				return Response.json({
					jwt: 'token',
					tenantApiUrl: 'https://api.example.com',
				})
			if (url.endsWith('/operator/pos/zatca') && method === 'GET') {
				return Response.json({
					settings: options.settings ?? null,
					units: options.units ?? [],
					submissions: options.submissions ?? {},
				})
			}
			if (url.endsWith('/operator/pos/terminals')) {
				return Response.json({
					devices: [
						{
							id: 'd1',
							label: 'Front counter',
							terminalCode: 'T1',
							revokedAt: null,
						},
					],
					pendingCodes: [],
				})
			}
			if (url.endsWith('/operator/pos/zatca/submissions?status=rejected')) {
				return Response.json({
					submissions: [
						{
							docId: 'x',
							kind: 'invoice',
							counter: 7,
							lastError: 'BR-KSA-37: bad building number',
							terminalCode: 'T1',
						},
					],
				})
			}
			return Response.json({ ok: true })
		}),
	)
	return calls
}

describe('ZatcaSettings', () => {
	it('groups seller identity and address fields and preserves read-only access', async () => {
		stubApi({ settings })
		renderStaff(<ZatcaSettings orgSlug="joes" canWrite={false} />)
		const identity = await screen.findByRole('group', {
			name: 'Seller details',
		})
		const address = screen.getByRole('group', { name: 'Address' })
		expect(within(identity).getByLabelText('Legal name')).toBeDisabled()
		expect(
			within(identity).getByRole('combobox', { name: 'Environment' }),
		).toBeDisabled()
		expect(within(address).getByLabelText('Street')).toBeDisabled()
		expect(within(identity).queryByLabelText('Street')).toBeNull()
		expect(
			screen.queryByRole('button', { name: 'Save seller details' }),
		).toBeNull()
	})

	it('saves the seller details as entered', async () => {
		const calls = stubApi()
		renderStaff(<ZatcaSettings orgSlug="joes" canWrite />)
		const form = await screen.findByRole('form', { name: 'Seller details' })
		for (const [label, value] of [
			['Legal name', settings.sellerName],
			['Branch name', settings.branchName],
			['VAT number', settings.vatNumber],
			['Commercial registration number', settings.crNumber],
			['Street', settings.street],
			['Building number', settings.buildingNumber],
			['District', settings.district],
			['City', settings.city],
			['Postal code', settings.postalCode],
			['Business category', settings.businessCategory],
		] as const) {
			fireEvent.change(within(form).getByLabelText(label), {
				target: { value },
			})
		}
		fireEvent.click(
			within(form).getByRole('button', { name: 'Save seller details' }),
		)
		await waitFor(() =>
			expect(calls.some((c) => c.method === 'PUT')).toBe(true),
		)
		expect(calls.find((c) => c.method === 'PUT')!.body).toEqual(settings)
	})

	it('connects a terminal with a one-time password, and shows what ZATCA rejected', async () => {
		const calls = stubApi({
			settings,
			units: [],
			submissions: { reported: 4, rejected: 1 },
		})
		renderStaff(<ZatcaSettings orgSlug="joes" canWrite />)
		const terminals = await screen.findByRole('list', {
			name: 'Terminals connected to ZATCA',
		})
		expect(within(terminals).getByText('Not connected')).toBeTruthy()
		expect(
			await screen.findByText(/BR-KSA-37: bad building number/),
		).toBeTruthy()
		fireEvent.click(within(terminals).getByRole('button', { name: 'Connect' }))
		const dialog = await screen.findByRole('dialog')
		fireEvent.change(within(dialog).getByLabelText('One-time password'), {
			target: { value: '123345' },
		})
		fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }))
		await waitFor(() =>
			expect(calls.some((c) => c.url.endsWith('/zatca/units/d1/onboard'))).toBe(
				true,
			),
		)
		expect(
			calls.find((c) => c.url.endsWith('/zatca/units/d1/onboard'))!.body,
		).toEqual({ otp: '123345' })
	})
})
