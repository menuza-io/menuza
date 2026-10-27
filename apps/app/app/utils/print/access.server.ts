import { getUserId, userHasOrganizationPermission } from '@repo/auth'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	foldPrintShopFeatures,
	PRINT_SHOP_FLAG_KEYS,
	type PrintShopFeatures,
} from '@repo/common/print-shop'
import { ENV } from 'varlock/env'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { HIDDEN_PRINT_SHOP_NAV, type PrintShopNavAccess } from './nav.ts'

/**
 * Print shop access. Designing and downloading needs the marketing
 * (campaign) permissions; paying for shipped prints also needs the billing
 * (settings) permission and the `print_shop.shipping` flag. Everything is
 * behind `print_shop.enabled`, default off: a disabled org gets a 404.
 */

export { HIDDEN_PRINT_SHOP_NAV, type PrintShopNavAccess }

export async function getPrintShopFeatures(
	organizationId: string,
): Promise<PrintShopFeatures> {
	const [enabled, shipping] = await Promise.all([
		getFeatureFlag(PRINT_SHOP_FLAG_KEYS.enabled, { organizationId }),
		getFeatureFlag(PRINT_SHOP_FLAG_KEYS.shipping, { organizationId }),
	])
	return foldPrintShopFeatures({ enabled, shipping })
}

const ENABLED_VALUES = new Set(['true', '1', 'on', 'yes', 'enabled'])

/**
 * `PRINT_SHIPPING_ENABLED` pauses paid orders (vendor outage). Unset or an
 * explicit on-value (`true`, `1`, `on`, `yes`, `enabled`) keeps shipping on;
 * any other value pauses it, so a typo in the kill switch fails closed.
 */
export function isPrintShippingPaused(): boolean {
	const raw =
		(typeof process !== 'undefined'
			? process.env?.PRINT_SHIPPING_ENABLED
			: undefined) ??
		(ENV as { PRINT_SHIPPING_ENABLED?: unknown }).PRINT_SHIPPING_ENABLED
	if (raw === undefined || raw === null || String(raw).trim() === '') {
		return false
	}
	return !ENABLED_VALUES.has(String(raw).trim().toLowerCase())
}

export async function getPrintShopNavAccess(
	userId: string,
	organizationId: string,
): Promise<PrintShopNavAccess> {
	const features = await getPrintShopFeatures(organizationId)
	if (!features.enabled) return HIDDEN_PRINT_SHOP_NAV
	const canRead = await userHasOrganizationPermission(
		userId,
		organizationId,
		ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
	)
	return { visible: canRead, shipping: canRead && features.shipping }
}

export type PrintShopAccess = {
	userId: string
	organization: {
		id: string
		slug: string
		name: string
		siteTheme: string | null
		siteIconKey: string | null
		siteLocales: string | null
		siteDefaultLocale: string | null
		customDomain: string | null
		dataRegion: string
	}
	features: PrintShopFeatures
	canWrite: boolean
	canPay: boolean
}

export async function requirePrintShopAccess(
	request: Request,
	orgSlug: string | undefined,
	options: { write?: boolean; pay?: boolean } = {},
): Promise<PrintShopAccess> {
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		slug: true,
		name: true,
		siteTheme: true,
		siteIconKey: true,
		siteLocales: true,
		siteDefaultLocale: true,
		customDomain: true,
		dataRegion: true,
	})
	const features = await getPrintShopFeatures(organization.id)
	if (!features.enabled) throw new Response('Not Found', { status: 404 })

	const userId = await getUserId(request)
	if (!userId) throw new Response('Unauthorized', { status: 401 })

	const has = (
		permission: Parameters<typeof userHasOrganizationPermission>[2],
	) => userHasOrganizationPermission(userId, organization.id, permission)
	const [canRead, canWrite, canBill] = await Promise.all([
		has(ORG_PERMISSIONS.READ_CAMPAIGN_ANY),
		has(ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY),
		has(ORG_PERMISSIONS.UPDATE_SETTINGS_ANY),
	])
	if (!canRead) throw new Response('Forbidden', { status: 403 })
	if (options.write && !canWrite) {
		throw new Response('Forbidden', { status: 403 })
	}
	const canPay = canWrite && canBill && features.shipping
	if (options.pay) {
		if (!features.shipping) throw new Response('Not Found', { status: 404 })
		if (!canPay) throw new Response('Forbidden', { status: 403 })
	}
	return {
		userId,
		organization: organization as PrintShopAccess['organization'],
		features,
		canWrite,
		canPay,
	}
}
