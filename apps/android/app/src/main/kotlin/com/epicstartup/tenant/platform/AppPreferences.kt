package com.epicstartup.tenant.platform

import android.content.Context
import com.epicstartup.tenant.core.support.SiteAddress

/**
 * Persisted, non-sensitive app preferences (the site this app is connected to
 * and the customer's language choice).
 *
 * Tokens never live here — they are in the Keystore via `KeystoreTokenStorage`.
 */
class AppPreferences(context: Context) {
	private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

	var siteAddress: SiteAddress?
		get() {
			val slug = preferences.getString(KEY_SITE_SLUG, "").orEmpty()
			val host = preferences.getString(KEY_SITE_HOST, "").orEmpty()
			val origin = preferences.getString(KEY_SITE_ORIGIN, "").orEmpty()
			if (slug.isEmpty() && host.isEmpty()) return null
			return SiteAddress(
				slug = slug.ifEmpty { null },
				host = host.ifEmpty { null },
				origin = origin.ifEmpty { null },
			)
		}
		set(value) {
			preferences.edit()
				.putString(KEY_SITE_SLUG, value?.slug.orEmpty())
				.putString(KEY_SITE_HOST, value?.host.orEmpty())
				.putString(KEY_SITE_ORIGIN, value?.origin.orEmpty())
				.apply()
		}

	var languageOverride: String?
		get() = preferences.getString(KEY_LANGUAGE, "").orEmpty().ifEmpty { null }
		set(value) {
			preferences.edit().putString(KEY_LANGUAGE, value.orEmpty()).apply()
		}

	private companion object {
		const val PREFERENCES_NAME = "epic.tenant.preferences"
		const val KEY_SITE_SLUG = "epic.siteSlug"
		const val KEY_SITE_HOST = "epic.siteHost"
		const val KEY_SITE_ORIGIN = "epic.siteOrigin"
		const val KEY_LANGUAGE = "epic.language"
	}
}
