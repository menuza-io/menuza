package com.epicstartup.tenant.core.theme

import com.epicstartup.tenant.core.model.PublicSiteTheme

enum class SiteFontRole {
	HEADING,
	BODY,
}

/**
 * The org's resolved branding: colors, corner radius, and typography.
 *
 * This is the native equivalent of the `data-site-theme` attributes and
 * `--token` CSS variables that `apps/sites` injects into every page.
 */
data class SiteTheme(
	val tokens: SiteThemeTokens,
	/** `light` | `dark` | `system` */
	val mode: String,
	val baseColor: String?,
	val themeName: String?,
	val headingFontId: String,
	val bodyFontId: String,
	val headingCustomFontUrl: String?,
	val bodyCustomFontUrl: String?,
) {
	constructor(theme: PublicSiteTheme?) : this(
		tokens = SiteThemeTokens.parse(theme?.css.orEmpty()),
		mode = theme?.mode?.takeIf { it.isNotEmpty() } ?: "system",
		baseColor = theme?.baseColor,
		themeName = theme?.theme,
		headingFontId = theme?.headingFont?.takeIf { it.isNotEmpty() } ?: "inter",
		bodyFontId = theme?.bodyFont?.takeIf { it.isNotEmpty() } ?: "inter",
		headingCustomFontUrl = theme?.headingCustomFont?.url?.takeIf { it.isNotBlank() },
		bodyCustomFontUrl = theme?.bodyCustomFont?.url?.takeIf { it.isNotBlank() },
	)

	fun resolvedScheme(systemIsDark: Boolean): SiteColorScheme = when (mode.lowercase()) {
		"dark" -> SiteColorScheme.DARK
		"light" -> SiteColorScheme.LIGHT
		else -> if (systemIsDark) SiteColorScheme.DARK else SiteColorScheme.LIGHT
	}

	/** `light` / `dark` / `null` (follow the system). */
	val preferredScheme: SiteColorScheme?
		get() = when (mode.lowercase()) {
			"dark" -> SiteColorScheme.DARK
			"light" -> SiteColorScheme.LIGHT
			else -> null
		}

	fun color(token: SiteColorToken, scheme: SiteColorScheme): RgbaColor =
		tokens.color(token, scheme) ?: SiteThemeDefaults.color(token, scheme)

	/**
	 * CSS `--radius` (rem) → pixels at the platform's 16px rem. Mirrors
	 * `rounded-[var(--radius)]` in the Astro components.
	 */
	fun radiusPx(scale: Double = 1.0): Double = (tokens.radiusRem ?: 0.625) * 16 * scale

	/**
	 * Best-effort mapping from a Sites font id to an Android font family.
	 *
	 * Android ships a small set of families, and the app never downloads remote
	 * fonts (that would cost megabytes and an offline hole), so this is a
	 * role-aware fallback rather than an exact match: serif ids render serif,
	 * mono ids render mono, everything else uses the platform sans.
	 */
	fun fontFamily(role: SiteFontRole): String {
		val id = if (role == SiteFontRole.HEADING) headingFontId else bodyFontId
		return when (id) {
			in monospaceFontIds -> "monospace"
			in serifFontIds -> "serif"
			else -> "sans-serif"
		}
	}

	companion object {
		val fallback = SiteTheme(null)

		private val serifFontIds = setOf(
			"noto-serif",
			"roboto-slab",
			"merriweather",
			"lora",
		)

		private val monospaceFontIds = setOf(
			"jetbrains-mono",
			"geist-mono",
		)
	}
}
