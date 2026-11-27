/** @vitest-environment jsdom */
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type DescriptionDraft } from '#app/utils/menu/description-drafts.ts'
import { DescriptionDraftReview } from './description-draft-review.tsx'

i18n.load('en', {})
i18n.activate('en')

function drafts(count: number): DescriptionDraft[] {
	return Array.from({ length: count }, (_, index) => ({
		itemId: `dish-${index + 1}`,
		name: `Dish ${index + 1}`,
		en: `English ${index + 1}`,
		ar: `عربي ${index + 1}`,
		unsure: false,
		kept: [],
	}))
}

describe('DescriptionDraftReview', () => {
	it('shows 10 editable drafts in English and Arabic', () => {
		render(
			<I18nProvider i18n={i18n}>
				<DescriptionDraftReview
					drafts={drafts(10)}
					selected={new Set(drafts(10).map((draft) => draft.itemId))}
					onToggle={vi.fn()}
					onChange={vi.fn()}
				/>
			</I18nProvider>,
		)
		expect(screen.getAllByRole('textbox')).toHaveLength(20)
		expect(screen.getByLabelText('Dish 1 English')).toHaveValue('English 1')
		expect(screen.getByLabelText('Dish 10 Arabic')).toHaveValue('عربي 10')
	})
})
