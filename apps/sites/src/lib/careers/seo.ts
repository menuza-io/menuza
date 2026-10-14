import {
	buildJobPostingJsonLd,
	serializeJsonLd,
	type PublicJobPosting,
} from '@repo/common/job-posting'
import { sanitizeJobDescription } from '~/lib/sanitize.ts'

/**
 * The `application/ld+json` text for a posting page. The description is
 * sanitized here as well, so structured data never carries markup the page
 * would not render.
 */
export function jobPostingStructuredData(input: {
	posting: PublicJobPosting
	organizationName: string
	siteUrl: string
	url: string
	locale: string
	logoUrl?: string | null
	/** The page has a real application form, so search engines may offer "apply". */
	directApply?: boolean
}): string {
	return serializeJsonLd(
		buildJobPostingJsonLd({
			posting: {
				...input.posting,
				descriptionHtml: sanitizeJobDescription(input.posting.descriptionHtml),
			},
			organization: {
				name: input.organizationName,
				url: input.siteUrl,
				logoUrl: input.logoUrl ?? null,
			},
			url: input.url,
			inLanguage: input.locale,
			directApply: input.directApply === true,
		}),
	)
}
