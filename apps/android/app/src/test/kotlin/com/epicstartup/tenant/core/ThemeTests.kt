package com.epicstartup.tenant.core

import com.epicstartup.tenant.core.model.PublicSiteTheme
import com.epicstartup.tenant.core.theme.RgbaColor
import com.epicstartup.tenant.core.theme.SiteColorScheme
import com.epicstartup.tenant.core.theme.SiteColorToken
import com.epicstartup.tenant.core.theme.SiteTheme
import com.epicstartup.tenant.core.theme.SiteThemeTokens
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RgbaColorTest {
	@Test
	fun parsesHexInEveryLength() {
		assertEquals(RgbaColor.of(1.0, 1.0, 1.0), RgbaColor.from("#ffffff"))
		assertEquals(RgbaColor.of(1.0, 0.0, 0.0), RgbaColor.from("#f00"))
		assertEquals(RgbaColor.of(0.0, 0.0, 0.0, 0.0), RgbaColor.from("#00000000"))
		assertEquals(0.5, RgbaColor.from("#ff000080")?.alpha ?: 0.0, 0.01)
		assertNull(RgbaColor.from("#12345"))
		assertNull(RgbaColor.from("#gggggg"))
	}

	@Test
	fun parsesRgbHslAndNamedColors() {
		assertEquals(RgbaColor.of(1.0, 0.0, 0.0), RgbaColor.from("rgb(255, 0, 0)"))
		assertEquals(RgbaColor.of(1.0, 0.0, 0.0), RgbaColor.from("rgb(255 0 0 / 100%)"))
		assertEquals(0.4, RgbaColor.from("rgb(255 0 0 / 40%)")?.alpha ?: 0.0, 0.001)
		assertEquals(RgbaColor.of(1.0, 0.0, 0.0), RgbaColor.from("hsl(0, 100%, 50%)"))
		assertEquals(RgbaColor.of(0.0, 0.0, 0.0, 0.0), RgbaColor.from("transparent"))
		assertNull(RgbaColor.from("color(display-p3 1 0 0)"))
	}

	@Test
	fun parsesOklchLikeTheSiteThemeCompilerEmits() {
		val white = RgbaColor.from("oklch(1 0 0)")
		assertNotNull(white)
		assertEquals(1.0, white.red, 0.002)
		assertEquals(1.0, white.blue, 0.002)

		val nearBlack = RgbaColor.from("oklch(0.145 0 0)")
		assertNotNull(nearBlack)
		assertEquals(0.039388, nearBlack.red, 0.002)

		val blue = RgbaColor.from("oklch(0.488 0.243 264.376)")
		assertNotNull(blue)
		assertTrue(blue.blue > blue.red, "blue channel should dominate")

		// CSS relative color syntax is not understood: the caller keeps its fallback.
		assertNull(RgbaColor.from("oklch(from var(--destructive) min(l, 0.42) c h)"))
		assertNull(RgbaColor.from("oklch(0.5 0.1 not-a-hue)"))
	}

	@Test
	fun convertsToArgbAndBackToHex() {
		val color = RgbaColor.of(1.0, 0.0, 0.0)
		assertEquals(0xFFFF0000.toInt(), color.toArgb())
		assertEquals("#ff0000", color.hexString)
		// hexString is the opaque CSS form; alpha is carried separately.
		assertEquals("#000000", RgbaColor.of(0.0, 0.0, 0.0, 0.0).hexString)
	}

	@Test
	fun reportsLuminanceAndContrast() {
		assertTrue(RgbaColor.white.isLight)
		assertTrue(!RgbaColor.black.isLight)
		assertTrue(RgbaColor.white.contrastRatio(RgbaColor.black) > 20)
	}

	@Test
	fun sanitisesNonFiniteComponents() {
		val color = RgbaColor.of(Double.NaN, 2.0, -1.0, 5.0)
		assertEquals(RgbaColor.of(0.0, 1.0, 0.0, 1.0), color)
	}
}

class SiteThemeTokensTest {
	/** Shape produced by `buildSiteThemeCss()` for an org using the blue theme. */
	private val css = """
		html {
			--background: oklch(1 0 0);
			--foreground: oklch(0.145 0 0);
			--primary: oklch(0.205 0 0);
			--primary-foreground: oklch(0.985 0 0);
			--border: oklch(0.922 0 0);
			--radius: 0.625rem;
		}

		html.dark {
			--background: oklch(0.145 0 0);
			--foreground: oklch(0.985 0 0);
			--primary: oklch(0.488 0.243 264.376);
			--primary-foreground: oklch(0.97 0.014 254.604);
			--radius: 0.625rem;
		}
	""".trimIndent()

	@Test
	fun parsesLightAndDarkTokens() {
		val tokens = SiteThemeTokens.parse(css)

		assertEquals(1.0, tokens.light["background"]?.red ?: 0.0, 0.002)
		assertEquals(0.039388, tokens.light["foreground"]?.red ?: 0.0, 0.002)
		assertNotNull(tokens.dark["primary"])
		assertEquals(0.980256, tokens.dark["foreground"]?.red ?: 0.0, 0.002)
		assertEquals(0.625, tokens.radiusRem ?: 0.0, 0.0001)
	}

	@Test
	fun parsesRadiusInPixels() {
		val tokens = SiteThemeTokens.parse("html { --radius: 12px; }")
		assertEquals(0.75, tokens.radiusRem ?: 0.0, 0.0001)
	}

	@Test
	fun rejectsInvalidRadiusValues() {
		assertNull(SiteThemeTokens.parse("html { --radius: -5rem; }").radiusRem)
		assertNull(SiteThemeTokens.parse("html { --radius: nanrem; }").radiusRem)
		assertNull(SiteThemeTokens.parse("html { --radius: -8px; }").radiusRem)
		assertEquals(0.0, SiteThemeTokens.parse("html { --radius: 0rem; }").radiusRem)
	}

	@Test
	fun ignoresUnknownColorSpaces() {
		val tokens = SiteThemeTokens.parse(
			"html { --primary: color(display-p3 1 0 0); --ring: #ff0000; }",
		)
		assertNull(tokens.light["primary"])
		assertNotNull(tokens.light["ring"])
	}

	@Test
	fun ignoresNonRootSelectors() {
		val tokens = SiteThemeTokens.parse("body { --primary: #ff0000; }")
		assertNull(tokens.light["primary"])
	}
}

class SiteThemeTest {
	@Test
	fun fallsBackToNeutralDefaults() {
		val theme = SiteTheme(null)
		assertEquals(RgbaColor.white, theme.color(SiteColorToken.BACKGROUND, SiteColorScheme.LIGHT))
		assertTrue(
			theme.color(SiteColorToken.BACKGROUND, SiteColorScheme.DARK).relativeLuminance < 0.2,
		)
	}

	@Test
	fun resolvesThemeMode() {
		val dark = SiteTheme(PublicSiteTheme(mode = "dark", css = "html { --primary: #ff0000; }"))
		assertEquals(SiteColorScheme.DARK, dark.resolvedScheme(systemIsDark = false))

		val system = SiteTheme(PublicSiteTheme(mode = "system"))
		assertEquals(SiteColorScheme.LIGHT, system.resolvedScheme(systemIsDark = false))
		assertEquals(SiteColorScheme.DARK, system.resolvedScheme(systemIsDark = true))
		assertNull(system.preferredScheme)
	}

	@Test
	fun convertsRadiusToPixels() {
		val theme = SiteTheme(PublicSiteTheme(css = "html { --radius: 0.5rem; }"))
		assertEquals(8.0, theme.radiusPx(), 0.0001)
		assertEquals(5.6, theme.radiusPx(0.7), 0.0001)
		assertEquals(10.0, SiteTheme(null).radiusPx(), 0.0001)
	}

	@Test
	fun mapsFontIdsToPlatformFamilies() {
		val serif = SiteTheme(PublicSiteTheme(headingFont = "merriweather", bodyFont = "inter"))
		assertEquals("serif", serif.fontFamily(com.epicstartup.tenant.core.theme.SiteFontRole.HEADING))
		assertEquals("sans-serif", serif.fontFamily(com.epicstartup.tenant.core.theme.SiteFontRole.BODY))

		val mono = SiteTheme(PublicSiteTheme(bodyFont = "jetbrains-mono"))
		assertEquals("monospace", mono.fontFamily(com.epicstartup.tenant.core.theme.SiteFontRole.BODY))
	}
}
