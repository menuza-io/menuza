// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { KanbanCard, KanbanColumn } from './kanban.tsx'

describe('KanbanColumn', () => {
	it('names the section by its title and shows the count badge', () => {
		render(
			<KanbanColumn title="Seated" count={2} countTestId="n">
				<KanbanCard testId="c1">One</KanbanCard>
				<KanbanCard testId="c2">Two</KanbanCard>
			</KanbanColumn>,
		)
		expect(screen.getByRole('heading', { name: /Seated/ })).toBeTruthy()
		expect(screen.getByTestId('n').textContent).toBe('2')
		expect(screen.getAllByRole('listitem')).toHaveLength(2)
	})

	it('draws the dashed placeholder only when there are no cards', () => {
		render(
			<KanbanColumn title="Empty" count={0} empty="Nothing here">
				{[]}
			</KanbanColumn>,
		)
		expect(screen.getByText('Nothing here')).toBeTruthy()
	})

	it('collapses to the header and its action', () => {
		let clicked = false
		render(
			<KanbanColumn
				title="3 finished"
				collapsed
				headerAction={
					<button type="button" onClick={() => (clicked = true)}>
						Show
					</button>
				}
				footer="footer"
			>
				<KanbanCard>Hidden</KanbanCard>
			</KanbanColumn>,
		)
		expect(screen.queryByText('Hidden')).toBeNull()
		expect(screen.queryByText('footer')).toBeNull()
		fireEvent.click(screen.getByText('Show'))
		expect(clicked).toBe(true)
	})
})
