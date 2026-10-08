import { AuditAction, auditService } from '@repo/audit'
import { data } from 'react-router'
import { z } from 'zod'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { requirePhoneAgentAccess } from '#app/utils/phone-agent/access.server.ts'
import { type Route } from './+types/calls-audit.ts'

const Count = z.number().int().min(0).max(1_000_000)

// The browser deletes calls in the regional tenant-api, which App can't see,
// so it reports what it did here afterwards. Only the last four digits of a
// caller's phone ever reach App; the full number stays in the region.
export const CallAuditSchema = z.discriminatedUnion('event', [
	z.object({
		event: z.literal('call_deleted'),
		callId: z.string().trim().min(1).max(64),
	}),
	z.object({
		event: z.literal('caller_erased'),
		phoneLast4: z.string().regex(/^\d{4}$/u),
		callsDeleted: Count,
		requestsDeleted: Count,
		smsLogsDeleted: Count,
		recordingsQueued: Count,
	}),
])
export type CallAuditEvent = z.infer<typeof CallAuditSchema>

const noStore = { 'Cache-Control': 'no-store' }

export async function action({ request, params }: Route.ActionArgs) {
	if (request.method !== 'POST') {
		throw data({ error: 'Method not allowed' }, { status: 405 })
	}
	const { orgId, userId } = await requirePhoneAgentAccess(
		request,
		params.orgSlug,
		ORG_PERMISSIONS.DELETE_PHONE_CALL_ANY,
	)
	const parsed = CallAuditSchema.safeParse(
		await request.json().catch(() => null),
	)
	if (!parsed.success) {
		return data(
			{ error: 'Invalid audit event' },
			{ status: 400, headers: noStore },
		)
	}
	const event = parsed.data
	if (event.event === 'call_deleted') {
		await auditService.log({
			action: AuditAction.PHONE_AGENT_CALL_DELETED,
			userId,
			organizationId: orgId,
			details: 'AI phone call permanently deleted',
			metadata: { callId: event.callId },
			request,
			resourceType: 'phone_call',
			resourceId: event.callId,
		})
	} else {
		const { event: ignoredEvent, phoneLast4, ...counts } = event
		await auditService.log({
			action: AuditAction.PHONE_AGENT_CALLER_ERASED,
			userId,
			organizationId: orgId,
			details: `Phone agent data erased for the caller ending ${phoneLast4}`,
			metadata: { phoneLast4, ...counts },
			request,
			resourceType: 'phone_caller',
		})
	}
	return data({ ok: true }, { headers: noStore })
}
