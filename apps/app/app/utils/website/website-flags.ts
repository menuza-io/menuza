import { getFeatureFlag } from '@repo/common/feature-flags'

export const WEBSITE_AI_GENERATE_FLAG = 'website.ai_generate'
export const WEBSITE_IMPORT_FLAG = 'website.import'

export async function isWebsiteFlagOn(organizationId: string, key: string) {
	const value = await getFeatureFlag(key, { organizationId })
	return value === true
}
