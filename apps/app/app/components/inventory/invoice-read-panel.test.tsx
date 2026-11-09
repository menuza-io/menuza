// @vitest-environment jsdom
import { type InvoiceRead } from '@repo/inventory'
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { renderInventory } from '#tests/inventory-render.tsx'
import { InvoiceReadPanel } from './invoice-read-panel.tsx'

const READ: InvoiceRead = {
	deliveryId: 'd1',
	supplierName: 'Fresh Farms',
	invoiceNumber: 'INV-77',
	totalMinor: 2_350,
	lines: [
		{
			text: 'tomatoes',
			quantity: 5,
			unit: 'kg',
			lineTotalMinor: 1_250,
			itemId: 'i1',
			itemName: 'Tomatoes',
		},
		{
			text: 'Mystery crate',
			quantity: null,
			unit: null,
			itemId: null,
			itemName: null,
		},
	],
}

const draw = (request: InventoryClient['request'], canSeeCost = true) =>
	renderInventory(
		<InvoiceReadPanel deliveryId="d1" currency="SAR" canSeeCost={canSeeCost} />,
		{ request },
	)

describe('InvoiceReadPanel', () => {
	it('reads the photo into lines to check, saving nothing', async () => {
		const request = vi.fn<InventoryClient['request']>(async () => READ)
		draw(request)
		await userEvent.click(screen.getByTestId('invoice-read-button'))
		const result = await screen.findByTestId('invoice-read-result')
		expect(result).toHaveTextContent('Nothing was saved')
		expect(result).toHaveTextContent('Fresh Farms')
		expect(screen.getByTestId('invoice-read-line-0')).toHaveTextContent(
			'Tomatoes',
		)
		expect(screen.getByTestId('invoice-read-line-1')).toHaveTextContent(
			'Not in your stock',
		)
		expect(request).toHaveBeenCalledTimes(1)
		expect(request).toHaveBeenCalledWith('/deliveries/d1/invoice-photo/read', {
			method: 'POST',
			body: '{}',
		})
	})

	it('leaves prices out without the cost grant', async () => {
		draw(
			vi.fn<InventoryClient['request']>(async () => ({
				...READ,
				totalMinor: undefined,
				lines: READ.lines.map(({ lineTotalMinor: ignored, ...line }) => line),
			})),
			false,
		)
		await userEvent.click(screen.getByTestId('invoice-read-button'))
		const result = await screen.findByTestId('invoice-read-result')
		expect(result).not.toHaveTextContent('SAR')
	})

	it('says so when the photo could not be read, and offers a retry', async () => {
		draw(
			vi.fn<InventoryClient['request']>(async () => {
				throw new OperatorRequestError('bad', 'reader_failed', 502)
			}),
		)
		await userEvent.click(screen.getByTestId('invoice-read-button'))
		expect(await screen.findByTestId('invoice-read-error')).toHaveTextContent(
			'could not be read',
		)
		expect(screen.getByTestId('invoice-read-button')).toBeEnabled()
	})

	it('goes away when the region has no reader', async () => {
		draw(
			vi.fn<InventoryClient['request']>(async () => {
				throw new OperatorRequestError('no', 'reader_not_configured', 503)
			}),
		)
		await userEvent.click(screen.getByTestId('invoice-read-button'))
		await waitFor(() => expect(screen.queryByTestId('invoice-read')).toBeNull())
	})
})
