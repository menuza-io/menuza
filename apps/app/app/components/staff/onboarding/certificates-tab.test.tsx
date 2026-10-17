// @vitest-environment jsdom

import { addDays } from '@repo/staffing'
import {
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StaffClientProvider } from '#app/components/staff/staff-client-provider.tsx'
import { localToday } from '#app/utils/staffing/onboarding-view.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { CertificatesTab } from './certificates-tab.tsx'
import {
	CERTIFICATE_KIND_ORDER,
	certificateKindChoices,
} from './onboarding-labels.ts'

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

type Call = { url: string; method: string; body: any }
const TODAY = localToday()

const cert = (over: Record<string, unknown> = {}) => ({
	id: 'c1',
	staffId: 's1',
	kind: 'food_handler',
	label: null,
	issuedOn: null,
	expiresOn: null,
	note: null,
	createdAt: 1,
	updatedAt: 1,
	...over,
})

function stubApi(
	options: { certificates?: unknown[]; grants?: string[] } = {},
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
					scope: 'hiring',
					grants: options.grants ?? ['read:hiring:any', 'update:hiring:any'],
					expiresAt: Date.now() + 600_000,
				})
			}
			const call: Call = {
				url,
				method: init?.method ?? 'GET',
				body: init?.body ? JSON.parse(String(init.body)) : null,
			}
			calls.push(call)
			if (call.method === 'GET') {
				return Response.json({ certificates: options.certificates ?? [] })
			}
			if (call.method === 'DELETE') return Response.json({ removed: true })
			return Response.json({ certificate: cert() }, { status: 201 })
		}),
	)
	return calls
}

const show = (terminated = false) =>
	renderStaff(
		<StaffClientProvider orgSlug="acme">
			<CertificatesTab staffId="s1" terminated={terminated} />
		</StaffClientProvider>,
	)

describe('CertificatesTab', () => {
	it('says in words whether each certificate is fine, expiring or expired', async () => {
		stubApi({
			certificates: [
				cert({ id: 'a', expiresOn: addDays(TODAY, 400) }),
				cert({ id: 'b', kind: 'first_aid', expiresOn: addDays(TODAY, 10) }),
				cert({ id: 'c', kind: 'health_card', expiresOn: addDays(TODAY, -3) }),
				cert({ id: 'd', kind: 'other', label: 'Barista course' }),
			],
		})
		show()
		expect(await screen.findByText('Expired 3 days ago')).toBeTruthy()
		expect(screen.getByText('Expires in 10 days')).toBeTruthy()
		expect(screen.getByText(/Valid until/)).toBeTruthy()
		expect(screen.getByText('Does not expire')).toBeTruthy()
		// An "other" certificate shows the name it was given.
		expect(screen.getByText('Barista course')).toBeTruthy()
		// Expired first, then expiring soon.
		const items = screen.getAllByRole('listitem')
		expect(within(items[0]!).getByText('Health card')).toBeTruthy()
		expect(within(items[1]!).getByText('First aid')).toBeTruthy()
	})

	it('shows an empty state that explains the point', async () => {
		stubApi()
		show()
		expect(await screen.findByText('No certificates yet')).toBeTruthy()
		const hint = screen.getByText(/get a reminder before one expires/)
		// The generic module names no business type.
		expect(hint.textContent).toMatch(/licences and certificates/)
		expect(hint.textContent).not.toMatch(/food/i)
	})

	it('offers only kinds that fit any business, and keeps an existing one', () => {
		const vertical = ['food_handler', 'health_card', 'alcohol_service']
		expect(
			CERTIFICATE_KIND_ORDER.filter((kind) => vertical.includes(kind)),
		).toEqual([])
		expect(certificateKindChoices(null)).toEqual(CERTIFICATE_KIND_ORDER)
		expect(certificateKindChoices('first_aid')).toEqual(CERTIFICATE_KIND_ORDER)
		// Editing a certificate saved with a food-service kind keeps that kind.
		expect(certificateKindChoices('food_handler')).toEqual([
			'food_handler',
			...CERTIFICATE_KIND_ORDER,
		])
	})

	it('asks for a name only for "Other" and checks the dates before sending', async () => {
		const calls = stubApi()
		show()
		fireEvent.click(
			await screen.findByRole('button', { name: 'Add certificate' }),
		)
		const form = await screen.findByRole('form', { name: 'Add a certificate' })
		expect(within(form).queryByLabelText(/What is it called/)).toBeNull()
		// A neutral kind is preselected, not a food-service one.
		expect(within(form).getByText('First aid')).toBeTruthy()
		expect(within(form).queryByText('Food handler card')).toBeNull()

		fireEvent.change(within(form).getByLabelText(/Issued/), {
			target: { value: '2026-05-02' },
		})
		fireEvent.change(within(form).getByLabelText(/Expires/), {
			target: { value: '2026-05-01' },
		})
		fireEvent.click(
			within(form).getByRole('button', { name: 'Add certificate' }),
		)
		expect(
			await within(form).findByText(
				'The expiry date cannot be before the issue date.',
			),
		).toBeTruthy()
		expect(calls.some((c) => c.method === 'POST')).toBe(false)

		fireEvent.change(within(form).getByLabelText(/Expires/), {
			target: { value: '2027-05-01' },
		})
		fireEvent.click(
			within(form).getByRole('button', { name: 'Add certificate' }),
		)
		await waitFor(() =>
			expect(calls.find((c) => c.method === 'POST')).toMatchObject({
				body: {
					kind: 'first_aid',
					label: null,
					issuedOn: '2026-05-02',
					expiresOn: '2027-05-01',
					note: null,
				},
			}),
		)
	})

	it('has no number or upload field', async () => {
		stubApi()
		show()
		fireEvent.click(
			await screen.findByRole('button', { name: 'Add certificate' }),
		)
		const form = await screen.findByRole('form', { name: 'Add a certificate' })
		expect(within(form).queryByLabelText(/number/i)).toBeNull()
		expect(form.querySelector('input[type="file"]')).toBeNull()
	})

	it('confirms before removing', async () => {
		const calls = stubApi({
			certificates: [cert({ expiresOn: addDays(TODAY, 90) })],
		})
		show()
		fireEvent.click(
			await screen.findByRole('button', {
				name: 'More actions for Food handler card',
			}),
		)
		fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove' }))
		expect(await screen.findByText('Remove this certificate?')).toBeTruthy()
		expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
		fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
		await waitFor(() =>
			expect(calls.find((c) => c.method === 'DELETE')?.url).toMatch(
				/\/certificates\/staff\/s1\/c1$/,
			),
		)
	})

	it('is read-only without the update grant', async () => {
		stubApi({ certificates: [cert()], grants: ['read:hiring:any'] })
		show()
		await screen.findByText('Food handler card')
		expect(screen.queryByRole('button', { name: 'Add certificate' })).toBeNull()
		expect(screen.queryByRole('button', { name: /More actions/ })).toBeNull()
	})
})
