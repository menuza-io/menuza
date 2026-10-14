// @vitest-environment jsdom

import { type StaffSummary } from '@repo/staffing'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as regionBackup from '#app/utils/staffing/region-backup.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	RegionStaffGuard,
	type RegionStaffGuardState,
} from './region-staff-guard.tsx'

const saved = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('#app/utils/staffing/region-backup.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof regionBackup>()
	return { ...actual, saveTextFile: saved.save }
})

const SUMMARY: StaffSummary = {
	staff: 12,
	byStatus: { invited: 0, active: 11, on_leave: 0, terminated: 1 },
	linkedLogins: 2,
	scopeAssignments: 14,
	positions: 5,
	payRecords: 14,
	notes: 3,
	auditEntries: 80,
}

const ready = (
	overrides: Partial<RegionStaffGuardState> = {},
): RegionStaffGuardState => ({
	status: 'ready',
	summary: SUMMARY,
	requiresConfirmation: true,
	...overrides,
})

afterEach(() => {
	vi.unstubAllGlobals()
	saved.save.mockReset()
})

function renderGuard(
	state: RegionStaffGuardState,
	props: { typed?: string; onTypedChange?: (value: string) => void } = {},
) {
	return renderStaff(
		<RegionStaffGuard
			orgSlug="acme-co"
			state={state}
			typed={props.typed ?? ''}
			onTypedChange={props.onTypedChange ?? (() => {})}
		/>,
	)
}

describe('RegionStaffGuard', () => {
	it('says it is checking while the counts load', () => {
		renderGuard({
			status: 'loading',
			summary: null,
			requiresConfirmation: false,
		})
		expect(screen.getByRole('status').textContent).toMatch(/Checking/)
		expect(screen.queryByLabelText('Organization slug')).toBeNull()
	})

	it('renders nothing when the region holds no staff data', () => {
		const { container } = renderGuard(
			ready({ requiresConfirmation: false, summary: null }),
		)
		expect(container.textContent).toBe('')
	})

	it('shows what would be deleted, as counts', () => {
		renderGuard(ready())
		const text = document.body.textContent ?? ''
		expect(text).toContain('Staff members: 12')
		expect(text).toContain('1 former')
		expect(text).toContain('Pay history records: 14')
		expect(text).toContain('Positions: 5')
		expect(text).toContain('Notes: 3')
	})

	it('treats an unknown count as "assume some" and still asks for the slug', () => {
		renderGuard(ready({ summary: null }))
		expect(document.body.textContent).toMatch(/could not check/)
		expect(screen.getByLabelText('Organization slug')).toBeTruthy()
	})

	it('reports what is typed', () => {
		const onTypedChange = vi.fn()
		renderGuard(ready(), { onTypedChange })
		fireEvent.change(screen.getByLabelText('Organization slug'), {
			target: { value: 'acme' },
		})
		expect(onTypedChange).toHaveBeenCalledWith('acme')
	})

	it('downloads the backup straight from the region and saves it locally', async () => {
		const exportFile = {
			format: 'staff-export/v1',
			exportedAt: 1,
			orgId: 'o1',
			region: 'us',
			includes: { pay: true, private: true },
			staff: [{ id: 's1' }],
		}
		const fetchMock = vi.fn(async (url: string) => {
			if (url.includes('/staff/token')) {
				return Response.json({
					jwt: 'jwt-1',
					tenantApiUrl: 'https://tenant.example.test',
					scope: 'staff',
					grants: ['read:staff:any'],
					expiresAt: Date.now() + 600_000,
				})
			}
			return Response.json(exportFile)
		})
		vi.stubGlobal('fetch', fetchMock)
		renderGuard(ready())
		fireEvent.click(
			screen.getByRole('button', { name: 'Download staff backup' }),
		)

		await waitFor(() => expect(saved.save).toHaveBeenCalledTimes(1))
		const urls = fetchMock.mock.calls.map(([url]) => url)
		expect(urls[0]).toBe('/acme-co/staff/token?scope=staff')
		// The export goes to the regional node, never through the App.
		expect(urls[1]).toBe('https://tenant.example.test/operator/staff/export')
		const [filename, text] = saved.save.mock.calls[0]!
		expect(filename).toMatch(/^staff-backup-acme-co-\d{4}-\d{2}-\d{2}\.json$/)
		expect(JSON.parse(text)).toMatchObject({ staff: [{ id: 's1' }] })
		expect(await screen.findByText('Backup downloaded.')).toBeTruthy()
	})

	it('explains when the backup cannot be made, and saves nothing', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('{}', { status: 404 })),
		)
		renderGuard(ready())
		fireEvent.click(
			screen.getByRole('button', { name: 'Download staff backup' }),
		)
		expect(await screen.findByRole('alert')).toBeTruthy()
		expect(saved.save).not.toHaveBeenCalled()
	})
})
