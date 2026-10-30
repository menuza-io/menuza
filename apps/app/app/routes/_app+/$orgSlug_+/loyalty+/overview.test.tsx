// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type LoyaltyOperatorProgram, type LoyaltyReport } from '@repo/loyalty'
import { render, screen, waitFor } from '@testing-library/react'
import { createRoutesStub, Outlet } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { LoyaltyClientContext } from '#app/components/loyalty/loyalty-client-provider.tsx'
import {
	LoyaltyApiError,
	type LoyaltyClient,
	type LoyaltyClientPool,
} from '#app/utils/loyalty/loyalty-client.ts'
import {
	HIDDEN_LOYALTY_NAV,
	type LoyaltyNavAccess,
} from '#app/utils/loyalty/nav.ts'
import LoyaltyOverviewRoute from './overview.tsx'

const REPORT: LoyaltyReport = {
	window: { from: '2025-01-01', to: '2025-01-30', timeZone: 'Asia/Riyadh' },
	currency: 'SAR',
	customers: { accountsTotal: 42, accountsOpened: 5, activeInWindow: 12 },
	points: {
		earned: 900,
		reversed: 0,
		redeemed: 300,
		restored: 0,
		adjustedNet: 0,
		reservedNow: 0,
		outstandingNow: 600,
	},
	redemptions: {
		consumed: 3,
		restored: 0,
		released: 0,
		discountCostMinor: 1500,
		conversionBp: 2500,
	},
	purchases: {
		count: 20,
		customerRevenueMinor: 100_000,
		averageOrderValueMinor: 5000,
		repeatPurchaseRateBp: 5000,
		frequencyHundredths: 166,
	},
	operations: {
		redemptionsInReview: 1,
		purchasesInReview: 0,
		openRedemptions: 0,
		oldestOpenRedemptionAgeMs: null,
		refundsRecorded: 0,
	},
}

const PROGRAM = {
	id: 'prog_1',
	status: 'active',
	version: 3,
	currencyLocked: true,
	current: {
		id: 'ver_3',
		version: 3,
		status: 'active',
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
} satisfies LoyaltyOperatorProgram

const REPORTS_ONLY_NAV: LoyaltyNavAccess = {
	...HIDDEN_LOYALTY_NAV,
	visible: true,
	overview: true,
}

const FULL_NAV: LoyaltyNavAccess = {
	visible: true,
	overview: true,
	program: true,
	rewards: true,
	activity: true,
}

function fakeClient(overrides: Partial<Record<keyof LoyaltyClient, unknown>>) {
	// A reports-only role cannot mint a `read` token: the App answers 403.
	const refused = () =>
		Promise.reject(
			new LoyaltyApiError('Failed to mint loyalty token (403)', 403),
		)
	return {
		getProgram: vi.fn(refused),
		listRewards: vi.fn(refused),
		getReport: vi.fn(async () => REPORT),
		...overrides,
	}
}

function renderOverview({
	canReadReports,
	canReadProgram,
	nav,
	client,
}: {
	canReadReports: boolean
	canReadProgram: boolean
	nav: LoyaltyNavAccess
	client: ReturnType<typeof fakeClient>
}) {
	i18n.load('en', {})
	i18n.activate('en')
	const pool = {
		orgSlug: 'acme',
		forScope: vi.fn(),
		invalidateAll: vi.fn(),
	} as unknown as LoyaltyClientPool
	function Layout() {
		return (
			<LoyaltyClientContext.Provider
				value={{ pool, client: client as unknown as LoyaltyClient }}
			>
				<Outlet context={{ orgSlug: 'acme', nav }} />
			</LoyaltyClientContext.Provider>
		)
	}
	const Stub = createRoutesStub([
		{
			path: '/acme/loyalty',
			Component: Layout,
			HydrateFallback: () => null,
			children: [
				{
					path: 'overview',
					Component: LoyaltyOverviewRoute,
					HydrateFallback: () => null,
					loader: () => ({ orgSlug: 'acme', canReadReports, canReadProgram }),
				},
			],
		},
	])
	return render(
		<I18nProvider i18n={i18n}>
			<Stub initialEntries={['/acme/loyalty/overview']} />
		</I18nProvider>,
	)
}

describe('Loyalty overview', () => {
	it('shows a reports-only role the figures without asking for the program', async () => {
		const client = fakeClient({})
		renderOverview({
			canReadReports: true,
			canReadProgram: false,
			nav: REPORTS_ONLY_NAV,
			client,
		})

		expect(await screen.findByTestId('loyalty-report-block')).toBeVisible()
		expect(screen.getByTestId('loyalty-metric-customers')).toHaveTextContent(
			'42',
		)
		expect(screen.queryByTestId('loyalty-overview-error')).toBeNull()
		expect(screen.queryByTestId('loyalty-overview-empty')).toBeNull()
		expect(screen.queryByTestId('loyalty-program-summary')).toBeNull()
		expect(client.getProgram).not.toHaveBeenCalled()
		expect(client.listRewards).not.toHaveBeenCalled()
		expect(client.getReport).toHaveBeenCalledTimes(1)
		expect(client.getReport).toHaveBeenCalledWith({
			from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
			to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
		})
	})

	it('tells a reports-only role there is no program yet, without a setup link', async () => {
		const client = fakeClient({
			getReport: vi.fn(() =>
				Promise.reject(
					new LoyaltyApiError('Not found', 404, 'program_not_found'),
				),
			),
		})
		renderOverview({
			canReadReports: true,
			canReadProgram: false,
			nav: REPORTS_ONLY_NAV,
			client,
		})

		expect(await screen.findByTestId('loyalty-overview-empty')).toBeVisible()
		expect(screen.queryByTestId('loyalty-overview-error')).toBeNull()
		expect(screen.queryByText('Set up the program')).toBeNull()
		expect(
			screen.getByText(
				'Figures appear here once someone who manages loyalty sets up the program.',
			),
		).toBeVisible()
	})

	it('shows a reports-only role a retryable error when the figures fail', async () => {
		const client = fakeClient({
			getReport: vi.fn(() =>
				Promise.reject(new LoyaltyApiError('Unavailable', 503)),
			),
		})
		renderOverview({
			canReadReports: true,
			canReadProgram: false,
			nav: REPORTS_ONLY_NAV,
			client,
		})

		const alert = await screen.findByTestId('loyalty-overview-error')
		expect(alert).toHaveTextContent(
			'Loyalty is temporarily unavailable in this region.',
		)
		expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible()
		expect(screen.queryByTestId('loyalty-overview-empty')).toBeNull()
	})

	it('keeps the program summary and the figures for a role that reads both', async () => {
		const client = fakeClient({
			getProgram: vi.fn(async () => PROGRAM),
			listRewards: vi.fn(async () => []),
		})
		renderOverview({
			canReadReports: true,
			canReadProgram: true,
			nav: FULL_NAV,
			client,
		})

		expect(await screen.findByTestId('loyalty-program-summary')).toBeVisible()
		expect(await screen.findByTestId('loyalty-report-block')).toBeVisible()
		expect(client.getReport).toHaveBeenCalledTimes(1)
	})

	it('does not ask for figures before a program exists', async () => {
		const client = fakeClient({
			getProgram: vi.fn(async () => null),
			listRewards: vi.fn(async () => []),
		})
		renderOverview({
			canReadReports: true,
			canReadProgram: true,
			nav: FULL_NAV,
			client,
		})

		expect(await screen.findByTestId('loyalty-overview-empty')).toBeVisible()
		expect(screen.getByText('Set up the program').closest('a')).toHaveAttribute(
			'href',
			'/acme/loyalty/program',
		)
		await waitFor(() => expect(client.getProgram).toHaveBeenCalledTimes(1))
		expect(client.getReport).not.toHaveBeenCalled()
	})
})
