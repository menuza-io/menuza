import { getUserId, userHasOrganizationPermission } from '@repo/auth'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	foldQrOrderingFeatures,
	QR_ORDERING_FLAG_KEYS,
	type QrOrderingFeatures,
} from '@repo/common/qr-ordering'
import { RESERVATIONS_FLAG_KEYS, isFlagOn } from '@repo/reservations'
import {
	requireMenuRead,
	requireMenuWrite,
} from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { HIDDEN_QR_ORDERING_NAV, type QrOrderingNavAccess } from './nav.ts'

/**
 * QR ordering access: the menu permissions (read to view, write to change
 * tables, settings and tabs) behind the org's QR flags, default off. A
 * disabled org gets a 404 before any permission is checked.
 */

export { HIDDEN_QR_ORDERING_NAV, type QrOrderingNavAccess }

export async function getQrOrderingFeatures(
	organizationId: string,
): Promise<QrOrderingFeatures> {
	const [enabled, dineIn, online] = await Promise.all([
		getFeatureFlag(QR_ORDERING_FLAG_KEYS.enabled, { organizationId }),
		getFeatureFlag(QR_ORDERING_FLAG_KEYS.dineIn, { organizationId }),
		getFeatureFlag(QR_ORDERING_FLAG_KEYS.online, { organizationId }),
	])
	return foldQrOrderingFeatures({ enabled, dineIn, online })
}

export async function getQrOrderingNavAccess(
	userId: string,
	organizationId: string,
): Promise<QrOrderingNavAccess> {
	const features = await getQrOrderingFeatures(organizationId)
	if (!features.enabled) return HIDDEN_QR_ORDERING_NAV
	const canRead = await userHasOrganizationPermission(
		userId,
		organizationId,
		ORG_PERMISSIONS.READ_MENU_ANY,
	)
	return { visible: canRead, dineIn: canRead && features.dineIn }
}

export type QrOrderingAccess = {
	userId: string
	organization: { id: string; slug: string }
	features: QrOrderingFeatures
	canWrite: boolean
	/** Reservations is on: the floor plan can be imported as tables. */
	floorPlanAvailable: boolean
}

export async function requireQrOrderingAccess(
	request: Request,
	orgSlug: string | undefined,
	options: { write?: boolean } = {},
): Promise<QrOrderingAccess> {
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		slug: true,
	})
	const features = await getQrOrderingFeatures(organization.id)
	if (!features.enabled) throw new Response('Not Found', { status: 404 })
	const userId = options.write
		? await requireMenuWrite(request, organization.id)
		: await requireMenuRead(request, organization.id)
	const [canWrite, reservations] = await Promise.all([
		options.write
			? Promise.resolve(true)
			: userHasOrganizationPermission(
					userId,
					organization.id,
					ORG_PERMISSIONS.UPDATE_MENU_ANY,
				),
		getFeatureFlag(RESERVATIONS_FLAG_KEYS.enabled, {
			organizationId: organization.id,
		}),
	])
	if (!(await getUserId(request))) {
		throw new Response('Unauthorized', { status: 401 })
	}
	return {
		userId,
		organization,
		features,
		canWrite,
		floorPlanAvailable: isFlagOn(reservations),
	}
}
