// @vitest-environment jsdom
import { defaultFieldOwnership } from '@repo/integrations/pos/ownership'
import { screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PosIntegrationCard } from '#app/components/settings/cards/organization/pos-integrations-card.tsx'
import { type PosEntityLockInfo } from '#app/utils/menu/pos-ownership.server.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { ItemForm } from './item-form.tsx'
import { ModifierForm } from './modifier-form.tsx'
import { OptionForm } from './option-form.tsx'

vi.mock('#app/components/inventory/recipe-panel.tsx', () => ({
	RecipePanel: () => null,
	RecipeAside: () => null,
	OptionRecipePanel: () => null,
	RecipeScope: ({ children }: { children: unknown }) => children,
}))
vi.mock('#app/components/media-library/media-library-picker.tsx', () => ({
	MediaLibraryPicker: () => null,
}))
vi.mock('./quick-modifier-group-sheet.tsx', () => ({
	QuickModifierGroupSheet: () => null,
	useCanCreateModifierGroup: () => false,
}))

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

function makeSquareItemLock(
	overrides: Partial<PosEntityLockInfo> = {},
): PosEntityLockInfo {
	return {
		entityType: 'item',
		entityId: 'item_1',
		isLinked: true,
		providers: ['Square'],
		providerSlugs: ['square'],
		integrationIds: ['int_sq'],
		locationLocks: {
			loc_1: {
				integrationId: 'int_sq',
				provider: 'square',
				providerLabel: 'Square',
				lockedFields: ['name', 'description', 'price'],
			},
		},
		lockedFields: [
			'name',
			'description',
			'price',
			'available',
			'category',
			'modifiers',
			'photo',
			'tax',
		],
		lockedFieldProviders: {
			name: 'Square',
			description: 'Square',
			price: 'Square',
			available: 'Square',
			category: 'Square',
			modifiers: 'Square',
			photo: 'Square',
			tax: 'Square',
		},
		ownedFields: [
			'name',
			'description',
			'price',
			'available',
			'category',
			'modifiers',
			'photo',
			'tax',
		],
		overriddenFields: [],
		posValues: {
			name: 'Margherita Pizza',
			description: 'Tomato, basil, mozzarella',
			price: 12.99,
		},
		allowlistedFields: ['name', 'description', 'photo', 'modifiers'],
		deleteLocked: true,
		deleteLockedProvider: 'Square',
		...overrides,
	}
}

describe('POS ownership UI in menu editors and Integrations card (#93)', () => {
	it('AC #1 & #7: ItemForm renders Managed in Square badge, disables locked price input with Integrations link, shows Use my own only on allowlisted fields, and disables delete while Square owns name/price', async () => {
		const user = userEvent.setup()
		renderStaff(
			<ItemForm
				pageTitle="Edit Item"
				itemId="item_1"
				orgSlug="bistro"
				defaultLocale="en"
				supportedLocales={['en']}
				allCategories={[]}
				allModifierGroups={[]}
				allLocations={[
					{ id: 'loc_1', name: 'Downtown', slug: 'downtown', isDefault: true },
				]}
				posLock={makeSquareItemLock()}
				isSubmitting={false}
				initialData={{
					displayName: JSON.stringify({ en: 'Margherita Pizza' }),
					description: JSON.stringify({ en: 'Tomato, basil, mozzarella' }),
					price: 12.99,
					applySalesTax: true,
					availabilityStatus: 'available',
					assignedCategoryIds: [],
					assignedModifierGroupIds: [],
					locationOverrides: {},
				}}
			/>,
		)

		// Badge in header
		expect(screen.getByText('Managed in Square')).toBeInTheDocument()

		// Base Price input is disabled, while hidden input keeps value for form saves
		const priceInput = document.querySelector<HTMLInputElement>('#price-input')
		expect(priceInput).not.toBeNull()
		expect(priceInput).toBeDisabled()

		// Price panel shows Managed in Square + Change ownership link, NO Use my own button
		const priceSection = priceInput!.closest('div')!
		expect(
			within(priceSection).getByRole('link', { name: 'Change ownership' }),
		).toHaveAttribute('href', '/bistro/settings/integrations')
		expect(
			within(priceSection).queryByRole('button', { name: 'Use my own' }),
		).toBeNull()

		// Allowlisted fields (photo, name, description, modifiers) DO show Use my own (4 total)
		expect(screen.getAllByRole('button', { name: 'Use my own' })).toHaveLength(
			4,
		)

		// Delete dialog explains to remove in Square or change ownership and disables confirm
		const deleteTrigger = screen
			.getAllByRole('button', { name: 'Delete Item' })
			.at(-1)!
		await user.click(deleteTrigger)
		expect(screen.getByText(/cannot be deleted while/i)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
	})

	it('AC #5: ItemForm shows Yours, not from POS mark, stored POS preview, and Restore from POS button when description is overridden', () => {
		const lock = makeSquareItemLock({
			lockedFields: ['name', 'price'],
			overriddenFields: ['description'],
		})
		renderStaff(
			<ItemForm
				pageTitle="Edit Item"
				itemId="item_1"
				orgSlug="bistro"
				defaultLocale="en"
				supportedLocales={['en']}
				allCategories={[]}
				allModifierGroups={[]}
				allLocations={[]}
				posLock={lock}
				isSubmitting={false}
				initialData={{
					displayName: JSON.stringify({ en: 'Margherita Pizza' }),
					description: JSON.stringify({ en: 'Custom house description' }),
					price: 12.99,
				}}
			/>,
		)

		expect(screen.getByText('Yours, not from POS')).toBeInTheDocument()
		expect(
			screen.getByText(/POS value: Tomato, basil, mozzarella/),
		).toBeInTheDocument()
		expect(
			screen.getByRole('button', { name: /Restore from POS/ }),
		).toBeInTheDocument()
	})

	it('locks POS-owned fields on OptionForm and ModifierForm with Managed in <POS> badges', () => {
		const { unmount } = renderStaff(
			<OptionForm
				orgSlug="bistro"
				optionId="opt_1"
				initialData={{
					displayName: JSON.stringify({ en: 'Extra Cheese' }),
					price: 1.5,
				}}
				availableModifierGroups={[]}
				locations={[]}
				supportedLocales={['en']}
				defaultLocale="en"
				pageTitle="Edit Option"
				posLock={{
					entityType: 'modifier_option',
					entityId: 'opt_1',
					isLinked: true,
					providers: ['Clover'],
					providerSlugs: ['clover'],
					integrationIds: ['int_cl'],
					locationLocks: {},
					lockedFields: ['name', 'price'],
					lockedFieldProviders: { name: 'Clover', price: 'Clover' },
					ownedFields: ['name', 'price'],
					overriddenFields: [],
					posValues: { name: 'Extra Cheese', price: 1.5 },
					allowlistedFields: ['name'],
					deleteLocked: false,
					deleteLockedProvider: null,
				}}
			/>,
		)
		expect(screen.getByText('Managed in Clover')).toBeInTheDocument()
		expect(
			document.querySelector<HTMLInputElement>('#option-base-price'),
		).toBeDisabled()
		unmount()

		renderStaff(
			<ModifierForm
				pageTitle="Edit Modifier Group"
				orgSlug="bistro"
				defaultLocale="en"
				supportedLocales={['en']}
				allItems={[]}
				allLocations={[]}
				isSubmitting={false}
				initialData={{
					id: 'grp_1',
					name: JSON.stringify({ en: 'Toppings' }),
					selectionType: 'multiple',
					minSelections: 0,
					maxSelections: 3,
					options: [],
					assignedItemIds: [],
					locationOverrides: {},
				}}
				posLock={{
					entityType: 'modifier_group',
					entityId: 'grp_1',
					isLinked: true,
					providers: ['Toast'],
					providerSlugs: ['toast'],
					integrationIds: ['int_to'],
					locationLocks: {},
					lockedFields: ['name', 'modifiers'],
					lockedFieldProviders: { name: 'Toast', modifiers: 'Toast' },
					ownedFields: ['name', 'modifiers'],
					overriddenFields: [],
					posValues: { name: 'Toppings' },
					allowlistedFields: ['name'],
					deleteLocked: false,
					deleteLockedProvider: null,
				}}
			/>,
		)
		expect(screen.getByText('Managed in Toast')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Add option/ })).toBeDisabled()
	})

	it('renders Who owns what panel on connected POS cards and disables POS toggle for unreadable fields', () => {
		renderStaff(
			<PosIntegrationCard
				provider={{
					name: 'clover',
					kind: 'pos',
					displayName: 'Clover',
					description: 'Clover POS',
					icon: 'blocks',
					writeMode: 'item',
				}}
				integration={{
					id: 'int_clover',
					providerName: 'clover',
					isActive: true,
					lastSyncAt: null,
					environment: 'sandbox',
					fieldOwnership: defaultFieldOwnership('clover'),
					supportedOwnershipFields: [
						'name',
						'price',
						'available',
						'category',
						'modifiers',
						'tax',
					],
				}}
				selectedLocationId="loc_1"
				menus={[]}
				doorDashLiveConfigured={false}
				posOwnershipEnabled={true}
			/>,
		)

		expect(screen.getByText('Who owns what')).toBeInTheDocument()
		const priceGroup = screen.getByRole('group', { name: 'Price' })
		expect(
			within(priceGroup).getByRole('button', { name: 'POS' }),
		).toHaveAttribute('aria-pressed', 'true')

		// Clover does not expose description or photo on read -> POS button is disabled
		const descGroup = screen.getByRole('group', { name: 'Description' })
		expect(
			within(descGroup).getByRole('button', { name: 'POS' }),
		).toBeDisabled()
		expect(
			within(descGroup).getByRole('button', { name: 'Menuza' }),
		).toHaveAttribute('aria-pressed', 'true')
	})
})
