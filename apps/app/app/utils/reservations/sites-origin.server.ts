import { getBrandDomain, getLocalDomain } from '@repo/config/brand'

const LOCAL_SITES_PORT = 3008

type SitesOriginInput = {
	slug: string
	customDomain: string | null
	/** App origin; only used to infer the Sites apex and port, never returned. */
	baseUrl: string
	/** Comma-separated override of the Sites apex (and port), first entry wins. */
	hostSuffixes?: string | null
}

function isLocalHost(hostname: string): boolean {
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname.endsWith('.localhost')
	)
}

/**
 * Public origin of an organization's published Sites, used for guest-facing
 * links (manage, status). The App origin has no `/reserve` pages, so it must
 * never be returned.
 */
export function resolveSitesOrigin(input: SitesOriginInput): string {
	if (input.customDomain) return `https://${input.customDomain}`

	const slug = input.slug.toLowerCase()
	const override = input.hostSuffixes?.split(',')[0]?.trim().replace(/^\./, '')
	if (override) {
		const protocol = isLocalHost(override.split(':')[0] ?? '')
			? 'http'
			: 'https'
		return `${protocol}://${slug}.${override}`
	}

	let app: URL | null = null
	try {
		app = new URL(input.baseUrl)
	} catch {
		app = null
	}

	if (!app || isLocalHost(app.hostname)) {
		return `http://${slug}.${getLocalDomain()}:${LOCAL_SITES_PORT}`
	}

	const labels = app.hostname.split('.')
	const apex =
		labels.length > 2 && labels[0] === 'app'
			? labels.slice(1).join('.')
			: getBrandDomain()
	const port = app.port ? `:${app.port}` : ''
	return `${app.protocol}//${slug}.${apex}${port}`
}
