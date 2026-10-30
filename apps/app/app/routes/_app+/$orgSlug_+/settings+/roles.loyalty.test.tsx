// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { ConfigFlag, db, eq } from '@repo/database'
import { LOYALTY_FLAG_KEYS } from '@repo/loyalty'
import { fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

import {
	getPermissionGroups,
	ReadOnlyRoleView,
	RoleAccessForm,
	type TenantRole,
} from '#app/components/roles/tenant-role-access-manager.tsx'
import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import {
	action as editAction,
	loader as editLoader,
} from './roles.$roleId_.edit.tsx'
import { loader as indexLoader } from './roles._index.tsx'
import { action as createAction, loader as newLoader } from './roles.new.tsx'

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

async function setLoyaltyEnabled(organizationId: string, enabled: boolean) {
	await db
		.delete(ConfigFlag)
		.where(eq(ConfigFlag.key, LOYALTY_FLAG_KEYS.enabled))
	await db.insert(ConfigFlag).values({
		id: `flag_lty_enabled_${organizationId}`,
		key: LOYALTY_FLAG_KEYS.enabled,
		value: enabled,
		level: 'organization',
		organizationId,
		userId: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	})
}

describe('Loyalty permission group in the role editor', () => {
	it('defines the Loyalty group with all 5 permissions, gated on the flag', () => {
		const groups = getPermissionGroups().filter((g) => g.loyalty)
		expect(groups.map((g) => g.title)).toEqual(['Loyalty'])
		expect(groups[0]?.permissions.map((p) => p.id)).toEqual([
			'org_perm_read_loyalty_any',
			'org_perm_update_loyalty_program_any',
			'org_perm_update_loyalty_points_any',
			'org_perm_update_loyalty_redemption_any',
			'org_perm_read_loyalty_report_any',
		])
	})

	it('hides the Loyalty group when loyalty.enabled is off and shows it when on', () => {
		const { unmount } = renderInRouter(
			<RoleAccessForm
				cancelHref="/acme/settings/roles"
				loyaltyEnabled={false}
			/>,
		)
		expect(screen.queryByText('Loyalty')).toBeNull()
		expect(screen.queryByText('Manage loyalty program')).toBeNull()
		unmount()

		renderInRouter(
			<RoleAccessForm cancelHref="/acme/settings/roles" loyaltyEnabled />,
		)
		expect(screen.getByText('Loyalty')).toBeInTheDocument()
		expect(screen.getByText('Manage loyalty program')).toBeInTheDocument()
	})

	it('auto-selects the implied member read, and clearing it clears the writes', () => {
		const { container } = renderInRouter(
			<RoleAccessForm cancelHref="/acme/settings/roles" loyaltyEnabled />,
		)
		const selectedIds = () =>
			[
				...container.querySelectorAll<HTMLInputElement>(
					'input[type="hidden"][name="permissionIds"]',
				),
			].map((el) => el.value)

		fireEvent.click(screen.getByText('Manage loyalty program'))
		expect(selectedIds()).toContain('org_perm_update_loyalty_program_any')
		expect(selectedIds()).toContain('org_perm_read_loyalty_any')

		fireEvent.click(screen.getByText('View loyalty members'))
		expect(selectedIds()).not.toContain('org_perm_read_loyalty_any')
		expect(selectedIds()).not.toContain('org_perm_update_loyalty_program_any')
	})

	it('hides Loyalty in ReadOnlyRoleView when loyalty.enabled is off and shows it when on', () => {
		const role: TenantRole = {
			id: 'role_loyalty_lead',
			name: 'Loyalty lead',
			description: 'Runs the program',
			isBuiltIn: false,
			permissionIds: [
				'org_perm_read_loyalty_any',
				'org_perm_update_loyalty_program_any',
			],
			memberCount: 1,
		}
		const { unmount } = renderInRouter(
			<ReadOnlyRoleView role={role} loyaltyEnabled={false} />,
		)
		expect(screen.queryByText('Loyalty')).toBeNull()
		unmount()

		renderInRouter(<ReadOnlyRoleView role={role} loyaltyEnabled />)
		expect(screen.getByText('Loyalty')).toBeInTheDocument()
		expect(screen.getByText('View loyalty members')).toBeInTheDocument()
	})

	it('saves the implied member read on create and edit, and the loaders follow the flag', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setLoyaltyEnabled(organization.id, false)

		const offNew = await newLoader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/roles/new`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)
		expect(offNew.loyaltyEnabled).toBe(false)

		await setLoyaltyEnabled(organization.id, true)
		const onNew = await newLoader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/roles/new`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)
		expect(onNew.loyaltyEnabled).toBe(true)

		// Create with only the redemption grant: the server adds read:loyalty:any.
		const createForm = new FormData()
		createForm.set('name', 'Loyalty reviewer')
		createForm.set('description', 'Clears the review queue')
		createForm.append('permissionIds', 'org_perm_update_loyalty_redemption_any')
		const createRes = (await createAction({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/roles/new`,
				{ method: 'POST', body: createForm },
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)) as Response
		expect(createRes.status).toBe(302)

		const afterCreate = await indexLoader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/roles`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)
		const created = afterCreate.roles.find(
			(role) => role.name === 'Loyalty reviewer',
		)
		expect(created).toBeDefined()
		expect(created?.permissionIds.sort()).toEqual([
			'org_perm_read_loyalty_any',
			'org_perm_update_loyalty_redemption_any',
		])

		// The edit loader follows the flag too.
		const editData = await editLoader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/roles/${created!.id}/edit`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug, roleId: created!.id },
			context: {},
		} as never)
		expect(editData.loyaltyEnabled).toBe(true)

		// Edit down to the program grant: the read stays implied.
		const editForm = new FormData()
		editForm.set('name', 'Loyalty reviewer')
		editForm.set('description', 'Clears the review queue')
		editForm.append('permissionIds', 'org_perm_update_loyalty_program_any')
		const editRes = (await editAction({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/roles/${created!.id}/edit`,
				{ method: 'POST', body: editForm },
				cookie,
			),
			params: { orgSlug: organization.slug, roleId: created!.id },
			context: {},
		} as never)) as Response
		expect(editRes.status).toBe(302)

		const afterEdit = await indexLoader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/roles`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)
		expect(
			afterEdit.roles
				.find((role) => role.name === 'Loyalty reviewer')
				?.permissionIds.sort(),
		).toEqual([
			'org_perm_read_loyalty_any',
			'org_perm_update_loyalty_program_any',
		])
	})
})
