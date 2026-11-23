// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CashPurchaseDialog } from '#app/components/inventory/cash-purchase-dialog.tsx'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { InventoryChangeProvider } from '#app/components/inventory/inventory-prefs.tsx'
import { sentJson } from '#tests/inventory-render.tsx'

const toast = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
	warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

beforeEach(() => {
	vi.clearAllMocks()
})

describe('CashPurchaseDialog (#466)', () => {
	it('creates a cash market purchase with a draft item and optional receipt photo', async () => {
		const onSaved = vi.fn()
		const put = vi.fn(async () => new Response(null, { status: 200 }))
		vi.stubGlobal('fetch', put)

		const request = vi.fn<InventoryClient['request']>(async (path) => {
			if (path === '/deliveries') {
				return {
					delivery: {
						id: 'd_cash',
						locationId: 'main',
						supplierId: 'sup_market',
						supplierName: 'Market / cash',
						status: 'received',
						invoiceNumber: null,
						invoiceDate: '2026-11-22',
						businessDate: '2026-11-22',
						source: 'operator',
						receivedAt: 1,
						receivedBy: { kind: 'operator', id: 'u1' },
						lineCount: 1,
						paid: true,
						paidAt: 1,
						version: 1,
						linesTotalMinor: 2500,
						vatMinor: 0,
						totalMinor: 2500,
						currency: 'SAR',
						isMarketCash: true,
						zatcaReference: null,
						lines: [],
					},
				}
			}
			if (path === '/deliveries/d_cash/invoice-photo') {
				return {
					key: 'k_cash',
					method: 'PUT',
					uploadUrl: 'https://files.example/cash',
					headers: { 'Content-Type': 'image/png' },
					expiresAt: 99,
					maxBytes: 5_000_000,
				}
			}
			if (path === '/deliveries/d_cash/invoice-photo/confirm') {
				return {
					id: 'd_cash',
					locationId: 'main',
					supplierId: 'sup_market',
					supplierName: 'Market / cash',
					status: 'received',
					invoiceNumber: null,
					invoiceDate: '2026-11-22',
					businessDate: '2026-11-22',
					source: 'operator',
					receivedAt: 1,
					receivedBy: { kind: 'operator', id: 'u1' },
					lineCount: 1,
					paid: true,
					paidAt: 1,
					version: 2,
					linesTotalMinor: 2500,
					vatMinor: 0,
					totalMinor: 2500,
					currency: 'SAR',
					zatcaReference: null,
					lines: [],
				}
			}
			throw new Error(`unexpected ${path}`)
		})

		render(
			<I18nProvider i18n={i18n}>
				<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
					<InventoryChangeProvider>
						<CashPurchaseDialog
							open
							onOpenChange={vi.fn()}
							locationId="main"
							currency="SAR"
							onSaved={onSaved}
						/>
					</InventoryChangeProvider>
				</InventoryClientContext.Provider>
			</I18nProvider>,
		)

		await userEvent.click(screen.getByTestId('cash-line-mode-draft-0'))
		await userEvent.type(
			screen.getByTestId('cash-line-draft-name-0'),
			'Fresh Mint',
		)
		await userEvent.type(screen.getByTestId('cash-line-qty-0'), '2')
		await userEvent.type(screen.getByTestId('cash-line-amount-0'), '25.00')
		await userEvent.upload(
			screen.getByTestId('cash-purchase-photo-input'),
			new File([new Uint8Array(400)], 'receipt.png', { type: 'image/png' }),
		)

		await userEvent.click(screen.getByTestId('cash-purchase-submit'))

		await waitFor(() => expect(onSaved).toHaveBeenCalled())
		const body = sentJson(request, 0) as {
			isCashPurchase: boolean
			paid: boolean
			supplierId: null
			lines: Array<{
				draftItem?: { name: string; baseUnit: string }
				quantity: number
				lineTotalMinor: number
			}>
		}
		expect(body.isCashPurchase).toBe(true)
		expect(body.paid).toBe(true)
		expect(body.supplierId).toBeNull()
		expect(body.lines[0]).toMatchObject({
			draftItem: { name: 'Fresh Mint', baseUnit: 'g' },
			quantity: 2_000_000,
			lineTotalMinor: 2500,
		})
		expect(put).toHaveBeenCalledWith(
			'https://files.example/cash',
			expect.objectContaining({ method: 'PUT' }),
		)
	})
})
