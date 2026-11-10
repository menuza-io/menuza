// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeAll, describe, expect, it } from 'vitest'
import {
	getPermissionGroups,
	getPresets,
	RoleAccessForm,
} from '#app/components/roles/tenant-role-access-manager.tsx'
import { TENANT_ROLE_PERMISSION_IDS } from '#app/utils/organization/tenant-role-permissions.ts'

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

function renderInRouter(node: React.ReactNode) {
	const router = createMemoryRouter([{ path: '/', element: node }], {
		initialEntries: ['/'],
	})
	return render(
		<I18nProvider i18n={i18n}>
			<RouterProvider router={router} />
		</I18nProvider>,
	)
}

describe('Inventory permission group in the role editor', () => {
	it('defines the Inventory group with all 5 permissions, gated on the flag', () => {
		const groups = getPermissionGroups().filter((g) => g.inventory)
		expect(groups.map((g) => g.title)).toEqual(['Inventory'])
		expect(groups[0]?.permissions.map((p) => p.id)).toEqual([
			'org_perm_read_inventory_any',
			'org_perm_update_inventory_any',
			'org_perm_read_inventory_cost_any',
			'org_perm_update_inventory_purchasing_any',
			'org_perm_update_inventory_recipe_any',
		])
	})

	it('offers Kitchen team (no cost) and Kitchen manager (all five) presets', () => {
		const presets = getPresets().filter((p) => p.inventory)
		expect(presets.map((p) => [p.name, p.permissionIds])).toEqual([
			[
				'Kitchen team',
				['org_perm_read_inventory_any', 'org_perm_update_inventory_any'],
			],
			[
				'Kitchen manager',
				[
					'org_perm_read_inventory_any',
					'org_perm_update_inventory_any',
					'org_perm_read_inventory_cost_any',
					'org_perm_update_inventory_purchasing_any',
					'org_perm_update_inventory_recipe_any',
				],
			],
		])
		const allowed = new Set<string>(TENANT_ROLE_PERMISSION_IDS)
		for (const preset of presets) {
			for (const id of preset.permissionIds) expect(allowed.has(id)).toBe(true)
		}
	})

	it('hides the group and presets while inventory.enabled is off', () => {
		const { unmount } = renderInRouter(
			<RoleAccessForm cancelHref="/acme/settings/roles" />,
		)
		expect(screen.queryByText('Count and manage stock')).toBeNull()
		expect(screen.queryByText('Kitchen team')).toBeNull()
		unmount()

		renderInRouter(
			<RoleAccessForm cancelHref="/acme/settings/roles" inventoryEnabled />,
		)
		expect(screen.getByText('Count and manage stock')).toBeInTheDocument()
		expect(screen.getByText('Kitchen team')).toBeInTheDocument()
		expect(screen.getByText('Kitchen manager')).toBeInTheDocument()
	})

	it('auto-selects View stock with a write or cost grant', () => {
		const { container } = renderInRouter(
			<RoleAccessForm cancelHref="/acme/settings/roles" inventoryEnabled />,
		)
		const selectedIds = () =>
			[
				...container.querySelectorAll<HTMLInputElement>(
					'input[type="hidden"][name="permissionIds"]',
				),
			].map((el) => el.value)

		fireEvent.click(screen.getByText('View inventory costs'))
		expect(selectedIds()).toContain('org_perm_read_inventory_cost_any')
		expect(selectedIds()).toContain('org_perm_read_inventory_any')
	})
})
