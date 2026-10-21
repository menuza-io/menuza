// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PoliciesScreen } from '#app/components/reservations/policies/policies-screen.tsx'
import {
	apiError,
	createScriptedClient,
	type ScriptedCall,
} from '#app/components/reservations/scripted-test-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const BASE = '/operator/reservations/setup/locations/loc_1'

function policy(over: Record<string, unknown> = {}) {
	return {
		id: 'pol_1',
		locationId: 'loc_1',
		name: 'Dinner deposit',
		kind: 'deposit',
		amountMinor: 2500,
		perCover: true,
		currency: 'USD',
		freeCancelUntilMin: 1440,
		lateCancelFeeMinor: 1000,
		noShowFeeMinor: 5000,
		feePerCover: false,
		feeCapMinor: null,
		refundRule: 'full_before_window',
		partialRefundBp: null,
		appliesPartyMin: null,
		termsI18n: { en: 'Deposit terms' },
		termsVersion: 2,
		archived: false,
		version: 5,
		...over,
	}
}

type Handler = (call: ScriptedCall) => unknown

function setup(options: {
	policies?: unknown[]
	defaultPolicyId?: string | null
	services?: unknown[]
	canWrite?: boolean
	region?: string | null
	onWrite?: Handler
	policiesError?: ReturnType<typeof apiError>
}) {
	let policies = options.policies ?? [policy()]
	const scripted = createScriptedClient((call) => {
		if (call.method === 'GET') {
			if (call.path === `${BASE}/policies`) {
				if (options.policiesError) return options.policiesError
				return { locationId: 'loc_1', policies }
			}
			if (call.path === `${BASE}/settings`) {
				return {
					settings: {
						version: 9,
						currency: 'USD',
						defaultPolicyId: options.defaultPolicyId ?? null,
					},
				}
			}
			if (call.path === `${BASE}/services`) {
				return {
					services: options.services ?? [
						{ id: 'svc_1', name: 'Dinner', policyId: 'pol_1' },
						{ id: 'svc_2', name: 'Lunch', policy_id: null },
					],
				}
			}
		}
		return options.onWrite?.(call)
	})
	const onSettingsSaved = vi.fn()
	renderStaff(
		<PoliciesScreen
			client={scripted.client}
			locationId="loc_1"
			canWrite={options.canWrite ?? true}
			region={options.region ?? 'us'}
			onSettingsSaved={onSettingsSaved}
		/>,
	)
	return {
		...scripted,
		onSettingsSaved,
		setPolicies: (next: unknown[]) => {
			policies = next
		},
	}
}

const writes = (calls: ScriptedCall[]) =>
	calls.filter((call) => call.method !== 'GET')

describe('PoliciesScreen list', () => {
	it('lists policies with money, window, fees and where each is used', async () => {
		setup({ defaultPolicyId: 'pol_1' })
		const row = await screen.findByTestId('policy-row')
		expect(row.textContent).toContain('Dinner deposit')
		expect(row.textContent).toContain('$25.00 per guest')
		expect(row.textContent).toContain('Free until 24 h before')
		expect(row.textContent).toContain('No-show $50.00')
		expect(row.textContent).toContain('Late cancel $10.00')
		expect(row.textContent).toContain('Location default')
		expect(row.textContent).toContain('1 service')
	})

	it('shows an empty state with a way to start', async () => {
		setup({ policies: [] })
		expect(await screen.findByText('No payment policies yet')).toBeTruthy()
		expect(
			screen.getAllByRole('button', { name: /New policy/ }).length,
		).toBeGreaterThan(0)
	})

	it('hides every write control for a read-only member', async () => {
		setup({ canWrite: false })
		await screen.findByTestId('policy-row')
		expect(screen.queryByTestId('policy-new')).toBeNull()
		expect(screen.queryByTestId('policy-edit')).toBeNull()
		expect(screen.queryByTestId('policy-archive')).toBeNull()
	})

	it('decides access from the answer: a 403 shows a no-access note', async () => {
		setup({ policiesError: apiError(403, 'forbidden') })
		expect(await screen.findByTestId('policies-denied')).toBeTruthy()
	})

	it('recommends prepaid deposits in the Saudi region', async () => {
		setup({ region: 'ksa' })
		expect(
			(await screen.findByTestId('policies-ksa-note')).textContent,
		).toMatch(/Prepaid deposits are recommended/)
	})
})

describe('PoliciesScreen create and edit', () => {
	it('creates a policy with integer minor units and the typed terms', async () => {
		const { calls } = setup({
			policies: [],
			onWrite: () => ({ policy: policy({ id: 'pol_new' }) }),
		})
		fireEvent.click(
			(await screen.findAllByRole('button', { name: /New policy/ }))[0]!,
		)
		await screen.findByTestId('policy-sheet')
		fireEvent.change(screen.getByTestId('policy-name'), {
			target: { value: 'Weekend deposit' },
		})
		fireEvent.change(screen.getByTestId('policy-amount'), {
			target: { value: '30.5' },
		})
		fireEvent.change(screen.getByTestId('policy-terms'), {
			target: { value: 'Pay now.' },
		})
		fireEvent.click(screen.getByTestId('policy-save'))
		await waitFor(() => expect(writes(calls)).toHaveLength(1))
		const post = writes(calls)[0]!
		expect(post.method).toBe('POST')
		expect(post.path).toBe(`${BASE}/policies`)
		expect(post.body).toMatchObject({
			name: 'Weekend deposit',
			kind: 'deposit',
			amountMinor: 3050,
			freeCancelUntilMin: 1440,
			termsI18n: { en: 'Pay now.' },
		})
		await waitFor(() => expect(screen.queryByTestId('policy-sheet')).toBeNull())
	})

	it('does not send an invalid form and says what to fix', async () => {
		const { calls } = setup({ policies: [] })
		fireEvent.click(
			(await screen.findAllByRole('button', { name: /New policy/ }))[0]!,
		)
		await screen.findByTestId('policy-sheet')
		fireEvent.click(screen.getByTestId('policy-save'))
		expect(
			await screen.findByText('Enter a name for this policy.'),
		).toBeTruthy()
		expect(screen.getByText('Enter an amount like 25.00.')).toBeTruthy()
		expect(writes(calls)).toHaveLength(0)
	})

	it('edits with the version the list showed', async () => {
		const { calls } = setup({
			onWrite: () => ({ policy: policy({ version: 6 }) }),
		})
		fireEvent.click(await screen.findByTestId('policy-edit'))
		const name = (await screen.findByTestId('policy-name')) as HTMLInputElement
		expect(name.value).toBe('Dinner deposit')
		fireEvent.change(name, { target: { value: 'Dinner deposit v2' } })
		fireEvent.click(screen.getByTestId('policy-save'))
		await waitFor(() => expect(writes(calls)).toHaveLength(1))
		const put = writes(calls)[0]!
		expect(put.method).toBe('PUT')
		expect(put.path).toBe(`${BASE}/policies/pol_1`)
		expect(put.body).toMatchObject({
			name: 'Dinner deposit v2',
			amountMinor: 2500,
			expectedVersion: 5,
		})
	})

	it('keeps what was typed when someone else changed the policy first', async () => {
		const { calls } = setup({
			onWrite: () => {
				throw apiError(409, 'stale_version')
			},
		})
		fireEvent.click(await screen.findByTestId('policy-edit'))
		const name = (await screen.findByTestId('policy-name')) as HTMLInputElement
		fireEvent.change(name, { target: { value: 'My edit' } })
		fireEvent.click(screen.getByTestId('policy-save'))
		expect((await screen.findByTestId('policy-error')).textContent).toMatch(
			/Someone else changed this policy first/,
		)
		expect((screen.getByTestId('policy-name') as HTMLInputElement).value).toBe(
			'My edit',
		)
		expect(screen.getByTestId('policy-sheet')).toBeTruthy()
		// The list was reloaded in the background.
		await waitFor(() =>
			expect(
				calls.filter(
					(call) => call.method === 'GET' && call.path === `${BASE}/policies`,
				).length,
			).toBeGreaterThan(1),
		)
	})

	it('explains a payment setup that cannot take this kind of policy', async () => {
		setup({
			policies: [],
			onWrite: () => {
				throw apiError(409, 'policy_unavailable')
			},
		})
		fireEvent.click(
			(await screen.findAllByRole('button', { name: /New policy/ }))[0]!,
		)
		await screen.findByTestId('policy-sheet')
		fireEvent.change(screen.getByTestId('policy-name'), {
			target: { value: 'X' },
		})
		fireEvent.change(screen.getByTestId('policy-amount'), {
			target: { value: '10' },
		})
		fireEvent.click(screen.getByTestId('policy-save'))
		expect((await screen.findByTestId('policy-error')).textContent).toMatch(
			/does not support this kind of policy/,
		)
	})
})

describe('PoliciesScreen archive', () => {
	it('asks first and then archives', async () => {
		const { calls } = setup({
			onWrite: () => ({ ok: true }),
		})
		fireEvent.click(await screen.findByTestId('policy-archive'))
		const dialog = await screen.findByTestId('policy-archive-dialog')
		expect(writes(calls)).toHaveLength(0)
		fireEvent.click(within(dialog).getByTestId('policy-archive-confirm'))
		await waitFor(() => expect(writes(calls)).toHaveLength(1))
		expect(writes(calls)[0]).toMatchObject({
			method: 'DELETE',
			path: `${BASE}/policies/pol_1`,
		})
	})
})

describe('PoliciesScreen where policies apply', () => {
	it('saves the location default against the shared settings version', async () => {
		const { calls, onSettingsSaved } = setup({
			defaultPolicyId: null,
			onWrite: () => ({}),
		})
		const trigger = await screen.findByRole('combobox', {
			name: 'Location default',
		})
		await userEvent.click(trigger)
		await userEvent.click(
			await screen.findByRole('option', { name: 'Dinner deposit' }),
		)
		await waitFor(() => expect(writes(calls)).toHaveLength(1))
		expect(writes(calls)[0]).toMatchObject({
			method: 'PUT',
			path: `${BASE}/settings`,
			body: { defaultPolicyId: 'pol_1', expectedVersion: 9 },
		})
		await waitFor(() => expect(onSettingsSaved).toHaveBeenCalled())
	})

	it('attaches a policy to one service and shows the conflict message, reloading either way', async () => {
		const { calls } = setup({
			onWrite: () => {
				throw apiError(409, 'stale_version')
			},
		})
		const trigger = await screen.findByRole('combobox', { name: 'Lunch' })
		await userEvent.click(trigger)
		await userEvent.click(
			await screen.findByRole('option', { name: 'Dinner deposit' }),
		)
		await waitFor(() => expect(writes(calls)).toHaveLength(1))
		expect(writes(calls)[0]).toMatchObject({
			method: 'PUT',
			path: `${BASE}/services/svc_2`,
			body: { policyId: 'pol_1' },
		})
		expect(
			(await screen.findByTestId('policy-attach-error')).textContent,
		).toMatch(/Someone else changed this policy first|could not be saved/)
	})

	it('disables the pickers for a read-only member', async () => {
		setup({ canWrite: false })
		const trigger = await screen.findByRole('combobox', {
			name: 'Location default',
		})
		expect(
			trigger.hasAttribute('disabled') ||
				trigger.getAttribute('aria-disabled') === 'true',
		).toBe(true)
	})
})
