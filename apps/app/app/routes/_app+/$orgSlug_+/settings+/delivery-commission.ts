import { AuditAction, auditService } from '@repo/audit'
import { db, eq, Organization } from '@repo/database'
import { data } from 'react-router'
import { z } from 'zod'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { type Route } from './+types/delivery-commission.ts'

/**
 * Settings: the delivery-app commission rate behind "Kept by ordering direct"
 * on the monthly results (#221). A percentage between 0 and 50 with up to two
 * decimals, stored as basis points. It is an estimate's input only: it never
 * touches an order, a refund or a total.
 */
const bodySchema = z.object({
	percent: z.number().min(0).max(50),
})

export async function action({ request, params }: Route.ActionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	const actorId = await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	const parsed = bodySchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success) {
		return data({ ok: false, error: 'invalid_rate' }, { status: 400 })
	}
	const bp = Math.round(parsed.data.percent * 100)
	await db
		.update(Organization)
		.set({ deliveryCommissionBp: bp })
		.where(eq(Organization.id, organization.id))
	await auditService.log({
		action: AuditAction.ORG_SETTINGS_UPDATED,
		userId: actorId,
		organizationId: organization.id,
		resourceType: 'organization',
		resourceId: organization.id,
		details: 'Delivery-app commission rate updated',
		metadata: { deliveryCommissionBp: bp },
		request,
	})
	return data({ ok: true, bp })
}
