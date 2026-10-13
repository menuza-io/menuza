// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { DirectionProvider } from '@repo/ui'
import { render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { type ComponentProps, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	defaultHomeConfig,
	type DashboardBlock,
} from '#app/utils/dashboards/config.ts'
import { DashboardGrid } from './dashboard-grid.tsx'

const config = defaultHomeConfig()
const reversedBlocks = [...config.blocks].reverse()

function renderBlock(block: DashboardBlock) {
	return <p>{block.id} content</p>
}

type GridOptions = Pick<
	ComponentProps<typeof DashboardGrid>,
	| 'hiddenBlockIds'
	| 'editing'
	| 'onLayoutCommit'
	| 'onRemoveBlock'
	| 'onEditableChange'
> & { direction?: 'ltr' | 'rtl' }

function grid({ direction = 'ltr', ...props }: GridOptions = {}): ReactNode {
	return (
		<I18nProvider i18n={i18n}>
			<DirectionProvider direction={direction}>
				<DashboardGrid
					blocks={reversedBlocks}
					layouts={config.layouts}
					renderBlock={renderBlock}
					{...props}
				/>
			</DirectionProvider>
		</I18nProvider>
	)
}

function shownResizeHandles(corner: 'se' | 'sw' = 'se') {
	return document.querySelectorAll(
		`.react-grid-item:not(.react-resizable-hide) > .react-resizable-handle-${corner}`,
	)
}

function setContainerWidth(width: number) {
	vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(width)
}

function setViewportWidth(width: number) {
	vi.stubGlobal('innerWidth', width)
}

function renderedBlocks() {
	return screen.getAllByRole('region').map((region) => ({
		title: region.getAttribute('aria-label'),
		item: region.closest<HTMLElement>('.react-grid-item'),
	}))
}

beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
	vi.stubGlobal(
		'matchMedia',
		vi.fn((query: string) => {
			const maxWidth = Number(/max-width:\s*(\d+)px/.exec(query)?.[1])
			return {
				matches: window.innerWidth <= maxWidth,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			}
		}),
	)
	setViewportWidth(1440)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('DashboardGrid', () => {
	it('server-renders a skeleton instead of the blocks', () => {
		const html = renderToString(grid())
		expect(html).toContain('data-slot="dashboard-grid-skeleton"')
		expect(html).not.toContain('react-grid-item')
		expect(html).not.toContain('stats content')
	})

	it('renders blocks in visual order, row first and then column', () => {
		setContainerWidth(1200)
		render(grid())
		expect(renderedBlocks().map((block) => block.title)).toEqual([
			'Stats',
			'Notes chart',
			'Onboarding checklist',
			'Top contributors',
		])
		expect(screen.getByText('stats content')).toBeInTheDocument()
	})

	it('leaves hidden blocks out and moves their neighbour into the gap', () => {
		setContainerWidth(1200)
		render(grid({ hiddenBlockIds: ['onboarding'] }))
		const blocks = renderedBlocks()
		expect(blocks.map((block) => block.title)).toEqual([
			'Stats',
			'Notes chart',
			'Top contributors',
		])
		expect(screen.queryByText('onboarding content')).not.toBeInTheDocument()
		expect(blocks[2]?.item?.style.transform).toMatch(/^translate\(0px,/)
	})

	it('stacks blocks in one full-width column on viewports under 768px', () => {
		// Wide enough for the 8-column layout if only the container counted.
		setViewportWidth(740)
		setContainerWidth(708)
		render(grid())
		const blocks = renderedBlocks()
		expect(blocks.map((block) => block.title)).toEqual([
			'Stats',
			'Notes chart',
			'Onboarding checklist',
			'Top contributors',
		])
		const tops = blocks.map((block) => {
			expect(block.item?.style.width).toBe('708px')
			const match = /^translate\(0px,\s*(\d+)px\)$/.exec(
				block.item?.style.transform ?? '',
			)
			expect(match).not.toBeNull()
			return Number(match?.[1])
		})
		expect(tops).toEqual([...tops].sort((a, b) => a - b))
	})

	it('mirrors the layout in right-to-left locales but keeps the reading order', () => {
		setContainerWidth(1200)
		render(grid({ direction: 'rtl' }))
		const blocks = renderedBlocks()
		expect(blocks.map((block) => block.title)).toEqual([
			'Stats',
			'Notes chart',
			'Onboarding checklist',
			'Top contributors',
		])
		expect(blocks[2]?.item?.style.transform).not.toMatch(/^translate\(0px,/)
		expect(blocks[3]?.item?.style.transform).toMatch(/^translate\(0px,/)
		expect(blocks[2]?.item).toHaveAttribute('dir', 'rtl')
	})
})

describe('DashboardGrid edit mode', () => {
	it('shows a drag handle, a resize handle and a Remove block button per block only while editing', () => {
		setContainerWidth(1200)
		const { rerender } = render(grid())
		expect(
			screen.queryByRole('button', { name: 'Move block' }),
		).not.toBeInTheDocument()
		expect(
			screen.queryByRole('button', { name: 'Remove block' }),
		).not.toBeInTheDocument()
		expect(shownResizeHandles()).toHaveLength(0)

		rerender(grid({ editing: true, onRemoveBlock: vi.fn() }))
		for (const region of screen.getAllByRole('region')) {
			const block = within(region)
			expect(block.getByRole('button', { name: 'Move block' })).toBeVisible()
			expect(block.getByRole('button', { name: 'Remove block' })).toBeVisible()
		}
		expect(shownResizeHandles()).toHaveLength(4)

		rerender(grid({ onRemoveBlock: vi.fn() }))
		expect(
			screen.queryByRole('button', { name: 'Move block' }),
		).not.toBeInTheDocument()
		expect(
			screen.queryByRole('button', { name: 'Remove block' }),
		).not.toBeInTheDocument()
		expect(shownResizeHandles()).toHaveLength(0)
	})

	it('removes the block whose Remove block button is pressed', async () => {
		setContainerWidth(1200)
		const onRemoveBlock = vi.fn()
		render(grid({ editing: true, onRemoveBlock }))
		const leaderboard = screen.getByRole('region', { name: 'Top contributors' })
		await userEvent.click(
			within(leaderboard).getByRole('button', { name: 'Remove block' }),
		)
		expect(onRemoveBlock).toHaveBeenCalledExactlyOnceWith('leaderboard')
	})

	it('reports no layout change when it mounts at any breakpoint', () => {
		const onLayoutCommit = vi.fn()
		setContainerWidth(1200)
		const { unmount } = render(grid({ editing: true, onLayoutCommit }))
		unmount()
		setContainerWidth(700)
		render(grid({ editing: true, onLayoutCommit }))
		expect(screen.getAllByRole('button', { name: 'Move block' })).toHaveLength(
			4,
		)
		expect(onLayoutCommit).not.toHaveBeenCalled()
	})

	it('can be edited at tablet and desktop sizes', () => {
		const onEditableChange = vi.fn()
		setContainerWidth(700)
		render(grid({ onEditableChange }))
		expect(onEditableChange).toHaveBeenLastCalledWith(true)
	})

	it('cannot be edited in mobile mode', () => {
		setViewportWidth(390)
		setContainerWidth(358)
		const onEditableChange = vi.fn()
		render(grid({ editing: true, onEditableChange }))
		expect(onEditableChange).toHaveBeenLastCalledWith(false)
		expect(onEditableChange).not.toHaveBeenCalledWith(true)
		expect(
			screen.queryByRole('button', { name: 'Move block' }),
		).not.toBeInTheDocument()
		expect(shownResizeHandles()).toHaveLength(0)
	})

	it('keeps the grid left to right in right-to-left locales and resizes from the bottom-left corner', () => {
		setContainerWidth(1200)
		const { container } = render(grid({ direction: 'rtl', editing: true }))
		expect(
			container.querySelector('[data-slot="dashboard-grid"]'),
		).toHaveAttribute('dir', 'ltr')
		expect(shownResizeHandles('sw')).toHaveLength(4)
		expect(shownResizeHandles('se')).toHaveLength(0)
	})
})
