// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MenuGrid } from './MenuGrid.tsx'
import { SettingsSheet } from './SettingsSheet.tsx'

import { loadSettings, saveSettings } from '~/lib/config.ts'
import { usePos } from '~/lib/store.ts'
import { type MenuItem } from '~/lib/types.ts'
;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

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
	HTMLDialogElement.prototype.showModal = function showModal() {
		this.open = true
	}
	HTMLDialogElement.prototype.close = function close() {
		this.open = false
	}
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

function draw(node: ReactNode) {
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(h(I18nProvider, { i18n }, node)))
}

const sampleItem: MenuItem = {
	id: 'dish-1',
	displayName: 'House burger',
	description: 'Brioche bun and cheddar',
	price: 14,
	imageUrl: null,
	variations: { groups: [], variants: [] },
	isVegetarian: false,
	isGlutenFree: false,
	isAlcohol: false,
	allergens: [],
	isPopular: false,
	availabilityStatus: 'available',
	position: 0,
	modifierGroups: [],
}

describe('till menu layout (#425)', () => {
	it('changes the grid to 3 columns and compact density immediately when toggled in settings', () => {
		draw(
			h('div', null, [
				h(MenuGrid, {
					key: 'grid',
					categories: [
						{
							id: 'cat-1',
							displayName: 'Mains',
							items: [sampleItem],
							availabilityStatus: 'available',
							position: 0,
						},
					],
					money: (cents: number) => `$${(cents / 100).toFixed(2)}`,
					counts: new Map(),
					onPick: vi.fn(),
				}),
				h(SettingsSheet, {
					key: 'settings',
					open: true,
					onClose: vi.fn(),
					settings: usePos.getState().settings,
					locations: [],
					lastSyncedAt: null,
					error: null,
					waitingOrders: 0,
					onSave: (patch) => usePos.getState().updateSettings(patch),
					onPair: async () => null,
					onUnpair: vi.fn(),
				}),
			]),
		)

		const grid = host.querySelector('[data-testid="menu-grid"]')!
		const preview = host.querySelector('[data-testid="menu-layout-preview"]')!
		expect(grid.getAttribute('data-menu-columns')).toBe('auto')
		expect(grid.getAttribute('data-menu-density')).toBe('comfortable')
		expect(grid.textContent).toContain('Brioche bun and cheddar')

		// Click "3" columns in Settings.
		const colRadios = [...host.querySelectorAll<HTMLElement>('[role="radio"]')]
		const threeCols = colRadios.find((el) => el.textContent === '3')!
		act(() => threeCols.click())

		expect(grid.getAttribute('data-menu-columns')).toBe('3')
		expect(grid.className).toContain('grid-cols-3')
		expect(preview.getAttribute('data-menu-columns')).toBe('3')

		// Click "Compact" density in Settings.
		const compact = colRadios.find((el) => el.textContent === 'Compact')!
		act(() => compact.click())

		expect(grid.getAttribute('data-menu-density')).toBe('compact')
		expect(preview.getAttribute('data-menu-density')).toBe('compact')
		expect(grid.textContent).not.toContain('Brioche bun and cheddar')
	})

	it('survives a reload per terminal in localStorage', () => {
		const initial = loadSettings()
		expect(initial.menuColumns).toBe('auto')
		expect(initial.menuDensity).toBe('comfortable')

		saveSettings({
			...initial,
			menuColumns: 3,
			menuDensity: 'compact',
		})
		const reloaded = loadSettings()
		expect(reloaded.menuColumns).toBe(3)
		expect(reloaded.menuDensity).toBe('compact')
	})
})
