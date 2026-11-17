// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import { OptionForm } from './option-form.tsx'

// The regional recipe panel and the media library are islands with their own
// clients: they are not what is tested here.
vi.mock('#app/components/inventory/recipe-panel.tsx', () => ({
	OptionRecipePanel: () => null,
	RecipeScope: ({ children }: { children: unknown }) => children,
}))
vi.mock('#app/components/media-library/media-library-picker.tsx', () => ({
	MediaLibraryPicker: () => null,
}))

const LOCATIONS = [
	{ id: 'a', name: 'Main Street', slug: 'main', isDefault: true },
	{ id: 'b', name: 'Airport', slug: 'airport', isDefault: false },
]

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

function show(props: Partial<React.ComponentProps<typeof OptionForm>> = {}) {
	renderStaff(
		<OptionForm
			orgSlug="acme"
			optionId="opt_1"
			initialData={{ displayName: JSON.stringify({ en: 'Dessert' }), price: 2 }}
			availableModifierGroups={[]}
			locations={LOCATIONS}
			supportedLocales={['en']}
			defaultLocale="en"
			pageTitle="Edit Option"
			{...props}
		/>,
	)
}

const posted = () =>
	document.querySelector<HTMLInputElement>('input[name="dailySaleLimit"]')

describe('OptionForm daily limit (#409)', () => {
	it('shows no card and posts no field while the feature is off', () => {
		show({
			dailyLimitsEnabled: false,
			initialData: {
				displayName: JSON.stringify({ en: 'Dessert' }),
				price: 2,
				dailySaleLimit: { limit: 12, showRemaining: false },
			},
		})
		expect(screen.queryByText('Daily limit')).toBeNull()
		// Not posted at all, so saving the form leaves the stored limit alone.
		expect(posted()).toBeNull()
	})

	it('shows the option wording and posts an empty field for an option with no limit', () => {
		show({ dailyLimitsEnabled: true })
		expect(screen.getByText('Daily limit')).toBeInTheDocument()
		expect(
			screen.getByText(/Stop taking this option once this many are chosen/),
		).toBeInTheDocument()
		expect(screen.queryByText(/Stop taking orders for this dish/)).toBeNull()
		expect(posted()).not.toBeNull()
		expect(posted()!.value).toBe('')
	})

	it('shows a saved limit and posts it as the JSON the server reads', () => {
		show({
			dailyLimitsEnabled: true,
			initialData: {
				displayName: JSON.stringify({ en: 'Dessert' }),
				price: 2,
				dailySaleLimit: {
					limit: 12,
					showRemaining: true,
					byLocation: { b: 3 },
				},
			},
		})
		expect(screen.getByLabelText('How many can be sold each day')).toHaveValue(
			12,
		)
		// The Location Overrides card names the location too: pick the limit field.
		expect(
			screen.getByLabelText('Airport', {
				selector: '#option-daily-limit-loc-b',
			}),
		).toHaveValue(3)
		expect(JSON.parse(posted()!.value)).toEqual({
			limit: 12,
			showRemaining: true,
			byLocation: { b: 3 },
		})
	})

	it('posts what is typed, and posts an empty field again once it is cleared', async () => {
		show({ dailyLimitsEnabled: true })
		const user = userEvent.setup()
		const input = screen.getByLabelText('How many can be sold each day')
		await user.type(input, '8')
		expect(JSON.parse(posted()!.value)).toEqual({
			limit: 8,
			showRemaining: false,
		})
		await user.clear(input)
		expect(posted()!.value).toBe('')
	})

	it('posts a value the server refuses while the typed limit is not a whole number', async () => {
		show({ dailyLimitsEnabled: true })
		await userEvent
			.setup()
			.type(screen.getByLabelText('How many can be sold each day'), '2.5')
		expect((JSON.parse(posted()!.value) as { limit: number }).limit).toBe(0)
		expect(screen.getByRole('alert')).toHaveTextContent(
			'Enter a whole number from 1 to 10,000',
		)
	})
})
