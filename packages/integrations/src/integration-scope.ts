import { isPosProvider } from './pos/types.ts'

export const REVIEW_PROVIDER_NAMES = [
	'google-business-profile',
	'yelp',
	'tripadvisor',
	'deliveroo',
	'just-eat',
	'opentable',
	'resy',
] as const

export type ReviewProviderName = (typeof REVIEW_PROVIDER_NAMES)[number]

export function isReviewProvider(providerName: string): boolean {
	return (REVIEW_PROVIDER_NAMES as readonly string[]).includes(providerName)
}

/** Integrations tied to a single {@link OrganizationLocation}. */
export function isLocationScopedIntegration(providerName: string): boolean {
	return isPosProvider(providerName) || isReviewProvider(providerName)
}
