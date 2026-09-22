// @vitest-environment jsdom
import * as React from 'react'
import { describe, it, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { createRoutesStub } from 'react-router'
import ModifiersIndexRoute from './modifiers._index.tsx'
import OptionsIndexRoute from './options._index.tsx'
import { I18nProvider } from '@lingui/react'
import { i18n } from '@lingui/core'

i18n.load('en', {})
i18n.activate('en')

describe('modifiers and options debug', () => {
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
	})

	it('renders ModifiersIndexRoute with unavailable_until', async () => {
		const Stub = createRoutesStub([
			{
				path: '/:orgSlug/menu/modifiers',
				HydrateFallback: () => null,
				Component: () => (
					<I18nProvider i18n={i18n}>
						<ModifiersIndexRoute />
					</I18nProvider>
				),
				loader: () => ({
					organization: { slug: 'acme1' },
					defaultLocale: 'en',
					groups: [
						{
							id: 'group1',
							name: '{"en":"Group 1"}',
							internalName: 'group1',
							selectionType: 'single',
							minSelections: 1,
							maxSelections: 1,
							availabilityStatus: 'unavailable_until',
							unavailableUntil: new Date(Date.now() + 3600000).toISOString(),
							optionsCount: 2,
							updatedAt: new Date().toISOString(),
						},
						{
							id: 'group2',
							name: '{"en":"Group 2"}',
							internalName: null,
							selectionType: 'multiple',
							minSelections: 0,
							maxSelections: null,
							availabilityStatus: 'unavailable_until',
							unavailableUntil: null,
							optionsCount: 0,
							updatedAt: new Date().toISOString(),
						},
					],
				}),
			},
		])

		render(<Stub initialEntries={['/acme1/menu/modifiers']} />)
	})

	it('renders OptionsIndexRoute with unavailable_until', async () => {
		const Stub = createRoutesStub([
			{
				path: '/:orgSlug/menu/options',
				HydrateFallback: () => null,
				Component: () => (
					<I18nProvider i18n={i18n}>
						<OptionsIndexRoute />
					</I18nProvider>
				),
				loader: () => ({
					orgSlug: 'acme1',
					defaultLocale: 'en',
					totalCount: 2,
					options: [
						{
							id: 'opt1',
							displayName: '{"en":"Option 1"}',
							internalName: 'opt1',
							price: 1.5,
							availabilityStatus: 'unavailable_until',
							unavailableUntil: new Date(Date.now() + 3600000).toISOString(),
							isTopping: false,
							isVegetarian: false,
							isGlutenFree: false,
							isAlcohol: false,
							allergensList: [],
							assignedGroups: [],
							imageUrl: null,
						},
						{
							id: 'opt2',
							displayName: '{"en":"Option 2"}',
							internalName: null,
							price: 0,
							availabilityStatus: 'unavailable_until',
							unavailableUntil: null,
							isTopping: false,
							isVegetarian: false,
							isGlutenFree: false,
							isAlcohol: false,
							allergensList: [],
							assignedGroups: [],
							imageUrl: null,
						},
					],
				}),
			},
		])

		render(<Stub initialEntries={['/acme1/menu/options']} />)
	})
})
