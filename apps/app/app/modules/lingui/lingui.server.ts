import {
	operatorSessionCookieDomain,
	operatorSharedCookieDomain,
} from '@repo/common/cookie-domain'
import { createLocaleCookie, createLinguiServer } from '@repo/i18n/server'
import config from '../../../lingui.config.ts'
import { loadCatalog } from './lingui.ts'

const localeCookie = createLocaleCookie()

let localeCookieWithDomain: ReturnType<typeof createLocaleCookie> | undefined

function getLocaleCookieWithDomain() {
	localeCookieWithDomain ??= createLocaleCookie('lng', {
		domain: operatorSessionCookieDomain(),
	})
	return localeCookieWithDomain
}

export const linguiServer = createLinguiServer(config, localeCookie)

export async function serializeLocaleCookie(locale: string, request: Request) {
	const domain = operatorSharedCookieDomain(request)
	const cookie = domain ? getLocaleCookieWithDomain() : localeCookie
	return cookie.serialize(locale, domain ? { domain } : undefined)
}

/** Activate catalogs before loaders/actions that call `t`. Data requests skip entry.server. */
export async function ensureLinguiRequestLocale(request: Request) {
	const locale = await linguiServer.getLocale(request)
	await loadCatalog(locale)
	return locale
}
