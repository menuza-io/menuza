import Foundation

/// A plain sRGB color with alpha in `0...1`.
///
/// TenantKit deliberately does not import SwiftUI: the same theme math is used
/// by the iOS app and by the Linux test suite.
public struct RGBAColor: Equatable, Sendable, Hashable {
	public let red: Double
	public let green: Double
	public let blue: Double
	public let alpha: Double

	public init(red: Double, green: Double, blue: Double, alpha: Double = 1) {
		self.red = min(max(red, 0), 1)
		self.green = min(max(green, 0), 1)
		self.blue = min(max(blue, 0), 1)
		self.alpha = min(max(alpha, 0), 1)
	}

	public static let black = RGBAColor(red: 0, green: 0, blue: 0)
	public static let white = RGBAColor(red: 1, green: 1, blue: 1)

	public static let named: [String: RGBAColor] = [
		"transparent": RGBAColor(red: 0, green: 0, blue: 0, alpha: 0),
		"white": .white,
		"black": .black,
		"red": RGBAColor(red: 1, green: 0, blue: 0),
		"green": RGBAColor(red: 0, green: 0.5019607843, blue: 0),
		"blue": RGBAColor(red: 0, green: 0, blue: 1),
		"gray": RGBAColor(red: 0.5019607843, green: 0.5019607843, blue: 0.5019607843),
		"grey": RGBAColor(red: 0.5019607843, green: 0.5019607843, blue: 0.5019607843),
		"silver": RGBAColor(red: 0.7529411765, green: 0.7529411765, blue: 0.7529411765),
		"orange": RGBAColor(red: 1, green: 0.6470588235, blue: 0),
		"purple": RGBAColor(red: 0.5019607843, green: 0, blue: 0.5019607843),
		"yellow": RGBAColor(red: 1, green: 1, blue: 0),
	]

	public func withAlpha(_ alpha: Double) -> RGBAColor {
		RGBAColor(red: red, green: green, blue: blue, alpha: alpha)
	}

	public func mixed(with other: RGBAColor, amount: Double) -> RGBAColor {
		let ratio = min(max(amount, 0), 1)
		return RGBAColor(
			red: red + (other.red - red) * ratio,
			green: green + (other.green - green) * ratio,
			blue: blue + (other.blue - blue) * ratio,
			alpha: alpha + (other.alpha - alpha) * ratio
		)
	}

	/// WCAG relative luminance — used to pick readable foreground text when an
	/// org theme leaves a token missing.
	public var relativeLuminance: Double {
		func channel(_ value: Double) -> Double {
			value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
		}
		return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
	}

	public var isLight: Bool {
		relativeLuminance > 0.5
	}

	public func contrastRatio(against other: RGBAColor) -> Double {
		let first = max(relativeLuminance, other.relativeLuminance)
		let second = min(relativeLuminance, other.relativeLuminance)
		return (first + 0.05) / (second + 0.05)
	}

	public var hexString: String {
		func hex(_ value: Double) -> String {
			let scaled = Int((value * 255).rounded())
			return String(format: "%02x", min(max(scaled, 0), 255))
		}
		return "#\(hex(red))\(hex(green))\(hex(blue))"
	}

	// MARK: - CSS parsing

	/// Parses the color formats the org theme compiler emits.
	///
	/// shadcn themes are authored in `oklch()`, but orgs can override individual
	/// tokens with hex/rgb/hsl values, so all four are supported. Anything the
	/// parser cannot understand (for example CSS relative color syntax such as
	/// `oklch(from var(--destructive) min(l, 0.42) c h)`) returns `nil` and the
	/// caller keeps its fallback token.
	public static func from(cssValue: String) -> RGBAColor? {
		let value = cssValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		guard !value.isEmpty else { return nil }

		if value.hasPrefix("#") {
			return fromHex(value)
		}
		if value.hasPrefix("rgb") {
			return fromFunctional(value, prefix: "rgb")
		}
		if value.hasPrefix("hsl") {
			return fromHSL(value)
		}
		if value.hasPrefix("oklch(") {
			return fromOKLCH(value)
		}
		if value.hasPrefix("oklab(") {
			return fromOKLab(value)
		}
		return named[value]
	}

	private static func fromHex(_ value: String) -> RGBAColor? {
		let digits = String(value.dropFirst())
		guard digits.allSatisfy({ $0.isHexDigit }) else { return nil }

		func component(_ text: String) -> Double {
			guard let intValue = Int(text, radix: 16) else { return 0 }
			return Double(intValue) / 255
		}

		switch digits.count {
		case 3, 4:
			let characters = Array(digits).map(String.init)
			return RGBAColor(
				red: component(characters[0] + characters[0]),
				green: component(characters[1] + characters[1]),
				blue: component(characters[2] + characters[2]),
				alpha: digits.count == 4 ? component(characters[3] + characters[3]) : 1
			)
		case 6, 8:
			let characters = Array(digits).map(String.init)
			return RGBAColor(
				red: component(characters[0] + characters[1]),
				green: component(characters[2] + characters[3]),
				blue: component(characters[4] + characters[5]),
				alpha: digits.count == 8 ? component(characters[6] + characters[7]) : 1
			)
		default:
			return nil
		}
	}

	/// Splits `rgb(1 2 3 / 40%)` or `rgb(1, 2, 3, 0.4)` into components.
	private static func splitFunction(_ value: String, prefix: String) -> (components: [String], alpha: String?)? {
		guard let open = value.firstIndex(of: "("), value.hasSuffix(")") else { return nil }
		guard value.hasPrefix(prefix) else { return nil }
		let inner = String(value[value.index(after: open)..<value.index(before: value.endIndex)])
		let body = inner.replacingOccurrences(of: ",", with: " ")
		var parts = body.split(separator: "/").map { String($0) }
		guard !parts.isEmpty else { return nil }
		var alpha: String?
		if parts.count > 1 {
			alpha = parts[1].trimmingCharacters(in: .whitespaces)
			parts = [parts[0]]
		}
		let components = parts[0]
			.split(whereSeparator: { $0 == " " || $0 == "\t" })
			.map(String.init)
		return (components, alpha)
	}

	private static func componentValue(_ text: String, scale: Double) -> Double? {
		if text.hasSuffix("%") {
			guard let number = Double(text.dropLast()) else { return nil }
			return number / 100
		}
		guard let number = Double(text) else { return nil }
		return number / scale
	}

	/// `nil` when an explicit alpha is present but unparsable, so the caller can
	/// keep its fallback token instead of silently rendering an opaque color.
	private static func alphaValue(_ text: String?) -> Double? {
		guard let text, !text.isEmpty else { return 1 }
		if text.hasSuffix("%") {
			guard let percentage = Double(text.dropLast()) else { return nil }
			return percentage / 100
		}
		return Double(text)
	}

	private static func fromFunctional(_ value: String, prefix: String) -> RGBAColor? {
		guard let (components, alpha) = splitFunction(value, prefix: prefix), components.count >= 3 else {
			return nil
		}
		guard
			let red = componentValue(components[0], scale: 255),
			let green = componentValue(components[1], scale: 255),
			let blue = componentValue(components[2], scale: 255)
		else {
			return nil
		}
		let resolvedAlpha = alpha ?? (components.count >= 4 ? components[3] : nil)
		guard let alphaValue = alphaValue(resolvedAlpha) else { return nil }
		return RGBAColor(red: red, green: green, blue: blue, alpha: alphaValue)
	}

	private static func fromHSL(_ value: String) -> RGBAColor? {
		guard let (components, alpha) = splitFunction(value, prefix: "hsl"), components.count >= 3 else {
			return nil
		}
		guard
			let hue = Double(components[0].replacingOccurrences(of: "deg", with: "")),
			let saturation = componentValue(components[1], scale: 100),
			let lightness = componentValue(components[2], scale: 100)
		else {
			return nil
		}
		guard
			let alphaValue = alphaValue(alpha ?? (components.count >= 4 ? components[3] : nil))
		else {
			return nil
		}
		return fromHSLComponents(
			hue: hue,
			saturation: saturation,
			lightness: lightness,
			alpha: alphaValue
		)
	}

	public static func fromHSLComponents(hue: Double, saturation: Double, lightness: Double, alpha: Double = 1) -> RGBAColor {
		let hueDegrees = hue.truncatingRemainder(dividingBy: 360)
		let normalizedHue = hueDegrees < 0 ? hueDegrees + 360 : hueDegrees
		let chroma = (1 - abs(2 * lightness - 1)) * saturation
		let secondary = chroma * (1 - abs((normalizedHue / 60).truncatingRemainder(dividingBy: 2) - 1))
		let match = lightness - chroma / 2

		var rgb: (Double, Double, Double)
		switch normalizedHue {
		case 0..<60: rgb = (chroma, secondary, 0)
		case 60..<120: rgb = (secondary, chroma, 0)
		case 120..<180: rgb = (0, chroma, secondary)
		case 180..<240: rgb = (0, secondary, chroma)
		case 240..<300: rgb = (secondary, 0, chroma)
		default: rgb = (chroma, 0, secondary)
		}

		return RGBAColor(
			red: rgb.0 + match,
			green: rgb.1 + match,
			blue: rgb.2 + match,
			alpha: alpha
		)
	}

	/// `oklch(0.205 0 0)` / `oklch(62.3% 0.214 259.815)` / `oklch(1 0 0 / 50%)`.
	private static func fromOKLCH(_ value: String) -> RGBAColor? {
		guard !value.contains("from ") else { return nil }
		guard let (components, alpha) = splitFunction(value, prefix: "oklch"), components.count >= 3 else {
			return nil
		}
		guard let lightness = componentValue(components[0], scale: 1) else { return nil }
		guard let chroma = Double(components[1]) else { return nil }
		guard let alphaValue = alphaValue(alpha) else { return nil }
		let hueText = components[2].replacingOccurrences(of: "deg", with: "")
		let hue: Double
		if hueText == "none" {
			hue = 0
		} else if let parsedHue = Double(hueText) {
			hue = parsedHue
		} else {
			// An unparsable hue would silently become red; let the caller fall back.
			return nil
		}
		return fromOKLCHComponents(
			lightness: lightness,
			chroma: chroma,
			hue: hue,
			alpha: alphaValue
		)
	}

	private static func fromOKLab(_ value: String) -> RGBAColor? {
		guard let (components, alpha) = splitFunction(value, prefix: "oklab"), components.count >= 3 else {
			return nil
		}
		guard
			let lightness = componentValue(components[0], scale: 1),
			let a = Double(components[1]),
			let b = Double(components[2]),
			let alphaValue = alphaValue(alpha)
		else {
			return nil
		}
		return fromOKLabComponents(lightness: lightness, a: a, b: b, alpha: alphaValue)
	}

	/// OKLCH → OKLab → linear sRGB → sRGB (Björn Ottosson's matrices).
	public static func fromOKLCHComponents(
		lightness: Double,
		chroma: Double,
		hue: Double,
		alpha: Double = 1
	) -> RGBAColor {
		let hueRadians = hue * Double.pi / 180
		return fromOKLabComponents(
			lightness: lightness,
			a: chroma * cos(hueRadians),
			b: chroma * sin(hueRadians),
			alpha: alpha
		)
	}

	public static func fromOKLabComponents(
		lightness: Double,
		a: Double,
		b: Double,
		alpha: Double = 1
	) -> RGBAColor {
		let long = pow(lightness + 0.3963377774 * a + 0.2158037573 * b, 3)
		let medium = pow(lightness - 0.1055613458 * a - 0.0638541728 * b, 3)
		let short = pow(lightness - 0.0894841775 * a - 1.2914855480 * b, 3)

		let linearRed = 4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short
		let linearGreen = -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short
		let linearBlue = -0.0041960863 * long - 0.7034186147 * medium + 1.7076147010 * short

		func gamma(_ value: Double) -> Double {
			value <= 0.0031308 ? 12.92 * value : 1.055 * pow(max(value, 0), 1 / 2.4) - 0.055
		}

		return RGBAColor(
			red: gamma(linearRed),
			green: gamma(linearGreen),
			blue: gamma(linearBlue),
			alpha: alpha
		)
	}
}
