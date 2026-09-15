package com.epicstartup.tenant.platform

import android.content.Context
import com.epicstartup.tenant.R
import com.epicstartup.tenant.core.config.TenantConfiguration

/**
 * Reads the build's endpoints out of resources, where `app/build.gradle.kts`
 * put them from `app/tenant.properties` (written by `scripts/generate-tenant.mjs`).
 */
object AndroidTenantConfiguration {
	fun from(context: Context): TenantConfiguration = TenantConfiguration.from(
		appUrl = context.getString(R.string.tenant_app_base_url),
		tenantApiUs = context.getString(R.string.tenant_api_us_base_url),
		tenantApiKsa = context.getString(R.string.tenant_api_ksa_base_url),
		useTls = context.resources.getBoolean(R.bool.tenant_use_tls),
		brandDomain = context.getString(R.string.tenant_brand_domain),
		siteSlug = context.getString(R.string.tenant_site_slug),
		siteHost = context.getString(R.string.tenant_site_host),
		siteOrigin = context.getString(R.string.tenant_site_origin),
		requestTimeoutMs = context.resources.getInteger(R.integer.tenant_request_timeout_ms),
	)
}
