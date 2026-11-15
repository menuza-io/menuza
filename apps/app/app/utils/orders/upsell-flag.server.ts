import { getFeatureFlag } from '@repo/common/feature-flags'

/**
 * Org flag, default off, only a literal `true` counts: Sites shows "Goes well
 * with" next to the cart (#114).
 */
export const UPSELL_FLAG_KEY = 'ordering.upsell'

export async function isUpsellEnabled(organizationId: string): Promise<boolean> {
	return (
		(await getFeatureFlag(UPSELL_FLAG_KEY, { organizationId })) === true
	)
}
