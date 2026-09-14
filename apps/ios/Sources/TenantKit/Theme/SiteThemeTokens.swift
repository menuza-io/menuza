import Foundation

public enum SiteColorScheme: String, Equatable, Sendable, CaseIterable {
	case light
	case dark
}

/// Semantic color tokens used by the Sites design system
/// (`packages/common/src/site-theme.ts` → shadcn `--token` names).
public enum SiteColorToken: String, Equatable, Sendable, CaseIterable {
	case background
	case foreground
	case card
	case cardForeground = "card-foreground"
	case popover
	case popoverForeground = "popover-foreground"
	case primary
	case primaryForeground = "primary-foreground"
	case secondary
	case secondaryForeground = "secondary-foreground"
	case muted
	case mutedForeground = "muted-foreground"
	case accent
	case accentForeground = "accent-foreground"
	case destructive
	case destructiveForeground = "destructive-foreground"
	case border
	case input
	case ring
}

/// The `--token: oklch(…)` map compiled by the App (`buildSiteThemeCss`).
///
/// Parsing is intentionally forgiving: an org theme can be empty, partial, or
/// authored in a color space the parser does not know. Missing tokens fall back
/// to the neutral shadcn palette so a site always renders with sane branding.
public struct SiteThemeTokens: Equatable, Sendable {
	public var light: [String: RGBAColor]
	public var dark: [String: RGBAColor]
	/// `--radius` in rem (converted to points by `SiteTheme`).
	public var radiusRem: Double?

	public init(
		light: [String: RGBAColor] = [:],
		dark: [String: RGBAColor] = [:],
		radiusRem: Double? = nil
	) {
		self.light = light
		self.dark = dark
		self.radiusRem = radiusRem
	}

	public static let empty = SiteThemeTokens()

	public func rawColor(_ name: String, scheme: SiteColorScheme) -> RGBAColor? {
		switch scheme {
		case .light: return light[name]
		case .dark: return dark[name]
		}
	}

	public func color(_ token: SiteColorToken, scheme: SiteColorScheme) -> RGBAColor? {
		rawColor(token.rawValue, scheme: scheme) ?? SiteThemeDefaults.color(token, scheme: scheme)
	}

	/// Parses the `html { … } html.dark { … }` stylesheet produced by
	/// `buildSiteThemeCss()` in `packages/common/src/site-theme.ts`.
	public static func parse(css: String) -> SiteThemeTokens {
		var tokens = SiteThemeTokens()
		guard !css.isEmpty else { return tokens }

		for block in cssRuleBlocks(css) {
			let selector = block.selector.lowercased()
			guard selector.contains("html") || selector.contains(":root") else { continue }
			let scheme: SiteColorScheme = selector.contains(".dark") || selector.contains("[data-theme='dark']") ? .dark : .light

			for (name, rawValue) in declarations(block.body) {
				if name == "radius" {
					if tokens.radiusRem == nil || scheme == .light {
						tokens.radiusRem = remValue(rawValue) ?? tokens.radiusRem
					}
					continue
				}
				guard let color = RGBAColor.from(cssValue: rawValue) else { continue }
				switch scheme {
				case .light: tokens.light[name] = color
				case .dark: tokens.dark[name] = color
				}
			}
		}

		return tokens
	}

	// MARK: - Lightweight CSS scanning

	struct RuleBlock {
		let selector: String
		let body: String
	}

	static func cssRuleBlocks(_ css: String) -> [RuleBlock] {
		var blocks: [RuleBlock] = []
		var bodyStart: String.Index?
		var selector: String = ""
		var depth = 0
		var current = css.startIndex

		while current < css.endIndex {
			let character = css[current]
			if character == "{" {
				if depth == 0 {
					selector = previousBoundary(in: css, before: current)
					bodyStart = css.index(after: current)
				}
				depth += 1
			} else if character == "}" {
				depth -= 1
				if depth <= 0 {
					if let start = bodyStart {
						blocks.append(RuleBlock(selector: selector, body: String(css[start..<current])))
					}
					bodyStart = nil
					depth = 0
				}
			}
			current = css.index(after: current)
		}

		return blocks
	}

	/// Returns the text between the previous top-level `}` (or start of file) and
	/// the given index — i.e. the selector that precedes a `{`.
	private static func previousBoundary(in css: String, before index: String.Index) -> String {
		var cursor = index
		while cursor > css.startIndex {
			let previous = css[css.index(before: cursor)]
			if previous == "}" || previous == ";" {
				break
			}
			cursor = css.index(before: cursor)
		}
		return String(css[cursor..<index]).trimmingCharacters(in: .whitespacesAndNewlines)
	}

	static func declarations(_ body: String) -> [(String, String)] {
		var result: [(String, String)] = []
		for statement in body.split(separator: ";") {
			let parts = statement.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
			guard parts.count == 2 else { continue }
			let name = parts[0]
				.trimmingCharacters(in: .whitespacesAndNewlines)
				.replacingOccurrences(of: "--", with: "")
			let value = parts[1].trimmingCharacters(in: .whitespacesAndNewlines)
			guard !name.isEmpty, !value.isEmpty else { continue }
			result.append((name, value))
		}
		return result
	}

	static func remValue(_ raw: String) -> Double? {
		let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		let rem: Double?
		if value.hasSuffix("rem") {
			rem = Double(value.dropLast(3))
		} else if value.hasSuffix("px") {
			rem = Double(value.dropLast(2)).map { $0 / 16 }
		} else {
			rem = Double(value)
		}
		// A negative or non-finite radius is not a valid theme value.
		guard let rem, rem.isFinite, rem >= 0 else { return nil }
		return rem
	}
}

/// Neutral shadcn defaults, used when an org has no theme or a token is missing.
public enum SiteThemeDefaults {
	public static func color(_ token: SiteColorToken, scheme: SiteColorScheme) -> RGBAColor {
		let hex: String
		switch (scheme, token) {
		case (.light, .background): hex = "#ffffff"
		case (.light, .foreground): hex = "#0a0a0a"
		case (.light, .card): hex = "#ffffff"
		case (.light, .cardForeground): hex = "#0a0a0a"
		case (.light, .popover): hex = "#ffffff"
		case (.light, .popoverForeground): hex = "#0a0a0a"
		case (.light, .primary): hex = "#171717"
		case (.light, .primaryForeground): hex = "#fafafa"
		case (.light, .secondary): hex = "#f5f5f5"
		case (.light, .secondaryForeground): hex = "#171717"
		case (.light, .muted): hex = "#f5f5f5"
		case (.light, .mutedForeground): hex = "#737373"
		case (.light, .accent): hex = "#f5f5f5"
		case (.light, .accentForeground): hex = "#171717"
		case (.light, .destructive): hex = "#e7000b"
		case (.light, .destructiveForeground): hex = "#ffffff"
		case (.light, .border): hex = "#e5e5e5"
		case (.light, .input): hex = "#e5e5e5"
		case (.light, .ring): hex = "#a1a1a1"

		case (.dark, .background): hex = "#0a0a0a"
		case (.dark, .foreground): hex = "#fafafa"
		case (.dark, .card): hex = "#171717"
		case (.dark, .cardForeground): hex = "#fafafa"
		case (.dark, .popover): hex = "#171717"
		case (.dark, .popoverForeground): hex = "#fafafa"
		case (.dark, .primary): hex = "#e5e5e5"
		case (.dark, .primaryForeground): hex = "#171717"
		case (.dark, .secondary): hex = "#262626"
		case (.dark, .secondaryForeground): hex = "#fafafa"
		case (.dark, .muted): hex = "#262626"
		case (.dark, .mutedForeground): hex = "#a1a1a1"
		case (.dark, .accent): hex = "#404040"
		case (.dark, .accentForeground): hex = "#fafafa"
		case (.dark, .destructive): hex = "#ff6467"
		case (.dark, .destructiveForeground): hex = "#ffffff"
		case (.dark, .border): hex = "#ffffff1a"
		case (.dark, .input): hex = "#ffffff26"
		case (.dark, .ring): hex = "#737373"
		}
		return RGBAColor.from(cssValue: hex) ?? .black
	}
}
