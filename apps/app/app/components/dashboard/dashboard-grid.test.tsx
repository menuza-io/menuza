// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { DirectionProvider } from '@repo/ui'
import { render, screen } from '@testing-library/react'
import { type ReactNode } from 'react'
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

function grid(
	options: {
		hiddenBlockIds?: string[]
		direction?: 'ltr' | 'rtl'
	} = {},
): ReactNode {
	return (
		<I18nProvider i18n={i18n}>
			<DirectionProvider direction={options.direction ?? 'ltr'}>
				<DashboardGrid
					blocks={reversedBlocks}
					layouts={config.layouts}
					hiddenBlockIds={options.hiddenBlockIds}
					renderBlock={renderBlock}
				/>
			</DirectionProvider>
		</I18nProvider>
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
