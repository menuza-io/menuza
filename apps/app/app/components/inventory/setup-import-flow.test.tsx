// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { InventoryChangeProvider } from '#app/components/inventory/inventory-prefs.tsx'
import { SetupImportFlow } from '#app/components/inventory/setup-import-flow.tsx'
import { sentJson } from '#tests/inventory-render.tsx'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

beforeEach(() => {
	vi.clearAllMocks()
})

function makePdf(name: string) {
	const file = new File(['%PDF-1.4'], name, { type: 'application/pdf' })
	if (!file.arrayBuffer) {
		Object.defineProperty(file, 'arrayBuffer', {
			value: async () => new TextEncoder().encode('%PDF-1.4').buffer,
		})
	}
	return file
}

const READY_DETAIL = {
	id: 'imp_1',
	status: 'ready' as const,
	totalFiles: 2,
	completedFiles: 2,
	failedFiles: 0,
	currency: 'SAR',
	readerConfigured: true,
	appliedAt: null,
	createdAt: Date.UTC(2026, 10, 20),
	files: [
		{
			id: 'f1',
			fileName: 'inv1.pdf',
			fileKind: 'pdf' as const,
			status: 'done' as const,
			errorCode: null,
		},
		{
			id: 'f2',
			fileName: 'inv2.pdf',
			fileKind: 'pdf' as const,
			status: 'done' as const,
			errorCode: null,
		},
	],
	suppliers: [
		{
			tempKey: 'sup_1',
			name: 'Fresh Farms',
			existingSupplierId: null,
			sourceFiles: ['inv1.pdf', 'inv2.pdf'],
			items: [
				{
					tempKey: 'item_1',
					itemName: 'Tomato',
					category: 'produce' as const,
					baseUnit: 'g' as const,
					packName: 'Box 6kg',
					packBaseQuantity: 6_000_000,
					priceMinor: 4200,
					sku: null,
					existingItemId: null,
					existingProductId: null,
					sourceFiles: ['inv1.pdf', 'inv2.pdf'],
					mergedAliases: ['Tomato 6kg', 'Tomatoes 6 kg'],
				},
			],
		},
		{
			tempKey: 'sup_2',
			name: 'Dairy Co',
			existingSupplierId: 's_existing',
			sourceFiles: ['inv2.pdf'],
			items: [
				{
					tempKey: 'item_2',
					itemName: 'Milk',
					category: 'dairy' as const,
					baseUnit: 'ml' as const,
					packName: 'Carton 1L',
					packBaseQuantity: 1_000_000,
					priceMinor: 700,
					sku: null,
					existingItemId: null,
					existingProductId: null,
					sourceFiles: ['inv2.pdf'],
					mergedAliases: [],
				},
			],
		},
	],
}

describe('SetupImportFlow (#506)', () => {
	it('uploads files, polls background progress, displays merged aliases, and applies selected suppliers/items', async () => {
		const onApplied = vi.fn()
		let pollCount = 0
		const request = vi.fn<InventoryClient['request']>(async (path) => {
			if (path === '/setup/imports') {
				return {
					...READY_DETAIL,
					status: 'reading',
					completedFiles: 1,
					suppliers: [],
				}
			}
			if (path === '/setup/imports/imp_1') {
				pollCount += 1
				return READY_DETAIL
			}
			if (path === '/setup/imports/imp_1/apply') {
				return {
					importId: 'imp_1',
					suppliersCreated: 1,
					itemsCreated: 1,
					productsUpserted: 1,
					pricesRecorded: 1,
				}
			}
			throw new Error(`unexpected ${path}`)
		})

		render(
			<I18nProvider i18n={i18n}>
				<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
					<InventoryChangeProvider>
						<SetupImportFlow
							currency="SAR"
							canSeeCost
							existingImports={[]}
							onApplied={onApplied}
							onCancel={vi.fn()}
						/>
					</InventoryChangeProvider>
				</InventoryClientContext.Provider>
			</I18nProvider>,
		)

		const input = screen.getByTestId(
			'setup-import-file-input',
		) as HTMLInputElement
		await userEvent.upload(input, [makePdf('inv1.pdf'), makePdf('inv2.pdf')])
		await userEvent.click(screen.getByTestId('setup-import-start'))

		expect(
			await screen.findByTestId('setup-import-progress'),
		).toBeInTheDocument()

		await waitFor(
			() => {
				expect(pollCount).toBeGreaterThanOrEqual(1)
				expect(screen.getByTestId('setup-import-review')).toBeInTheDocument()
			},
			{ timeout: 4000 },
		)

		// Merged aliases shown
		expect(
			await screen.findByTestId('setup-import-merged-item_1'),
		).toHaveTextContent('Tomato 6kg, Tomatoes 6 kg')
		// Uncheck second supplier
		await userEvent.click(
			screen.getByTestId('setup-import-supplier-include-sup_2'),
		)
		expect(screen.getByTestId('setup-import-apply')).toHaveTextContent(
			'Create 1 item',
		)

		await userEvent.click(screen.getByTestId('setup-import-apply'))
		expect(await screen.findByTestId('setup-import-done')).toBeInTheDocument()
		expect(onApplied).toHaveBeenCalled()
		const applyIdx = request.mock.calls.findIndex(
			([p]) => p === '/setup/imports/imp_1/apply',
		)
		const payload = sentJson(request, applyIdx) as {
			suppliers: Array<{ include: boolean }>
		}
		expect(payload.suppliers[0]?.include).toBe(true)
		expect(payload.suppliers[1]?.include).toBe(false)
	})

	it('resumes an existing saved import session', async () => {
		const request = vi.fn<InventoryClient['request']>(async (path) => {
			if (path === '/setup/imports/imp_1') return READY_DETAIL
			throw new Error(`unexpected ${path}`)
		})

		render(
			<I18nProvider i18n={i18n}>
				<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
					<InventoryChangeProvider>
						<SetupImportFlow
							currency="SAR"
							canSeeCost
							existingImports={[READY_DETAIL]}
							onApplied={vi.fn()}
							onCancel={vi.fn()}
						/>
					</InventoryChangeProvider>
				</InventoryClientContext.Provider>
			</I18nProvider>,
		)

		await userEvent.click(screen.getByTestId('setup-import-resume-imp_1'))
		expect(await screen.findByTestId('setup-import-review')).toBeInTheDocument()
	})
})
