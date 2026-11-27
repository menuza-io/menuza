// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	type InventoryClient,
	InventoryClientContext,
} from './inventory-client-provider.tsx'
import { InvoiceInboxPanel, invoiceAddress } from './invoice-inbox-panel.tsx'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

afterEach(() => {
	vi.unstubAllGlobals()
})

const invoice = (over: Record<string, unknown>) => ({
	id: 'inv1',
	locationId: 'main',
	source: 'email' as const,
	receivedAt: 1_700_000_000_000,
	fromAddress: 'billing@freshco.example',
	subject: 'Invoice 100',
	senderState: 'unknown' as const,
	status: 'new' as const,
	readState: 'read' as const,
	supplierId: null,
	supplierName: null,
	invoiceNumber: '100',
	invoiceDate: '2026-11-20',
	lineCount: 2,
	files: [
		{
			id: 'f1',
			fileName: 'inv.pdf',
			contentType: 'application/pdf',
			sizeBytes: 10,
		},
	],
	duplicateOfId: null,
	duplicateDeliveryId: null,
	orderId: null,
	deliveryId: null,
	version: 1,
	...over,
})

function renderPanel(request: InventoryClient['request']) {
	return render(
		<I18nProvider i18n={i18n}>
			<MemoryRouter>
				<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
					<InvoiceInboxPanel
						orgSlug="acme"
						locationId="main"
						canEdit
						canSeeCost={false}
						canManageSettings
						currency="SAR"
						search=""
					/>
				</InventoryClientContext.Provider>
			</MemoryRouter>
		</I18nProvider>,
	)
}

describe('invoiceAddress', () => {
	it('is the code and the region domain, nothing else', () => {
		expect(invoiceAddress('abc123', 'in.menuza.test')).toBe(
			'invoices+abc123@in.menuza.test',
		)
	})
})

describe('InvoiceInboxPanel', () => {
	it('shows the location address and the invoices waiting, marking an unknown sender', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ code: 'abc123' })),
		)
		const request = vi.fn(async (path: string) => {
			if (path.startsWith('/invoice-inbox/config'))
				return { enabled: true, domain: 'in.menuza.test' }
			return {
				items: [
					invoice({}),
					invoice({
						id: 'inv2',
						senderState: 'known',
						supplierName: 'Fresh Co',
						status: 'matched',
					}),
				],
				nextCursor: null,
				openCount: 2,
			}
		}) as unknown as InventoryClient['request']
		renderPanel(request)
		expect(await screen.findByTestId('invoice-address-text')).toHaveTextContent(
			'invoices+abc123@in.menuza.test',
		)
		expect(screen.getByTestId('invoice-inv1')).toHaveTextContent(
			'Unknown sender',
		)
		expect(screen.getByTestId('invoice-inv2')).toHaveTextContent('Fresh Co')
		expect(screen.getByTestId('invoice-inv2')).toHaveTextContent(
			'Matched to an order',
		)
	})

	it('hides the address while the node receives no mail, but still takes uploads', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ code: 'abc123' })),
		)
		const request = vi.fn(async (path: string) => {
			if (path.startsWith('/invoice-inbox/config'))
				return { enabled: true, domain: null }
			return { items: [], nextCursor: null, openCount: 0 }
		}) as unknown as InventoryClient['request']
		renderPanel(request)
		expect(
			await screen.findByText('No invoices are waiting.'),
		).toBeInTheDocument()
		expect(screen.queryByTestId('invoice-address-text')).toBeNull()
		expect(screen.getByTestId('invoice-upload-input')).toBeInTheDocument()
	})

	it('uploads the chosen files as one form to the inbox', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ code: 'abc123' })),
		)
		const request = vi.fn(async (path: string) => {
			if (path.startsWith('/invoice-inbox/config'))
				return { enabled: false, domain: null }
			if (path.startsWith('/invoice-inbox/upload')) return {}
			return { items: [], nextCursor: null, openCount: 0 }
		}) as unknown as InventoryClient['request']
		renderPanel(request)
		const input = (await screen.findByTestId(
			'invoice-upload-input',
		)) as HTMLInputElement
		const file = new File(['x'], 'scan.png', { type: 'image/png' })
		fireEvent.change(input, { target: { files: [file] } })
		await waitFor(() =>
			expect(request).toHaveBeenCalledWith(
				'/invoice-inbox/upload?locationId=main',
				expect.objectContaining({ method: 'POST' }),
			),
		)
		const call = (
			request as unknown as ReturnType<typeof vi.fn>
		).mock.calls.find((entry) =>
			String(entry[0]).startsWith('/invoice-inbox/upload'),
		)!
		expect((call[1] as { body: FormData }).body).toBeInstanceOf(FormData)
	})
})
