/**
 * This file contains utilities for using client hints for user preference which
 * are needed by the server, but are only known by the browser.
 */
import { getHintUtils } from '@epic-web/client-hints'
import {
	clientHint as colorSchemeHint,
	subscribeToSchemeChange,
} from '@epic-web/client-hints/color-scheme'
import { clientHint as timeZoneHint } from '@epic-web/client-hints/time-zone'
import * as React from 'react'
import { useRevalidator } from 'react-router'

const hintsUtils = getHintUtils({
	theme: colorSchemeHint,
	timeZone: timeZoneHint,
	// add other hints here
})

export const { getHints } = hintsUtils

function clientHintCookieDomainAttribute(cookieDomain?: string) {
	return cookieDomain ? `; Domain=${cookieDomain}` : ''
}

/** Injects `Domain=` into inline client-hint cookies (defaults are host-only). */
export function getClientHintCheckScript(cookieDomain?: string) {
	const script = hintsUtils.getClientHintCheckScript()
	if (!cookieDomain) return script
	const domainAttr = clientHintCookieDomainAttribute(cookieDomain)
	return script.replace(/; path=\//gi, `; path=/${domainAttr}`)
}

/**
 * @returns inline script element that checks for client hints and sets cookies
 * if they are not set then reloads the page if any cookie was set to an
 * inaccurate value.
 */
export function ClientHintCheck({
	nonce,
	cookieDomain,
}: {
	nonce: string
	cookieDomain?: string
}) {
	const { revalidate } = useRevalidator()
	React.useEffect(() => {
		if (!cookieDomain) {
			return subscribeToSchemeChange(() => revalidate())
		}

		const schemaMatch = window.matchMedia('(prefers-color-scheme: dark)')
		const domainAttr = clientHintCookieDomainAttribute(cookieDomain)

		function handleThemeChange() {
			const value = schemaMatch.matches ? 'dark' : 'light'
			document.cookie = `${colorSchemeHint.cookieName}=${value}; Max-Age=31536000; SameSite=Lax; path=/${domainAttr}`
			void revalidate()
		}

		schemaMatch.addEventListener('change', handleThemeChange)
		return () => schemaMatch.removeEventListener('change', handleThemeChange)
	}, [revalidate, cookieDomain])

	return (
		<script
			nonce={nonce}
			dangerouslySetInnerHTML={{
				__html: getClientHintCheckScript(cookieDomain),
			}}
		/>
	)
}
