import { getFeatureFlag } from '@repo/common/feature-flags'
import { ORDERING_PRAYER_PAUSE_FLAG } from '@repo/common/ordering-flags'

export async function isPrayerPauseEnabled(
	organizationId: string,
): Promise<boolean> {
	return (
		(await getFeatureFlag(ORDERING_PRAYER_PAUSE_FLAG, {
			organizationId,
		})) === true
	)
}
