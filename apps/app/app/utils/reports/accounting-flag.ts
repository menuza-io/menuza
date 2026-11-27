import { getFeatureFlag } from '@repo/common/feature-flags'
import { isFlagOn } from '@repo/staffing'

/** The accounting export (#189) is behind this flag, default off. */
export const ACCOUNTING_FLAG = 'reports.accounting'

export async function isAccountingEnabled(organizationId: string) {
	return isFlagOn(await getFeatureFlag(ACCOUNTING_FLAG, { organizationId }))
}
