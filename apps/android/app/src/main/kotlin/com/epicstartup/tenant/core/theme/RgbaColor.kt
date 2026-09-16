package com.epicstartup.tenant.core.theme

/**
 * A plain sRGB color with alpha in `0...1`.
 *
 * The core deliberately does not import `android.graphics`: the same theme math
 * is used by the app and by the JVM unit tests. [toArgb] is the only bridge.
 */
class RgbaColor private constructor(
	val red: Double,
	val green: Double,
	val blue: Double,
	val alpha: Double,
) {
	fun withAlpha(alpha: Double): RgbaColor = of(red, green, blue, alpha)

	fun mixedWith(other: RgbaColor, amount: Double): RgbaColor {
		val ratio = amount.coerceIn(0.0, 1.0)
		return of(
			red + (other.red - red) * ratio,
			green + (other.green - green) * ratio,
			blue + (other.blue - blue) * ratio,
			alpha + (other.alpha - alpha) * ratio,
		)
	}

	/** WCAG relative luminance — used to pick readable foreground text. */
	val relativeLuminance: Double
		get() {
			fun channel(value: Double): Double =
				if (value <= 0.03928) value / 12.92 else Math.pow((value + 0.055) / 1.055, 2.4)
			return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
		}

	val isLight: Boolean
		get() = relativeLuminance > 0.5

	fun contrastRatio(against: RgbaColor): Double {
		val first = maxOf(relativeLuminance, against.relativeLuminance)
		val second = minOf(relativeLuminance, against.relativeLuminance)
		return (first + 0.05) / (second + 0.05)
	}

	val hexString: String
		get() {
			fun hex(value: Double): String {
				val scaled = Math.round(value * 255).toInt().coerceIn(0, 255)
				return scaled.toString(16).padStart(2, '0')
			}
			return "#${hex(red)}${hex(green)}${hex(blue)}"
		}

	/** `0xAARRGGBB`, ready for `android.graphics.Color` consumers. */
	fun toArgb(): Int {
		val a = Math.round(alpha * 255).toInt().coerceIn(0, 255)
		val r = Math.round(red * 255).toInt().coerceIn(0, 255)
		val g = Math.round(green * 255).toInt().coerceIn(0, 255)
		val b = Math.round(blue * 255).toInt().coerceIn(0, 255)
		return (a shl 24) or (r shl 16) or (g shl 8) or b
	}

	override fun equals(other: Any?): Boolean =
		other is RgbaColor &&
			other.red == red &&
			other.green == green &&
			other.blue == blue &&
			other.alpha == alpha

	override fun hashCode(): Int {
		var result = red.hashCode()
		result = 31 * result + green.hashCode()
		result = 31 * result + blue.hashCode()
		result = 31 * result + alpha.hashCode()
		return result
	}

	override fun toString(): String = "RgbaColor($hexString, alpha=$alpha)"

	companion object {
		val black = of(0.0, 0.0, 0.0)
		val white = of(1.0, 1.0, 1.0)

		fun of(red: Double, green: Double, blue: Double, alpha: Double = 1.0): RgbaColor =
			RgbaColor(component(red), component(green), component(blue), component(alpha))

		/** `coerceIn` lets NaN through, so sanitise before clamping. */
		private fun component(value: Double): Double =
			if (!value.isFinite()) 0.0 else value.coerceIn(0.0, 1.0)

		val named: Map<String, RgbaColor> = mapOf(
			"transparent" to of(0.0, 0.0, 0.0, 0.0),
			"white" to white,
			"black" to black,
			"red" to of(1.0, 0.0, 0.0),
			"green" to of(0.0, 0.5019607843, 0.0),
			"blue" to of(0.0, 0.0, 1.0),
			"gray" to of(0.5019607843, 0.5019607843, 0.5019607843),
			"grey" to of(0.5019607843, 0.5019607843, 0.5019607843),
			"silver" to of(0.7529411765, 0.7529411765, 0.7529411765),
			"orange" to of(1.0, 0.6470588235, 0.0),
			"purple" to of(0.5019607843, 0.0, 0.5019607843),
			"yellow" to of(1.0, 1.0, 0.0),
		)

		// MARK: CSS parsing

		/**
		 * Parses the color formats the org theme compiler emits.
		 *
		 * shadcn themes are authored in `oklch()`, but orgs can override
		 * individual tokens with hex/rgb/hsl values, so all four are supported.
		 * Anything the parser cannot understand (for example CSS relative color
		 * syntax such as `oklch(from var(--destructive) min(l, 0.42) c h)`)
		 * returns `null` and the caller keeps its fallback token.
		 */
		fun from(cssValue: String): RgbaColor? {
			val value = cssValue.trim().lowercase()
			if (value.isEmpty()) return null
			return when {
				value.startsWith("#") -> fromHex(value)
				value.startsWith("rgb") -> fromFunctional(value, "rgb")
				value.startsWith("hsl") -> fromHsl(value)
				value.startsWith("oklch(") -> fromOklch(value)
				value.startsWith("oklab(") -> fromOklab(value)
				else -> named[value]
			}
		}

		private fun fromHex(value: String): RgbaColor? {
			val digits = value.drop(1)
			if (digits.isEmpty()) return null
			if (!digits.all { it.isDigit() || it in 'a'..'f' }) return null

			fun component(text: String): Double {
				val parsed = text.toIntOrNull(16) ?: return 0.0
				return parsed / 255.0
			}

			return when (digits.length) {
				3, 4 -> {
					val characters = digits.map { it.toString() }
					of(
						component(characters[0] + characters[0]),
						component(characters[1] + characters[1]),
						component(characters[2] + characters[2]),
						if (digits.length == 4) component(characters[3] + characters[3]) else 1.0,
					)
				}
				6, 8 -> {
					val characters = digits.map { it.toString() }
					of(
						component(characters[0] + characters[1]),
						component(characters[2] + characters[3]),
						component(characters[4] + characters[5]),
						if (digits.length == 8) component(characters[6] + characters[7]) else 1.0,
					)
				}
				else -> null
			}
		}

		/** Splits `rgb(1 2 3 / 40%)` or `rgb(1, 2, 3, 0.4)` into components. */
		private fun splitFunction(value: String, prefix: String): Pair<List<String>, String?>? {
			if (!value.startsWith(prefix)) return null
			val open = value.indexOf('(')
			if (open < 0 || !value.endsWith(")")) return null
			val inner = value.substring(open + 1, value.length - 1)
			val parts = inner.replace(',', ' ').split('/')
			if (parts.isEmpty()) return null
			val alpha = if (parts.size > 1) parts[1].trim() else null
			val components = parts[0].split(' ', '\t').filter { it.isNotEmpty() }
			return components to alpha
		}

		private fun componentValue(text: String, scale: Double): Double? {
			val value = if (text.endsWith("%")) {
				text.dropLast(1).toDoubleOrNull()?.div(100)
			} else {
				text.toDoubleOrNull()?.div(scale)
			}
			return value?.takeIf { it.isFinite() }
		}

		/**
		 * `null` when an explicit alpha is present but unparsable, so the caller
		 * can keep its fallback token instead of rendering an opaque color.
		 */
		private fun alphaValue(text: String?): Double? {
			if (text.isNullOrEmpty()) return 1.0
			val value = if (text.endsWith("%")) {
				text.dropLast(1).toDoubleOrNull()?.div(100)
			} else {
				text.toDoubleOrNull()
			}
			return value?.takeIf { it.isFinite() }
		}

		private fun fromFunctional(value: String, prefix: String): RgbaColor? {
			val (components, alpha) = splitFunction(value, prefix) ?: return null
			if (components.size < 3) return null
			val red = componentValue(components[0], 255.0) ?: return null
			val green = componentValue(components[1], 255.0) ?: return null
			val blue = componentValue(components[2], 255.0) ?: return null
			val resolvedAlpha = alpha ?: components.getOrNull(3)
			val alphaValue = alphaValue(resolvedAlpha) ?: return null
			return of(red, green, blue, alphaValue)
		}

		private fun fromHsl(value: String): RgbaColor? {
			val (components, alpha) = splitFunction(value, "hsl") ?: return null
			if (components.size < 3) return null
			val hue = components[0].replace("deg", "").toDoubleOrNull() ?: return null
			val saturation = componentValue(components[1], 100.0) ?: return null
			val lightness = componentValue(components[2], 100.0) ?: return null
			val alphaValue = alphaValue(alpha ?: components.getOrNull(3)) ?: return null
			return fromHslComponents(hue, saturation, lightness, alphaValue)
		}

		fun fromHslComponents(
			hue: Double,
			saturation: Double,
			lightness: Double,
			alpha: Double = 1.0,
		): RgbaColor {
			val hueDegrees = hue % 360
			val normalizedHue = if (hueDegrees < 0) hueDegrees + 360 else hueDegrees
			val chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
			val secondary = chroma * (1 - Math.abs((normalizedHue / 60) % 2 - 1))
			val match = lightness - chroma / 2

			val rgb = when {
				normalizedHue < 60 -> Triple(chroma, secondary, 0.0)
				normalizedHue < 120 -> Triple(secondary, chroma, 0.0)
				normalizedHue < 180 -> Triple(0.0, chroma, secondary)
				normalizedHue < 240 -> Triple(0.0, secondary, chroma)
				normalizedHue < 300 -> Triple(secondary, 0.0, chroma)
				else -> Triple(chroma, 0.0, secondary)
			}

			return of(rgb.first + match, rgb.second + match, rgb.third + match, alpha)
		}

		/** `oklch(0.205 0 0)` / `oklch(62.3% 0.214 259.815)` / `oklch(1 0 0 / 50%)`. */
		private fun fromOklch(value: String): RgbaColor? {
			if (value.contains("from ")) return null
			val (components, alpha) = splitFunction(value, "oklch") ?: return null
			if (components.size < 3) return null
			val lightness = componentValue(components[0], 1.0) ?: return null
			val chroma = components[1].toDoubleOrNull()?.takeIf { it.isFinite() } ?: return null
			val alphaValue = alphaValue(alpha) ?: return null
			val hueText = components[2].replace("deg", "")
			val hue = when {
				hueText == "none" -> 0.0
				// An unparsable hue would silently become red; let the caller fall back.
				else -> hueText.toDoubleOrNull()?.takeIf { it.isFinite() } ?: return null
			}
			return fromOklchComponents(lightness, chroma, hue, alphaValue)
		}

		private fun fromOklab(value: String): RgbaColor? {
			val (components, alpha) = splitFunction(value, "oklab") ?: return null
			if (components.size < 3) return null
			val lightness = componentValue(components[0], 1.0) ?: return null
			val a = components[1].toDoubleOrNull()?.takeIf { it.isFinite() } ?: return null
			val b = components[2].toDoubleOrNull()?.takeIf { it.isFinite() } ?: return null
			val alphaValue = alphaValue(alpha) ?: return null
			return fromOklabComponents(lightness, a, b, alphaValue)
		}

		/** OKLCH → OKLab → linear sRGB → sRGB (Björn Ottosson's matrices). */
		fun fromOklchComponents(
			lightness: Double,
			chroma: Double,
			hue: Double,
			alpha: Double = 1.0,
		): RgbaColor {
			val hueRadians = hue * Math.PI / 180
			return fromOklabComponents(
				lightness = lightness,
				a = chroma * Math.cos(hueRadians),
				b = chroma * Math.sin(hueRadians),
				alpha = alpha,
			)
		}

		fun fromOklabComponents(
			lightness: Double,
			a: Double,
			b: Double,
			alpha: Double = 1.0,
		): RgbaColor {
			val long = Math.pow(lightness + 0.3963377774 * a + 0.2158037573 * b, 3.0)
			val medium = Math.pow(lightness - 0.1055613458 * a - 0.0638541728 * b, 3.0)
			val short = Math.pow(lightness - 0.0894841775 * a - 1.2914855480 * b, 3.0)

			val linearRed = 4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short
			val linearGreen = -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short
			val linearBlue = -0.0041960863 * long - 0.7034186147 * medium + 1.7076147010 * short

			fun gamma(value: Double): Double =
				if (value <= 0.0031308) 12.92 * value else 1.055 * Math.pow(maxOf(value, 0.0), 1 / 2.4) - 0.055

			return of(
				gamma(linearRed),
				gamma(linearGreen),
				gamma(linearBlue),
				alpha,
			)
		}
	}
}
