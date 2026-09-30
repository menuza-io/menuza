import { isPosProvider } from './pos/types.ts'

/** Integrations tied to a single {@link OrganizationLocation}. */
export function isLocationScopedIntegration(providerName: string): boolean {
	return (
		isPosProvider(providerName) || providerName === 'google-business-profile'
	)
}
