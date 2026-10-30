// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type LoyaltyOperatorProgram } from '@repo/loyalty'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createRoutesStub } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoyaltyClientContext } from '#app/components/loyalty/loyalty-client-provider.tsx'
import {
	type LoyaltyClient,
	type LoyaltyClientPool,
} from '#app/utils/loyalty/loyalty-client.ts'
import LoyaltyProgramRoute from './program.tsx'

function programWith(
	status: LoyaltyOperatorProgram['status'],
	version: number,
): LoyaltyOperatorProgram {
	return {
		id: 'prog_1',
		status,
		version,
		currencyLocked: true,
		current: {
			id: `ver_${version}`,
			version,
			status,
			effectiveAt: 1_700_000_000_000,
			config: {
				name: 'Coffee Club',
				unitLabel: 'points',
				currency: 'SAR',
				timeZone: 'Asia/Riyadh',
				minimumSpendMinor: 0,
				earning: { method: 'spend', points: 1, perMinor: 100 },
				terms: 'Points have no cash value.',
				labels: { items: {}, categories: {} },
			},
			createdAt: 1_700_000_000_000,
			createdBy: null,
		},
		history: [],
	}
}

const originalScrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
	vi.unstubAllGlobals()
	Element.prototype.scrollIntoView = originalScrollIntoView
})

function renderProgram(client: Record<string, unknown>) {
	i18n.load('en', {})
	i18n.activate('en')
	const pool = {
		orgSlug: 'acme',
		forScope: vi.fn(),
		invalidateAll: vi.fn(),
	} as unknown as LoyaltyClientPool
	const Stub = createRoutesStub([
		{
			path: '/acme/loyalty/program',
			Component: () => (
				<LoyaltyClientContext.Provider
					value={{ pool, client: client as unknown as LoyaltyClient }}
				>
					<LoyaltyProgramRoute />
				</LoyaltyClientContext.Provider>
			),
			HydrateFallback: () => null,
			loader: () => ({
				orgSlug: 'acme',
				canManage: true,
				defaultTimeZone: 'Asia/Riyadh',
				catalog: { items: [], categories: [] },
			}),
		},
	])
	return render(
		<I18nProvider i18n={i18n}>
			<Stub initialEntries={['/acme/loyalty/program']} />
		</I18nProvider>,
	)
}

describe('Loyalty program status', () => {
	it('keeps typed edits and holds the status buttons until they are saved', async () => {
		const client = {
			getProgram: vi.fn(async () => programWith('active', 3)),
			setProgramStatus: vi.fn(async () => programWith('paused', 4)),
		}
		renderProgram(client)

		const pause = await screen.findByTestId('loyalty-program-pause')
		expect(pause).toBeEnabled()
		expect(screen.queryByTestId('loyalty-program-status-hint')).toBeNull()

		const name = screen.getByTestId('loyalty-program-name')
		await userEvent.clear(name)
		await userEvent.type(name, 'Espresso Club')

		await waitFor(() => expect(pause).toBeDisabled())
		expect(screen.getByTestId('loyalty-program-status-hint')).toBeVisible()
		await userEvent.click(pause)
		expect(client.setProgramStatus).not.toHaveBeenCalled()
		expect(screen.getByTestId('loyalty-program-name')).toHaveValue(
			'Espresso Club',
		)
	})

	it('pauses a clean program', async () => {
		const client = {
			getProgram: vi.fn(async () => programWith('active', 3)),
			setProgramStatus: vi.fn(async () => programWith('paused', 4)),
		}
		renderProgram(client)

		await userEvent.click(await screen.findByTestId('loyalty-program-pause'))
		expect(await screen.findByTestId('loyalty-program-activate')).toBeEnabled()
		expect(client.setProgramStatus).toHaveBeenCalledWith(
			{ expectedVersion: 3, status: 'paused' },
			expect.any(String),
		)
	})
})
