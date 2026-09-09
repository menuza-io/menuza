/**
 * GitHub Actions Variables derived from launch.config.json.
 * Shared by launch-setup.mjs and setup-workers-builds.mjs.
 */

/** @param {Record<string, unknown>} config */
export function getGhVariables(config) {
	const prod = config.bindings.production
	const staging = config.bindings.staging
	const urls = config.urls

	return [
		['APP_D1_DATABASE_ID', prod.app.d1_database_id],
		['APP_KV_NAMESPACE_ID', prod.app.kv_namespace_id],
		['APP_SITES_DATA_KV_ID', prod.app.sites_data_kv_id],
		['APP_WORKER_NAME', prod.app.worker_name],
		['ADMIN_D1_DATABASE_ID', prod.admin.d1_database_id],
		['ADMIN_KV_NAMESPACE_ID', prod.admin.kv_namespace_id],
		['ADMIN_WORKER_NAME', prod.admin.worker_name],
		['WEB_D1_DATABASE_ID', prod.web.d1_database_id],
		['WEB_R2_BUCKET_NAME', prod.web.r2_bucket_name],
		['WEB_WORKER_NAME', prod.web.worker_name],
		['SITES_WORKER_NAME', prod.sites.worker_name],
		['SITES_DATA_KV_ID', prod.sites.sites_data_kv_id],
		['JOBS_CRON_WORKER_NAME', prod.jobs_cron.worker_name],
		['TENANT_API_US_WORKER_NAME', prod.tenant_api.worker_name],
		['APP_BASE_URL', urls.app_base_url],
		['ADMIN_BASE_URL', urls.admin_base_url],
		['WEB_BASE_URL', urls.web_base_url],
		['PUBLIC_APP_URL', urls.public_app_url],
		['ROOT_APP', urls.root_app],
		['ROOT_APP_STAGING', urls.root_app_staging],
		['PUBLIC_SITE_HOST_SUFFIXES', urls.public_site_host_suffixes],
		[
			'PUBLIC_SITE_HOST_SUFFIXES_STAGING',
			urls.public_site_host_suffixes_staging,
		],
		['PUBLIC_APP_URL_STAGING', urls.public_app_url_staging],
		['TENANT_API_URL', urls.tenant_api_url],
		['TENANT_API_URL_KSA', urls.tenant_api_url_ksa],
		['JOBS_CRON_WORKER_URL', urls.jobs_cron_worker_url],
		['DOCS_URL', urls.docs_url],
		['APP_BASE_URL_STAGING', urls.app_base_url_staging],
		['ADMIN_BASE_URL_STAGING', urls.admin_base_url_staging],
		['WEB_BASE_URL_STAGING', urls.web_base_url_staging],
		['TENANT_API_URL_STAGING', urls.tenant_api_url_staging],
		['JOBS_CRON_WORKER_URL_STAGING', urls.jobs_cron_worker_url_staging],
		['DOCS_URL_STAGING', urls.docs_url_staging],
		['APP_D1_DATABASE_ID_STAGING', staging.app.d1_database_id],
		['APP_KV_NAMESPACE_ID_STAGING', staging.app.kv_namespace_id],
		['APP_SITES_DATA_KV_ID_STAGING', staging.app.sites_data_kv_id],
		['APP_WORKER_NAME_STAGING', staging.app.worker_name],
		['ADMIN_D1_DATABASE_ID_STAGING', staging.admin.d1_database_id],
		['ADMIN_KV_NAMESPACE_ID_STAGING', staging.admin.kv_namespace_id],
		['ADMIN_WORKER_NAME_STAGING', staging.admin.worker_name],
		['WEB_D1_DATABASE_ID_STAGING', staging.web.d1_database_id],
		['WEB_R2_BUCKET_NAME_STAGING', staging.web.r2_bucket_name],
		['WEB_WORKER_NAME_STAGING', staging.web.worker_name],
		['SITES_WORKER_NAME_STAGING', staging.sites.worker_name],
		['SITES_DATA_KV_ID_STAGING', staging.sites.sites_data_kv_id],
		['JOBS_CRON_WORKER_NAME_STAGING', staging.jobs_cron.worker_name],
		['TENANT_API_US_WORKER_NAME_STAGING', staging.tenant_api.worker_name],
	]
}

/** @param {ReturnType<typeof getGhVariables>} variables */
export function ghVariablesToBuildEnv(variables) {
	/** @type {Record<string, { value: string, is_secret: boolean }>} */
	const env = {
		// Stay on Node 22 while satisfying React Router's current requirement.
		// Node 22.23.2 is preinstalled on the
		// Cloudflare Workers Builds image, so selecting it avoids a download.
		NODE_VERSION: { value: '22.23.2', is_secret: false },
		// Ensure ample heap space for React Router SSR and Vite bundling.
		NODE_OPTIONS: { value: '--max-old-space-size=6144', is_secret: false },
		// Ensure Cloudflare-specific bundle flags (sourcemap suppression, worker aliases).
		DEPLOY_TARGET: { value: 'cloudflare', is_secret: false },
		// cf-workers-ci.mjs performs the repository's hardened npm ci flow itself.
		// Disable Cloudflare's implicit install so dependencies are not installed twice.
		SKIP_DEPENDENCY_INSTALL: { value: '1', is_secret: false },
	}
	for (const [name, value] of variables) {
		if (!value) continue
		env[name] = { value: String(value), is_secret: false }
	}
	return env
}
