import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

function renderSelect(
	value: string | null,
	items: { value: string; label: ReactNode }[],
	placeholder?: string,
) {
	return renderToStaticMarkup(
		<Select value={value} items={items}>
			<SelectTrigger>
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent>
				{items.map((item) => (
					<SelectItem key={item.value} value={item.value}>
						{item.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>,
	)
}

describe('selected dropdown labels', () => {
	it('renders a formatted numeric label instead of the submitted value', () => {
		const html = renderSelect('5', [
			{ value: '5', label: '5 mins' },
			{ value: '10', label: '10 mins' },
		])
		expect(html).toContain('5 mins')
		expect(html).not.toContain('>5</span>')
	})

	it('renders the selected location name instead of its ID', () => {
		const html = renderSelect('location-123', [
			{ value: 'location-123', label: 'Downtown' },
		])
		expect(html).toContain('Downtown')
		expect(html).not.toContain('>location-123</span>')
	})

	it('preserves the placeholder until a selection is made', () => {
		const items = [{ value: 'location-123', label: 'Downtown' }]
		expect(renderSelect(null, items, 'Select a location')).toContain(
			'Select a location',
		)
		expect(renderSelect('location-123', items, 'Select a location')).toContain(
			'Downtown',
		)
	})
})
