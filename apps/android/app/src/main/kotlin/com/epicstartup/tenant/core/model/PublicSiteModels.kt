package com.epicstartup.tenant.core.model

import com.epicstartup.tenant.core.support.JwtPayload
import com.epicstartup.tenant.core.support.arrayOrNull
import com.epicstartup.tenant.core.support.booleanOrNull
import com.epicstartup.tenant.core.support.objectOrNull
import com.epicstartup.tenant.core.support.stringListOrNull
import com.epicstartup.tenant.core.support.stringOrNull
import org.json.JSONObject

// MARK: - Site theme (branding)

data class PublicSiteCustomFont(
	val url: String,
	val format: String,
) {
	companion object {
		fun fromJson(json: JSONObject?): PublicSiteCustomFont? {
			if (json == null) return null
			val url = json.stringOrNull("url") ?: return null
			return PublicSiteCustomFont(url = url, format = json.stringOrNull("format") ?: "woff2")
		}
	}
}

/**
 * Mirrors `PublicSiteTheme` in `apps/sites/src/lib/org.ts`.
 *
 * `css` is the org's compiled shadcn theme (CSS custom properties in `oklch()`),
 * which `SiteThemeTokens.parse(css:)` turns into native colors.
 */
data class PublicSiteTheme(
	val baseColor: String? = null,
	val theme: String? = null,
	val radius: String? = null,
	val mode: String? = null,
	val headingFont: String? = null,
	val bodyFont: String? = null,
	val headingCustomFont: PublicSiteCustomFont? = null,
	val bodyCustomFont: PublicSiteCustomFont? = null,
	val css: String? = null,
) {
	companion object {
		fun fromJson(json: JSONObject?): PublicSiteTheme? {
			if (json == null) return null
			return PublicSiteTheme(
				baseColor = json.stringOrNull("baseColor"),
				theme = json.stringOrNull("theme"),
				radius = json.stringOrNull("radius"),
				mode = json.stringOrNull("mode"),
				headingFont = json.stringOrNull("headingFont"),
				bodyFont = json.stringOrNull("bodyFont"),
				headingCustomFont = PublicSiteCustomFont.fromJson(json.objectOrNull("headingCustomFont")),
				bodyCustomFont = PublicSiteCustomFont.fromJson(json.objectOrNull("bodyCustomFont")),
				css = json.stringOrNull("css"),
			)
		}
	}
}

data class PublicSiteAnnouncement(
	val id: String,
	val content: String,
	val type: String,
	val linkUrl: String? = null,
	val linkLabel: String? = null,
	val linkNewTab: Boolean? = null,
) {
	companion object {
		fun fromJson(json: JSONObject): PublicSiteAnnouncement = PublicSiteAnnouncement(
			id = json.stringOrNull("id") ?: "",
			content = json.stringOrNull("content") ?: "",
			type = json.stringOrNull("type") ?: "info",
			linkUrl = json.stringOrNull("linkUrl"),
			linkLabel = json.stringOrNull("linkLabel"),
			linkNewTab = json.booleanOrNull("linkNewTab"),
		)
	}
}

data class PublicSiteIcon(
	val original: String,
	val favicon32: String? = null,
	val favicon16: String? = null,
	val appleTouchIcon: String? = null,
) {
	companion object {
		fun fromJson(json: JSONObject?): PublicSiteIcon? {
			if (json == null) return null
			val original = json.stringOrNull("original") ?: return null
			return PublicSiteIcon(
				original = original,
				favicon32 = json.stringOrNull("favicon32"),
				favicon16 = json.stringOrNull("favicon16"),
				appleTouchIcon = json.stringOrNull("appleTouchIcon"),
			)
		}
	}
}

/**
 * Mirrors `PublicOrganization` in `apps/sites/src/lib/org.ts` — the payload of
 * `GET {app}/resources/sites?slug=…|host=…`.
 *
 * The app uses it purely for branding: name, icon, theme, and locale.
 */
data class PublicOrganization(
	val id: String,
	val name: String,
	val slug: String,
	val customDomain: String? = null,
	val dataRegion: String? = null,
	val theme: PublicSiteTheme? = null,
	val locales: List<String>? = null,
	val defaultLocale: String? = null,
	val locale: String? = null,
	val siteIcon: PublicSiteIcon? = null,
	val announcements: List<PublicSiteAnnouncement>? = null,
	val facebookPixelId: String? = null,
	val googleTagManagerId: String? = null,
	val googleAnalyticsId: String? = null,
	val tiktokPixelId: String? = null,
) {
	/** Region used to pick the tenant-api node that holds this org's customer data. */
	val resolvedDataRegion: String
		get() {
			val value = (dataRegion ?: "us").trim()
			return if (value.isEmpty()) "us" else value.lowercase()
		}

	val resolvedLocales: List<String>
		get() {
			val values = locales.orEmpty().filter { it.isNotEmpty() }
			return values.ifEmpty { listOf("en") }
		}

	val resolvedDefaultLocale: String
		get() = defaultLocale?.takeIf { it.isNotEmpty() } ?: "en"

	val resolvedLocale: String
		get() = locale?.takeIf { it.isNotEmpty() } ?: resolvedDefaultLocale

	/** Absolute URL for the org's site icon (`/resources/images?…` is relative to the App). */
	fun iconUrl(baseUrl: String): String? {
		val original = siteIcon?.original?.takeIf { it.isNotEmpty() } ?: return null
		if (original.startsWith("http://") || original.startsWith("https://")) return original
		val path = if (original.startsWith("/")) original else "/$original"
		return baseUrl.trimEnd('/') + path
	}

	companion object {
		fun fromJson(json: JSONObject): PublicOrganization? {
			val id = json.stringOrNull("id") ?: return null
			val name = json.stringOrNull("name") ?: return null
			val slug = json.stringOrNull("slug") ?: return null
			return PublicOrganization(
				id = id,
				name = name,
				slug = slug,
				customDomain = json.stringOrNull("customDomain"),
				dataRegion = json.stringOrNull("dataRegion"),
				theme = PublicSiteTheme.fromJson(json.objectOrNull("theme")),
				locales = json.stringListOrNull("locales"),
				defaultLocale = json.stringOrNull("defaultLocale"),
				locale = json.stringOrNull("locale"),
				siteIcon = PublicSiteIcon.fromJson(json.objectOrNull("siteIcon")),
				announcements = json.arrayOrNull("announcements")?.let { array ->
					(0 until array.length()).mapNotNull { index ->
						array.optJSONObject(index)?.let(PublicSiteAnnouncement::fromJson)
					}
				},
				facebookPixelId = json.stringOrNull("facebookPixelId"),
				googleTagManagerId = json.stringOrNull("googleTagManagerId"),
				googleAnalyticsId = json.stringOrNull("googleAnalyticsId"),
				tiktokPixelId = json.stringOrNull("tiktokPixelId"),
			)
		}
	}
}

// MARK: - Customer

data class CustomerProfile(
	val id: String? = null,
	val name: String? = null,
	val email: String? = null,
	val phone: String? = null,
	val needsName: Boolean? = null,
) {
	companion object {
		fun fromJson(json: JSONObject): CustomerProfile = CustomerProfile(
			id = json.stringOrNull("id"),
			name = json.stringOrNull("name"),
			email = json.stringOrNull("email"),
			phone = json.stringOrNull("phone"),
			needsName = json.booleanOrNull("needsName"),
		)
	}
}

data class AuthTokens(
	val accessToken: String,
	val refreshToken: String? = null,
) {
	val orgId: String? get() = JwtPayload.decode(accessToken)?.orgId

	val customerId: String? get() = JwtPayload.decode(accessToken)?.customerId

	val name: String? get() = JwtPayload.decode(accessToken)?.name

	val firstName: String?
		get() = name?.takeIf { it.isNotEmpty() }?.split(" ")?.firstOrNull()
}

data class VerifyResult(
	val success: Boolean? = null,
	val accessToken: String? = null,
	val refreshToken: String? = null,
	val needsName: Boolean? = null,
	val error: String? = null,
) {
	companion object {
		fun fromJson(json: JSONObject): VerifyResult = VerifyResult(
			success = json.booleanOrNull("success"),
			accessToken = json.stringOrNull("accessToken"),
			refreshToken = json.stringOrNull("refreshToken"),
			needsName = json.booleanOrNull("needsName"),
			error = json.stringOrNull("error"),
		)
	}
}
