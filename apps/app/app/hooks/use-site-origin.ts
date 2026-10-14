import { getOrgSiteUrl } from '@repo/common/url'
import { useEffect, useState } from 'react'

/**
 * Where an organization's public site lives: its connected domain when it has
 * one, otherwise `{slug}.{this app's base domain}`. The base domain comes from
 * the browser address, so the first render uses the server's default and the
 * browser corrects it once it has mounted.
 */
export function useSiteOrigin(
	orgSlug: string,
	customDomain: string | null,
): string {
	const [origin, setOrigin] = useState(() =>
		customDomain ? `https://${customDomain}` : getOrgSiteUrl(orgSlug),
	)
	useEffect(() => {
		setOrigin(customDomain ? `https://${customDomain}` : getOrgSiteUrl(orgSlug))
	}, [orgSlug, customDomain])
	return origin.replace(/\/$/, '')
}
