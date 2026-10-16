// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	ConfigFlag,
	db,
	eq,
	_OrganizationPermissionToRole,
} from '@repo/database'
import { RESERVATIONS_FLAG_KEYS } from '@repo/reservations'
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
	getPresets,
	ReadOnlyRoleView,
	RoleAccessForm,
	type TenantRole,
} from '#app/components/roles/tenant-role-access-manager.tsx'
import {
	createAuthenticatedRequest,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action as editAction } from './roles.$roleId_.edit.tsx'
import {
	action as indexAction,
	loader as indexLoader,
} from './roles._index.tsx'
import { action as createAction } from './roles.new.tsx'

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

async function setReservationsEnabled(
	organizationId: string,
	enabled: boolean,
) {
	await db
		.delete(ConfigFlag)
		.where(eq(ConfigFlag.key, RESERVATIONS_FLAG_KEYS.enabled))
	await db.insert(ConfigFlag).values({
		id: `flag_rsv_enabled_${organizationId}`,
		key: RESERVATIONS_FLAG_KEYS.enabled,
		value: enabled,
		level: 'organization',
		organizationId,
		userId: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	})
}

describe('Reservations permission group & role presets in role editor (VAL-FND-015)', () => {
	it('defines the Reservations group with all 8 permissions and presets', () => {
		const groups = getPermissionGroups().filter((g) => g.reservations)
		expect(groups.map((g) => g.title)).toEqual(['Reservations'])
		expect(groups[0]?.permissions.map((p) => p.id)).toEqual([
			'org_perm_read_reservation_any',
			'org_perm_update_reservation_any',
			'org_perm_read_reservation_settings_any',
			'org_perm_update_reservation_settings_any',
			'org_perm_read_reservation_guest_any',
			'org_perm_update_reservation_guest_any',
			'org_perm_read_reservation_report_any',
			'org_perm_update_reservation_payment_any',
		])

		const presets = getPresets().filter((p) => p.reservations)
		expect(presets.map((p) => p.name)).toEqual([
			'Host',
			'Shift manager',
			'Reservations manager',
			'Guest relations',
			'Guestbook manager',
			'Finance',
			'Owner',
		])
	})

	it('hides the Reservations group and presets when reservations.enabled is off', () => {
		renderInRouter(
			<RoleAccessForm
				cancelHref="/acme/settings/roles"
				reservationsEnabled={false}
			/>,
		)
		expect(screen.queryByText('Reservations')).toBeNull()
		expect(
			screen.queryByText('Charge fees & refund reservation payments'),
		).toBeNull()
		expect(screen.queryByRole('button', { name: 'Host' })).toBeNull()
		expect(
			screen.queryByRole('button', { name: 'Reservations manager' }),
		).toBeNull()
	})

	it('shows the Reservations group, auto-selects implied read permissions, and clears dependent writes when reservations.enabled is on', () => {
		const { container } = renderInRouter(
			<RoleAccessForm cancelHref="/acme/settings/roles" reservationsEnabled />,
		)
		expect(screen.getByText('Reservations')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Host' })).toBeInTheDocument()
		expect(
			screen.getByRole('button', { name: 'Reservations manager' }),
		).toBeInTheDocument()
		expect(
			screen.getByRole('button', { name: 'Guest relations' }),
		).toBeInTheDocument()
		expect(
			screen.getByRole('button', { name: 'Guestbook manager' }),
		).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Finance' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Owner' })).toBeInTheDocument()

		const selectedIds = () =>
			[
				...container.querySelectorAll<HTMLInputElement>(
					'input[type="hidden"][name="permissionIds"]',
				),
			].map((el) => el.value)

		// Click "Charge fees & refund reservation payments" -> implies read:reservation:any and read:reservation_report:any
		fireEvent.click(
			screen.getByText('Charge fees & refund reservation payments'),
		)
		expect(selectedIds()).toContain('org_perm_update_reservation_payment_any')
		expect(selectedIds()).toContain('org_perm_read_reservation_any')
		expect(selectedIds()).toContain('org_perm_read_reservation_report_any')

		// Uncheck "View reservation reports" -> also clears update:reservation_payment:any
		fireEvent.click(screen.getByText('View reservation reports'))
		expect(selectedIds()).not.toContain('org_perm_read_reservation_report_any')
		expect(selectedIds()).not.toContain(
			'org_perm_update_reservation_payment_any',
		)
	})

	it('hides Reservations in ReadOnlyRoleView when reservations.enabled is off and shows it when on', () => {
		const role: TenantRole = {
			id: 'role_host',
			name: 'Host',
			description: 'Host stand',
			isBuiltIn: false,
			permissionIds: [
				'org_perm_read_reservation_any',
				'org_perm_update_reservation_any',
			],
			memberCount: 2,
		}
		const { unmount } = renderInRouter(
			<ReadOnlyRoleView role={role} reservationsEnabled={false} />,
		)
		expect(screen.queryByText('Reservations')).toBeNull()
		unmount()

		renderInRouter(<ReadOnlyRoleView role={role} reservationsEnabled />)
		expect(screen.getByText('Reservations')).toBeInTheDocument()
		expect(
			screen.getByText('View reservation book & waitlist'),
		).toBeInTheDocument()
	})

	it('saves implied read grants on create/edit and creates roles from presets when reservations.enabled is on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setReservationsEnabled(organization.id, false)

		// While off, loader hides reservationsPresets and preset creation returns 404
		const offLoaderReq = createAuthenticatedRequest(
			`http://localhost:3000/${organization.slug}/settings/roles`,
			{},
			cookie,
		)
		const offLoaderData = await indexLoader({
			request: offLoaderReq,
			params: { orgSlug: organization.slug },
			context: {},
		} as never)
		expect(offLoaderData.reservationsPresets).toBeUndefined()

		const offPresetForm = new FormData()
		offPresetForm.set('intent', 'create-reservations-preset')
		offPresetForm.set('presetKey', 'host')
		const offPresetReq = createAuthenticatedRequest(
			`http://localhost:3000/${organization.slug}/settings/roles`,
			{ method: 'POST', body: offPresetForm },
			cookie,
		)
		await expect(
			indexAction({
				request: offPresetReq,
				params: { orgSlug: organization.slug },
				context: {},
			} as never),
		).rejects.toMatchObject({ status: 404 })

		// Turn on reservations.enabled
		await setReservationsEnabled(organization.id, true)
		const onLoaderReq = createAuthenticatedRequest(
			`http://localhost:3000/${organization.slug}/settings/roles`,
			{},
			cookie,
		)
		const onLoaderData = await indexLoader({
			request: onLoaderReq,
			params: { orgSlug: organization.slug },
			context: {},
		} as never)
		expect(onLoaderData.reservationsPresets?.map((p) => p.key)).toEqual([
			'host',
			'shift_manager',
			'reservations_manager',
			'guest_relations',
			'guestbook_manager',
			'finance',
			'owner',
		])

		// Create Reservations manager preset via action
		const presetForm = new FormData()
		presetForm.set('intent', 'create-reservations-preset')
		presetForm.set('presetKey', 'reservations_manager')
		const presetReq = createAuthenticatedRequest(
			`http://localhost:3000/${organization.slug}/settings/roles`,
			{ method: 'POST', body: presetForm },
			cookie,
		)
		const presetResult = await indexAction({
			request: presetReq,
			params: { orgSlug: organization.slug },
			context: {},
		} as never)
		expect(presetResult).toEqual({
			message: 'The role "Reservations manager" has been created.',
		})

		// Create custom role with only update:reservation_payment:any -> server adds implied read grants
		const createForm = new FormData()
		createForm.set('name', 'Payment Lead')
		createForm.set('description', 'Handles deposits')
		createForm.append(
			'permissionIds',
			'org_perm_update_reservation_payment_any',
		)
		const createReq = createAuthenticatedRequest(
			`http://localhost:3000/${organization.slug}/settings/roles/new`,
			{ method: 'POST', body: createForm },
			cookie,
		)
		const createRes = (await createAction({
			request: createReq,
			params: { orgSlug: organization.slug },
			context: {},
		} as never)) as Response
		expect(createRes.status).toBe(302)

		const afterLoaderData = await indexLoader({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${organization.slug}/settings/roles`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: {},
		} as never)
		const paymentLead = afterLoaderData.roles.find(
			(r) => r.name === 'Payment Lead',
		)
		expect(paymentLead).toBeDefined()
		expect(paymentLead?.permissionIds.sort()).toEqual([
			'org_perm_read_reservation_any',
			'org_perm_read_reservation_report_any',
			'org_perm_update_reservation_payment_any',
		])

		// Edit role with update:reservation_guest:any -> server adds implied read:reservation_guest:any
		const editForm = new FormData()
		editForm.set('name', 'Payment Lead')
		editForm.set('description', 'Handles deposits & guestbook')
		editForm.append('permissionIds', 'org_perm_update_reservation_guest_any')
		const editReq = createAuthenticatedRequest(
			`http://localhost:3000/${organization.slug}/settings/roles/${paymentLead!.id}/edit`,
			{ method: 'POST', body: editForm },
			cookie,
		)
		const editRes = (await editAction({
			request: editReq,
			params: { orgSlug: organization.slug, roleId: paymentLead!.id },
			context: {},
		} as never)) as Response
		expect(editRes.status).toBe(302)

		const savedGrants = await db
			.select({ permissionId: _OrganizationPermissionToRole.B })
			.from(_OrganizationPermissionToRole)
			.where(eq(_OrganizationPermissionToRole.A, paymentLead!.id))
		expect(savedGrants.map((g) => g.permissionId).sort()).toEqual([
			'org_perm_read_reservation_guest_any',
			'org_perm_update_reservation_guest_any',
		])
	})
})
