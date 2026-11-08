import {
	getTenantApiUrl as getUsTenantApiUrl,
	getTenantApiUrlKsa,
} from '~/lib/worker-env'

/**
 * Regional tenant-api URL for this org, or null when its region has no node
 * configured.
 *
 * Injected into the page (`data-tenant-api-url`) so the browser calls
 * tenant-api directly. Sites must not proxy customer PII. A KSA organization
 * never falls back to the US node: without TENANT_API_URL_KSA its sign-in,
 * forms and job applications are unavailable instead (the App refuses the
 * same way).
 */
export function getTenantApiUrl(dataRegion?: string | null): string | null {
	const region = (dataRegion || 'us').toLowerCase()
	if (region === 'ksa') return getTenantApiUrlKsa() || null
	return getUsTenantApiUrl()
}
