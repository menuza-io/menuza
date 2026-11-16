import { db, eq, Organization } from '@repo/database'
import { programLanguageOf } from './ai-draft-language.ts'
import { getMarketingFeatures } from './marketing-flags.server.ts'

/**
 * The settings an editor needs to offer AI drafts (#155), or null when the
 * flag `ai.marketing_drafts` is off for the organization. Loaders pass it to
 * the page, which wraps its composer or workflow in `AiDraftProvider`.
 */
export type AiDraftHostConfig = {
	endpoint: string
	orgSlug: string
	defaultLanguage: 'en' | 'ar'
}

export async function loadAiDraftConfig(
	organizationId: string,
	orgSlug: string,
): Promise<AiDraftHostConfig | null> {
	const features = await getMarketingFeatures(organizationId)
	if (!features.aiDrafts) return null
	const [org] = await db
		.select({ siteDefaultLocale: Organization.siteDefaultLocale })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return {
		endpoint: '/resources/marketing/ai-draft',
		orgSlug,
		defaultLanguage: programLanguageOf(org?.siteDefaultLocale),
	}
}
