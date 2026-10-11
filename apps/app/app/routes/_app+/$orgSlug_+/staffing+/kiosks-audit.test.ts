import { AuditAction, auditService } from '@repo/audit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requireStaffingFeature } from '#app/utils/staffing/access.server.ts'
import { action } from './kiosks-audit.ts'

vi.mock('#app/utils/staffing/access.server.ts', () => ({
	requireStaffingFeature: vi.fn(),
}))

function post(body: unknown) {
	return action({
		request: new Request('http://localhost:3001/acme/staffing/kiosks-audit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}),
		params: { orgSlug: 'acme' },
		context: {},
	} as unknown as Parameters<typeof action>[0])
}

describe('time clock audit route', () => {
	beforeEach(() => {
		vi.mocked(requireStaffingFeature)
			.mockReset()
			.mockResolvedValue({ orgId: 'org_1', userId: 'user_1' } as Awaited<
				ReturnType<typeof requireStaffingFeature>
			>)
	})

	it('requires time clock write access', async () => {
		vi.mocked(requireStaffingFeature).mockRejectedValueOnce(
			new Response('Forbidden', { status: 403 }),
		)
		const audit = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		await expect(
			post({ event: 'pairing_started', locationId: 'loc_1' }),
		).rejects.toMatchObject({ status: 403 })
		expect(requireStaffingFeature).toHaveBeenCalledWith(
			expect.any(Request),
			'acme',
			'timeclock',
			'write',
		)
		expect(audit).not.toHaveBeenCalled()
	})

	it('audits a revoke with only opaque ids', async () => {
		const audit = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		const result = await post({
			event: 'kiosk_revoked',
			kioskId: 'kiosk_1',
			locationId: 'loc_1',
			name: 'Front counter tablet',
		})
		expect(result).toMatchObject({ data: { ok: true } })
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.STAFF_KIOSK_REVOKED,
				organizationId: 'org_1',
				resourceId: 'kiosk_1',
				metadata: { kioskId: 'kiosk_1', locationId: 'loc_1' },
			}),
		)
		expect(JSON.stringify(audit.mock.calls)).not.toContain('Front counter')
	})

	it('rejects malformed events', async () => {
		const audit = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		expect(await post({ event: 'kiosk_revoked' })).toMatchObject({
			init: { status: 400 },
		})
		expect(audit).not.toHaveBeenCalled()
	})
})
