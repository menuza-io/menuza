// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	buildProductMixTree,
	type ProductMixRow,
} from '@repo/reports/product-mix'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProductMixTable } from './product-mix-table.tsx'

const rows: ProductMixRow[] = [
	{
		kind: 'dish',
		currency: 'USD',
		menuId: 'm1',
		menu: 'Lunch',
		categoryId: 'c1',
		category: 'Mains',
		itemId: 'i1',
		item: 'Burger',
		quantity: 3,
		salesMinor: 4500,
	},
	{
		kind: 'dish',
		currency: 'USD',
		menuId: '',
		menu: '',
		categoryId: '',
		category: '',
		itemId: 'i2',
		item: 'Old dish',
		quantity: 1,
		salesMinor: 500,
	},
]

const labels = (level: string) => level

function show(
	levels: Parameters<typeof buildProductMixTree>[1],
	showPercentages = true,
) {
	i18n.load('en', {})
	i18n.activate('en')
	return render(
		<I18nProvider i18n={i18n}>
			<ProductMixTable
				tree={buildProductMixTree(rows, levels, 'USD')}
				showPercentages={showPercentages}
				levelLabel={labels as never}
			/>
		</I18nProvider>,
	)
}

describe('ProductMixTable (#227)', () => {
	it('shows each category with its share of sales and an Earlier sales group, and a total that stays 100%', () => {
		show(['category'])
		const rowsShown = screen.getAllByTestId('product-mix-row')
		expect(rowsShown).toHaveLength(2)
		expect(rowsShown[0]).toHaveTextContent('Mains')
		expect(rowsShown[0]).toHaveTextContent('90%')
		expect(rowsShown[1]).toHaveTextContent('Earlier sales')
		const total = screen.getByTestId('product-mix-total')
		expect(total).toHaveTextContent('$50.00')
		expect(total).toHaveTextContent('100%')
	})

	it('keeps the same total whichever levels are shown', () => {
		const first = show(['category', 'dish'])
		expect(
			within(screen.getByTestId('product-mix-total')).getByText('$50.00'),
		).toBeInTheDocument()
		first.unmount()
		show(['dish'])
		expect(
			within(screen.getByTestId('product-mix-total')).getByText('$50.00'),
		).toBeInTheDocument()
	})

	it('hides the percentage columns when asked', () => {
		show(['category'], false)
		expect(screen.queryByText('Share of sales')).toBeNull()
		expect(screen.getByText('Average price')).toBeInTheDocument()
	})
})
