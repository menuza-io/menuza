package com.epicstartup.tenant.core.support

/**
 * How the app is bound to one tenant (org).
 *
 * Sites resolves the org from the request `Host`; a native app has no host, so
 * the binding is captured here and sent to tenant-api as `slug`/`host` plus —
 * in production — an `Origin` header equal to the tenant's public site origin.
 * That keeps tenant-api's existing origin↔org binding rules intact: the app can
 * only ever authenticate customers of the org whose site it claims to be.
 */
data class SiteAddress(
	val slug: String? = null,
	val host: String? = null,
	val origin: String? = null,
) {
	/** Whether this address actually binds the app to one tenant. */
	val isBound: Boolean
		get() = !slug.isNullOrEmpty() || !host.isNullOrEmpty()

	/**
	 * The `Origin` header is only meaningful (and only accepted by tenant-api)
	 * for real https origins. Local dev falls back to slug/host binding, which
	 * tenant-api allows outside production.
	 */
	val authOriginHeader: String?
		get() {
			val value = origin ?: return null
			if (!value.lowercase().startsWith("https://")) return null
			return value.trim('/')
		}

	/** `host` wins over `slug`, matching the Sites resolution order. */
	val queryItems: List<Pair<String, String>>
		get() = when {
			!host.isNullOrEmpty() -> listOf("host" to host)
			!slug.isNullOrEmpty() -> listOf("slug" to slug)
			else -> emptyList()
		}

	val displayName: String
		get() = host ?: slug ?: "your site"

	companion object {
		/**
		 * Picks the binding a running app should use.
		 *
		 * A build that ships bound to one tenant (white-label) always wins: the
		 * tenant is baked into the binary, so an address the customer typed into
		 * an earlier un-branded install must not silently re-point the app at
		 * another tenant. Un-branded builds keep whatever the customer chose.
		 */
		fun resolve(build: SiteAddress, stored: SiteAddress?): SiteAddress =
			if (build.isBound) build else stored ?: build

		/**
		 * Parses what a customer types on the "connect to your site" screen:
		 * `acme`, `acme.epic-startup.com`, `https://www.acme.com`,
		 * `acme.localhost:3010`.
		 */
		fun parse(input: String, brandDomain: String): SiteAddress? {
			var value = input.trim().lowercase()
			if (value.isEmpty()) return null

			var scheme = "https"
			val schemeSeparator = value.indexOf("://")
			if (schemeSeparator >= 0) {
				scheme = value.substring(0, schemeSeparator)
				value = value.substring(schemeSeparator + 3)
			}
			value = value.substringBefore('/').substringBefore('?').trim()
			if (value.isEmpty()) return null

			val brand = brandDomain.lowercase()
			val hostname = value.substringBefore(':')

			if (!hostname.contains('.')) {
				// Bare slug → derive the site origin from the platform domain.
				val slug = hostname
				if (slug.isEmpty()) return null
				return SiteAddress(slug = slug, host = null, origin = "https://$slug.$brand")
			}

			val origin = "$scheme://$value"
			if (hostname.endsWith(".$brand")) {
				val slug = hostname.dropLast(brand.length + 1)
				if (slug.isEmpty() || slug.contains('.')) {
					return SiteAddress(slug = null, host = hostname, origin = origin)
				}
				return SiteAddress(slug = slug, host = null, origin = origin)
			}
			return SiteAddress(slug = null, host = hostname, origin = origin)
		}
	}
}
