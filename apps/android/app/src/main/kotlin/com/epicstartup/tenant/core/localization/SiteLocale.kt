package com.epicstartup.tenant.core.localization

import com.epicstartup.tenant.core.model.PublicOrganization

/**
 * Content locales shared with the org Sites app
 * (`packages/common/src/site-locales.ts`).
 */
object SiteLocale {
	val contentLocales = listOf("en", "ar", "es", "fr", "de", "zh")

	private val labels = mapOf(
		"en" to "English",
		"ar" to "Arabic",
		"es" to "Spanish",
		"fr" to "French",
		"de" to "German",
		"zh" to "Chinese",
	)

	/** Matches `RTL_SITE_LOCALES` on the web side. */
	val rtlLocales = setOf("ar")

	fun isSupported(code: String): Boolean = contentLocales.contains(normalized(code))

	fun label(code: String): String = labels[normalized(code)] ?: code

	fun isRtl(code: String): Boolean = rtlLocales.contains(normalized(code))

	/** `"ar-SA"` → `"ar"`, `"EN"` → `"en"`. */
	fun normalized(code: String): String {
		val trimmed = code.trim().lowercase()
		if (trimmed.isEmpty()) return "en"
		return trimmed.substringBefore('-').ifEmpty { trimmed }
	}

	/**
	 * Mirrors `negotiateSiteLocale()`: exact match first, then language-only.
	 * Returns `null` when nothing matches (callers decide the fallback).
	 */
	fun match(preferred: List<String>, supported: List<String>): String? {
		val candidates = supported.map { normalized(it) }
		for (preference in preferred) {
			val exact = preference.trim().lowercase()
			if (exact.isEmpty()) continue
			val base = exact.substringBefore('-')
			val found = candidates.firstOrNull { it == exact } ?: candidates.firstOrNull { it == base }
			if (found != null) return found
		}
		return null
	}

	/**
	 * Mirrors `negotiateSiteLocale()`: exact match, then language-only, then the
	 * org default, then the first supported locale.
	 */
	fun negotiate(preferred: List<String>, supported: List<String>, defaultLocale: String): String {
		match(preferred, supported)?.let { return it }
		val candidates = supported.map(::normalized)
		val fallback = normalized(defaultLocale)
		if (candidates.contains(fallback)) return fallback
		return candidates.firstOrNull() ?: "en"
	}
}

/**
 * The language the app UI renders in.
 *
 * Resolution order:
 * 1. an explicit customer override (Profile → Language),
 * 2. the device's preferred languages, when the app has that translation,
 * 3. the locale the org negotiated for this device (the `locale` field of the
 *    `/resources/sites` payload) — so a KSA tenant still gets Arabic chrome on
 *    a phone set to a language we do not ship,
 * 4. the org's default locale, then English.
 */
data class AppLanguage(val code: String = "en") {
	val isRtl: Boolean get() = SiteLocale.isRtl(code)

	val displayName: String get() = SiteLocale.label(code)

	/** Locale tag for formatting (numbers, dates) and RTL layout direction. */
	val localeTag: String get() = code

	companion object {
		fun resolve(
			organization: PublicOrganization?,
			deviceLanguages: List<String>,
			appLocales: List<String>,
			override: String? = null,
		): AppLanguage {
			val supported = appLocales.ifEmpty { SiteLocale.contentLocales }
			val translated = supported.map { SiteLocale.normalized(it) }

			if (!override.isNullOrEmpty()) {
				return AppLanguage(
					SiteLocale.negotiate(listOf(override), supported, defaultLocale = "en"),
				)
			}

			SiteLocale.match(deviceLanguages, translated)?.let { return AppLanguage(it) }

			if (organization != null) {
				val orgMatch = SiteLocale.negotiate(
					preferred = listOf(organization.resolvedLocale, organization.resolvedDefaultLocale),
					supported = translated,
					defaultLocale = "en",
				)
				return AppLanguage(orgMatch)
			}

			return AppLanguage("en")
		}
	}
}
