package com.epicstartup.tenant.core.theme

enum class SiteColorScheme {
	LIGHT,
	DARK,
}

/** Semantic color tokens used by the Sites design system (shadcn `--token` names). */
enum class SiteColorToken(val tokenName: String) {
	BACKGROUND("background"),
	FOREGROUND("foreground"),
	CARD("card"),
	CARD_FOREGROUND("card-foreground"),
	POPOVER("popover"),
	POPOVER_FOREGROUND("popover-foreground"),
	PRIMARY("primary"),
	PRIMARY_FOREGROUND("primary-foreground"),
	SECONDARY("secondary"),
	SECONDARY_FOREGROUND("secondary-foreground"),
	MUTED("muted"),
	MUTED_FOREGROUND("muted-foreground"),
	ACCENT("accent"),
	ACCENT_FOREGROUND("accent-foreground"),
	DESTRUCTIVE("destructive"),
	DESTRUCTIVE_FOREGROUND("destructive-foreground"),
	BORDER("border"),
	INPUT("input"),
	RING("ring"),
}

/**
 * The `--token: oklch(…)` map compiled by the App (`buildSiteThemeCss`).
 *
 * Parsing is intentionally forgiving: an org theme can be empty, partial, or
 * authored in a color space the parser does not know. Missing tokens fall back
 * to the neutral shadcn palette so a site always renders with sane branding.
 */
data class SiteThemeTokens(
	val light: Map<String, RgbaColor> = emptyMap(),
	val dark: Map<String, RgbaColor> = emptyMap(),
	/** `--radius` in rem (converted to pixels by `SiteTheme`). */
	val radiusRem: Double? = null,
) {
	fun rawColor(name: String, scheme: SiteColorScheme): RgbaColor? = when (scheme) {
		SiteColorScheme.LIGHT -> light[name]
		SiteColorScheme.DARK -> dark[name]
	}

	fun color(token: SiteColorToken, scheme: SiteColorScheme): RgbaColor? =
		rawColor(token.tokenName, scheme) ?: SiteThemeDefaults.color(token, scheme)

	companion object {
		val empty = SiteThemeTokens()

		/**
		 * Parses the `html { … } html.dark { … }` stylesheet produced by
		 * `buildSiteThemeCss()` in `packages/common/src/site-theme.ts`.
		 */
		fun parse(css: String): SiteThemeTokens {
			if (css.isEmpty()) return empty
			var radiusRem: Double? = null
			val light = mutableMapOf<String, RgbaColor>()
			val dark = mutableMapOf<String, RgbaColor>()

			for (block in cssRuleBlocks(css)) {
				val selector = block.selector.lowercase()
				if (!selector.contains("html") && !selector.contains(":root")) continue
				val scheme = if (selector.contains(".dark") || selector.contains("[data-theme='dark']")) {
					SiteColorScheme.DARK
				} else {
					SiteColorScheme.LIGHT
				}

				for ((name, rawValue) in declarations(block.body)) {
					if (name == "radius") {
						if (radiusRem == null || scheme == SiteColorScheme.LIGHT) {
							radiusRem = remValue(rawValue) ?: radiusRem
						}
						continue
					}
					val color = RgbaColor.from(rawValue) ?: continue
					if (scheme == SiteColorScheme.LIGHT) light[name] = color else dark[name] = color
				}
			}

			return SiteThemeTokens(light = light, dark = dark, radiusRem = radiusRem)
		}

		// MARK: - Lightweight CSS scanning

		data class RuleBlock(val selector: String, val body: String)

		fun cssRuleBlocks(css: String): List<RuleBlock> {
			val blocks = mutableListOf<RuleBlock>()
			var bodyStart = -1
			var selector = ""
			var depth = 0
			var index = 0

			while (index < css.length) {
				when (css[index]) {
					'{' -> {
						if (depth == 0) {
							selector = previousBoundary(css, index)
							bodyStart = index + 1
						}
						depth += 1
					}
					'}' -> {
						depth -= 1
						if (depth <= 0) {
							if (bodyStart >= 0) {
								blocks += RuleBlock(selector, css.substring(bodyStart, index))
							}
							bodyStart = -1
							depth = 0
						}
					}
				}
				index += 1
			}

			return blocks
		}

		/**
		 * Returns the text between the previous top-level `}` (or start of file)
		 * and the given index — i.e. the selector that precedes a `{`.
		 */
		private fun previousBoundary(css: String, before: Int): String {
			var cursor = before
			while (cursor > 0) {
				val previous = css[cursor - 1]
				if (previous == '}' || previous == ';') break
				cursor -= 1
			}
			return css.substring(cursor, before).trim()
		}

		fun declarations(body: String): List<Pair<String, String>> =
			body.split(';').mapNotNull { statement ->
				val separator = statement.indexOf(':')
				if (separator < 0) return@mapNotNull null
				val name = statement.substring(0, separator).trim().replace("--", "")
				val value = statement.substring(separator + 1).trim()
				if (name.isEmpty() || value.isEmpty()) null else name to value
			}

		fun remValue(raw: String): Double? {
			val value = raw.trim().lowercase()
			val rem = when {
				value.endsWith("rem") -> value.dropLast(3).toDoubleOrNull()
				value.endsWith("px") -> value.dropLast(2).toDoubleOrNull()?.div(16)
				else -> value.toDoubleOrNull()
			}
			// A negative or non-finite radius is not a valid theme value.
			if (rem == null || !rem.isFinite() || rem < 0) return null
			return rem
		}
	}
}

/** Neutral shadcn defaults, used when an org has no theme or a token is missing. */
object SiteThemeDefaults {
	fun color(token: SiteColorToken, scheme: SiteColorScheme): RgbaColor {
		val hex = when (scheme) {
			SiteColorScheme.LIGHT -> when (token) {
				SiteColorToken.BACKGROUND -> "#ffffff"
				SiteColorToken.FOREGROUND -> "#0a0a0a"
				SiteColorToken.CARD -> "#ffffff"
				SiteColorToken.CARD_FOREGROUND -> "#0a0a0a"
				SiteColorToken.POPOVER -> "#ffffff"
				SiteColorToken.POPOVER_FOREGROUND -> "#0a0a0a"
				SiteColorToken.PRIMARY -> "#171717"
				SiteColorToken.PRIMARY_FOREGROUND -> "#fafafa"
				SiteColorToken.SECONDARY -> "#f5f5f5"
				SiteColorToken.SECONDARY_FOREGROUND -> "#171717"
				SiteColorToken.MUTED -> "#f5f5f5"
				SiteColorToken.MUTED_FOREGROUND -> "#737373"
				SiteColorToken.ACCENT -> "#f5f5f5"
				SiteColorToken.ACCENT_FOREGROUND -> "#171717"
				SiteColorToken.DESTRUCTIVE -> "#e7000b"
				SiteColorToken.DESTRUCTIVE_FOREGROUND -> "#ffffff"
				SiteColorToken.BORDER -> "#e5e5e5"
				SiteColorToken.INPUT -> "#e5e5e5"
				SiteColorToken.RING -> "#a1a1a1"
			}
			SiteColorScheme.DARK -> when (token) {
				SiteColorToken.BACKGROUND -> "#0a0a0a"
				SiteColorToken.FOREGROUND -> "#fafafa"
				SiteColorToken.CARD -> "#171717"
				SiteColorToken.CARD_FOREGROUND -> "#fafafa"
				SiteColorToken.POPOVER -> "#171717"
				SiteColorToken.POPOVER_FOREGROUND -> "#fafafa"
				SiteColorToken.PRIMARY -> "#e5e5e5"
				SiteColorToken.PRIMARY_FOREGROUND -> "#171717"
				SiteColorToken.SECONDARY -> "#262626"
				SiteColorToken.SECONDARY_FOREGROUND -> "#fafafa"
				SiteColorToken.MUTED -> "#262626"
				SiteColorToken.MUTED_FOREGROUND -> "#a1a1a1"
				SiteColorToken.ACCENT -> "#404040"
				SiteColorToken.ACCENT_FOREGROUND -> "#fafafa"
				SiteColorToken.DESTRUCTIVE -> "#ff6467"
				SiteColorToken.DESTRUCTIVE_FOREGROUND -> "#ffffff"
				SiteColorToken.BORDER -> "#ffffff1a"
				SiteColorToken.INPUT -> "#ffffff26"
				SiteColorToken.RING -> "#737373"
			}
		}
		return RgbaColor.from(hex) ?: RgbaColor.black
	}
}
