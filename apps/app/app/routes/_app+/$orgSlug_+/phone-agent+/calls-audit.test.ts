import { AuditAction, auditService } from '@repo/audit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { requirePhoneAgentAccess } from '#app/utils/phone-agent/access.server.ts'
import { action } from './calls-audit.ts'

vi.mock('#app/utils/phone-agent/access.server.ts', () => ({
	requirePhoneAgentAccess: vi.fn(),
}))

function post(body: unknown, method = 'POST') {
	const url = 'http://localhost:3001/acme/phone-agent/calls-audit'
	return action({
		request: new Request(url, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: method === 'GET' ? undefined : JSON.stringify(body),
		}),
		params: { orgSlug: 'acme' },
		context: {},
	} as unknown as Parameters<typeof action>[0])
}

describe('phone call audit route', () => {
	beforeEach(() => {
		vi.mocked(requirePhoneAgentAccess).mockReset().mockResolvedValue({
			orgId: 'org_1',
			orgName: 'Acme',
			dataRegion: 'ksa',
			userId: 'user_1',
		})
	})

	it('requires the delete phone call permission', async () => {
		vi.mocked(requirePhoneAgentAccess).mockRejectedValueOnce(
			new Response('Forbidden', { status: 403 }),
		)
		const audit = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		await expect(
			post({ event: 'call_deleted', callId: 'call_1' }),
		).rejects.toMatchObject({ status: 403 })
		expect(requirePhoneAgentAccess).toHaveBeenCalledWith(
			expect.any(Request),
			'acme',
			ORG_PERMISSIONS.DELETE_PHONE_CALL_ANY,
		)
		expect(audit).not.toHaveBeenCalled()
	})

	it('audits a permanent call deletion with the call id', async () => {
		const audit = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		const result = await post({ event: 'call_deleted', callId: 'call_1' })
		expect(result).toMatchObject({ data: { ok: true } })
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.PHONE_AGENT_CALL_DELETED,
				userId: 'user_1',
				organizationId: 'org_1',
				resourceType: 'phone_call',
				resourceId: 'call_1',
				metadata: { callId: 'call_1' },
			}),
		)
	})

	it('audits a caller erasure with only the last four digits and counts', async () => {
		const audit = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		await post({
			event: 'caller_erased',
			phoneLast4: '0123',
			callsDeleted: 3,
			requestsDeleted: 1,
			smsLogsDeleted: 2,
			recordingsQueued: 1,
		})
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: AuditAction.PHONE_AGENT_CALLER_ERASED,
				organizationId: 'org_1',
				metadata: {
					phoneLast4: '0123',
					callsDeleted: 3,
					requestsDeleted: 1,
					smsLogsDeleted: 2,
					recordingsQueued: 1,
				},
			}),
		)
	})

	it.each([
		{ event: 'caller_erased', phoneLast4: '+966501234567', callsDeleted: 1 },
		{ event: 'caller_erased', phoneLast4: '0123' },
		{ event: 'call_deleted' },
		{ event: 'something_else', callId: 'call_1' },
	])('rejects a malformed event %o', async (body) => {
		const audit = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		expect(await post(body)).toMatchObject({ init: { status: 400 } })
		expect(audit).not.toHaveBeenCalled()
	})

	it('drops a full phone number sent alongside the last four digits', async () => {
		const audit = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		await post({
			event: 'caller_erased',
			phone: '+966501230123',
			phoneLast4: '0123',
			callsDeleted: 1,
			requestsDeleted: 0,
			smsLogsDeleted: 0,
			recordingsQueued: 0,
		})
		expect(audit).toHaveBeenCalledTimes(1)
		expect(JSON.stringify(audit.mock.calls)).not.toContain('966501230123')
	})
})
