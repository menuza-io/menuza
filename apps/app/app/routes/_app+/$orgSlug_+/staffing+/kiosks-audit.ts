import { AuditAction, auditService } from '@repo/audit'
import { data, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireStaffingFeature } from '#app/utils/staffing/access.server.ts'

const Id = z.string().trim().min(1).max(64)

// Pairing and revoking happen in the regional tenant-api, which App cannot
// see, so the browser reports them here afterwards. Only opaque ids reach
// App: the device name and staff data stay in the region.
export const KioskAuditSchema = z.discriminatedUnion('event', [
	z.object({ event: z.literal('pairing_started'), locationId: Id }),
	z.object({ event: z.literal('kiosk_revoked'), kioskId: Id, locationId: Id }),
])
export type KioskAuditEvent = z.infer<typeof KioskAuditSchema>

const noStore = { 'Cache-Control': 'no-store' }

export async function action({ request, params }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		throw data({ error: 'Method not allowed' }, { status: 405 })
	}
	const { orgId, userId } = await requireStaffingFeature(
		request,
		params.orgSlug,
		'timeclock',
		'write',
	)
	const parsed = KioskAuditSchema.safeParse(
		await request.json().catch(() => null),
	)
	if (!parsed.success) {
		return data(
			{ error: 'Invalid audit event' },
			{ status: 400, headers: noStore },
		)
	}
	const event = parsed.data
	if (event.event === 'pairing_started') {
		await auditService.log({
			action: AuditAction.STAFF_KIOSK_PAIRING_STARTED,
			userId,
			organizationId: orgId,
			details: 'Time clock pairing code created',
			metadata: { locationId: event.locationId },
			request,
			resourceType: 'staff_kiosk',
		})
	} else {
		await auditService.log({
			action: AuditAction.STAFF_KIOSK_REVOKED,
			userId,
			organizationId: orgId,
			details: 'Time clock device revoked',
			metadata: { kioskId: event.kioskId, locationId: event.locationId },
			request,
			resourceType: 'staff_kiosk',
			resourceId: event.kioskId,
		})
	}
	return data({ ok: true }, { headers: noStore })
}
