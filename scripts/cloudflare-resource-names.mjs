/**
 * Canonical Cloudflare resource names for Epic Startup template.
 *
 * All names use the `epic-startup` prefix so `npm run setup` (setup-brand.mjs)
 * can replace `epic-startup` with the user's short-name slug across wrangler
 * configs, launch scripts, and docs.
 *
 * @see scripts/setup-brand.mjs
 */

/** @type {const} */
export const CF_RESOURCE_PREFIX = 'epic-startup'

export const CF_D1 = {
	app: `${CF_RESOURCE_PREFIX}-db`,
	appStaging: `${CF_RESOURCE_PREFIX}-db-staging`,
	web: `${CF_RESOURCE_PREFIX}-web-db`,
	webStaging: `${CF_RESOURCE_PREFIX}-web-db-staging`,
}

export const CF_KV = {
	app: `${CF_RESOURCE_PREFIX}-cache`,
	appStaging: `${CF_RESOURCE_PREFIX}-cache-staging`,
	sitesData: `${CF_RESOURCE_PREFIX}-sites-data`,
	sitesDataStaging: `${CF_RESOURCE_PREFIX}-sites-data-staging`,
}

export const CF_R2 = {
	web: `${CF_RESOURCE_PREFIX}-media`,
	webStaging: `${CF_RESOURCE_PREFIX}-media-staging`,
	turboCache: `${CF_RESOURCE_PREFIX}-turbo-cache`,
}
