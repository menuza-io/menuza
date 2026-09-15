package com.epicstartup.tenant.ui

import android.graphics.Typeface
import com.epicstartup.tenant.core.theme.SiteColorScheme
import com.epicstartup.tenant.core.theme.SiteColorToken
import com.epicstartup.tenant.core.theme.SiteFontRole
import com.epicstartup.tenant.core.theme.SiteTheme

/**
 * The org's theme resolved to Android values.
 *
 * The Android equivalent of `ThemePalette` in apps/ios: everything the UI paints
 * comes from here, so a tenant's branding flows through every screen.
 */
class ThemePalette(private val theme: SiteTheme, val scheme: SiteColorScheme) {
	private fun color(token: SiteColorToken): Int = theme.color(token, scheme).toArgb()

	val background = color(SiteColorToken.BACKGROUND)
	val foreground = color(SiteColorToken.FOREGROUND)
	val card = color(SiteColorToken.CARD)
	val cardForeground = color(SiteColorToken.CARD_FOREGROUND)
	val muted = color(SiteColorToken.MUTED)
	val mutedForeground = color(SiteColorToken.MUTED_FOREGROUND)
	val primary = color(SiteColorToken.PRIMARY)
	val primaryForeground = color(SiteColorToken.PRIMARY_FOREGROUND)
	val accent = color(SiteColorToken.ACCENT)
	val accentForeground = color(SiteColorToken.ACCENT_FOREGROUND)
	val destructive = color(SiteColorToken.DESTRUCTIVE)
	val destructiveForeground = color(SiteColorToken.DESTRUCTIVE_FOREGROUND)
	val border = color(SiteColorToken.BORDER)
	val input = color(SiteColorToken.INPUT)

	val radiusPx: Float = theme.radiusPx().toFloat()
	/** `rounded-[calc(var(--radius)*0.7)]` in the Astro components. */
	val controlRadiusPx: Float = theme.radiusPx(0.7).toFloat().coerceAtLeast(6f)
	/** `rounded-[calc(var(--radius)-2px)]` for fields. */
	val fieldRadiusPx: Float = (theme.radiusPx() - 2).toFloat().coerceAtLeast(6f)

	val headingTypeface: Typeface = Typeface.create(theme.fontFamily(SiteFontRole.HEADING), Typeface.NORMAL)
	val headingBoldTypeface: Typeface = Typeface.create(theme.fontFamily(SiteFontRole.HEADING), Typeface.BOLD)
	val bodyTypeface: Typeface = Typeface.create(theme.fontFamily(SiteFontRole.BODY), Typeface.NORMAL)
	val bodyBoldTypeface: Typeface = Typeface.create(theme.fontFamily(SiteFontRole.BODY), Typeface.BOLD)

	companion object {
		/** Used before branding loads, and when a tenant has no theme. */
		fun fallback(scheme: SiteColorScheme): ThemePalette = ThemePalette(SiteTheme.fallback, scheme)
	}
}
