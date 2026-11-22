// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MenuGrid } from './MenuGrid.tsx'
import { loadSettings } from '~/lib/config.ts'
import { usePos } from '~/lib/store.ts'
import { type MenuItem } from '~/lib/types.ts'
;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/** #394: the till crops a dish photo at the dish's focal point. */

let host: HTMLDivElement
let root: Root

beforeEach(() => {
	localStorage.clear()
	usePos.setState({ settings: loadSettings() })
	vi.stubGlobal('matchMedia', () => ({ matches: true }))
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			disconnect() {}
		},
	)
	HTMLElement.prototype.scrollIntoView = vi.fn()
	host = document.createElement('div')
	document.body.append(host)
	root = createRoot(host)
})

afterEach(() => {
	act(() => root.unmount())
	host.remove()
	localStorage.clear()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

function dish(id: string, extra: Partial<MenuItem> = {}): MenuItem {
	return {
		id,
		displayName: id,
		description: null,
		price: 10,
		imageUrl: `https://cdn.test/${id}.jpg`,
		variations: { groups: [], variants: [] },
		isVegetarian: false,
		isGlutenFree: false,
		isAlcohol: false,
		allergens: [],
		isPopular: false,
		availabilityStatus: 'available',
		position: 0,
		modifierGroups: [],
		...extra,
	}
}

function draw(items: MenuItem[]) {
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() =>
		root.render(
			h(
				I18nProvider,
				{ i18n },
				h(MenuGrid, {
					categories: [
						{
							id: 'cat-1',
							displayName: 'Mains',
							items,
							availabilityStatus: 'available',
							position: 0,
						},
					],
					money: (cents: number) => `$${(cents / 100).toFixed(2)}`,
					counts: new Map(),
					onPick: vi.fn(),
				}),
			),
		),
	)
}

const photo = (id: string) =>
	host.querySelector<HTMLImageElement>(`img[src$="${id}.jpg"]`)!

describe('till menu photo crop (#394)', () => {
	it('keeps a top-left focal point in frame, and the centre crop without one', () => {
		draw([
			dish('top_left', { imageFocal: { x: 0, y: 0 } }),
			dish('plain'),
			dish('none', { imageFocal: null }),
		])
		// The crop rides on a custom property that the photo's class reads, so
		// a dish with no focal point carries none and keeps the centre crop.
		expect(photo('top_left').style.getPropertyValue('--focal')).toBe('0% 0%')
		expect(photo('top_left').className).toContain('object-(--focal)')
		expect(photo('plain').getAttribute('style')).toBeNull()
		expect(photo('none').getAttribute('style')).toBeNull()
	})
})
