/** @vitest-environment jsdom */
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RecipeAllergenNotice } from './recipe-allergen-notice.tsx'

i18n.load('en', {})
i18n.activate('en')

describe('RecipeAllergenNotice', () => {
	it('shows Milk as Dairy from the recipe and applies the mismatch in one click', async () => {
		const onApply = vi.fn()
		render(
			<I18nProvider i18n={i18n}>
				<RecipeAllergenNotice
					ingredients={[
						{ id: 'milk', name: 'Whole milk', allergens: ['dairy'] },
					]}
					menuAllergens={['gluten']}
					onApply={onApply}
				/>
			</I18nProvider>,
		)
		expect(screen.getByText(/Dairy/)).toBeInTheDocument()
		expect(screen.getByText(/Whole milk/)).toBeInTheDocument()
		await userEvent.click(
			screen.getByRole('button', { name: /Use recipe allergens/i }),
		)
		expect(onApply).toHaveBeenCalledWith(['dairy'])
	})
})
