// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountantExportDialog } from '#app/components/inventory/accountant-export-dialog.tsx'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubGlobal('URL', {
		createObjectURL: vi.fn(() => 'blob:export'),
		revokeObjectURL: vi.fn(),
	})
})

describe('AccountantExportDialog (#507)', () => {
	it('loads JSON summary preview and downloads CSV and PDF via Blob', async () => {
		const request = vi.fn<InventoryClient['request']>(async (path) => {
			if (path.includes('format=json')) {
				return {
					from: '2026-11-01',
					to: '2026-11-22',
					locationId: 'all',
					currency: 'SAR',
					categories: ['produce'],
					rows: [],
					supplierTotals: [],
					categoryTotals: { produce: 100_000 },
					totals: {
						count: 4,
						netMinor: 100_000,
						vatMinor: 15_000,
						totalMinor: 115_000,
						paidMinor: 80_000,
						unpaidMinor: 35_000,
					},
				}
			}
			throw new Error(`unexpected json request ${path}`)
		})
		const requestBlob = vi.fn<NonNullable<InventoryClient['requestBlob']>>(
			async (path) => {
				if (path.includes('format=csv')) {
					return {
						blob: new Blob(['Date,Supplier\n'], { type: 'text/csv' }),
						filename: 'deliveries.csv',
					}
				}
				return {
					blob: new Blob(['%PDF-1.4'], { type: 'application/pdf' }),
					filename: 'deliveries.pdf',
				}
			},
		)

		render(
			<I18nProvider i18n={i18n}>
				<InventoryClientContext.Provider
					value={{ orgSlug: 'acme', request, requestBlob }}
				>
					<AccountantExportDialog
						open
						onOpenChange={vi.fn()}
						locations={[
							{ id: 'main', name: 'Main' },
							{ id: 'branch', name: 'Branch' },
						]}
						activeLocationId="main"
						currency="SAR"
					/>
				</InventoryClientContext.Provider>
			</I18nProvider>,
		)

		const summary = await screen.findByTestId('accountant-export-summary')
		expect(summary).toHaveTextContent('4 deliveries')
		expect(summary).toHaveTextContent('1,150')

		await userEvent.click(screen.getByTestId('accountant-export-csv'))
		await waitFor(() =>
			expect(requestBlob).toHaveBeenCalledWith(
				expect.stringContaining('format=csv'),
			),
		)
		expect(toast.success).toHaveBeenCalledWith('Export downloaded.')

		await userEvent.click(screen.getByTestId('accountant-export-pdf'))
		await waitFor(() =>
			expect(requestBlob).toHaveBeenCalledWith(
				expect.stringContaining('format=pdf'),
			),
		)
	})
})
