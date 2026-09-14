import SwiftUI
import TenantKit

#if canImport(UIKit)
import UIKit
#endif

/// SwiftUI palette resolved from the org's Sites theme (`--token` values).
struct ThemePalette: Equatable {
	var background: Color
	var foreground: Color
	var card: Color
	var cardForeground: Color
	var muted: Color
	var mutedForeground: Color
	var primary: Color
	var primaryForeground: Color
	var accent: Color
	var accentForeground: Color
	var destructive: Color
	var destructiveForeground: Color
	var border: Color
	var radius: CGFloat
	var headingFont: Font?
	var bodyFont: Font?

	func color(_ token: SiteColorToken, _ scheme: SiteColorScheme, _ theme: SiteTheme) -> Color {
		Color(theme.color(token, scheme: scheme))
	}

	init(theme: SiteTheme, scheme: SiteColorScheme) {
		func color(_ token: SiteColorToken) -> Color {
			Color(theme.color(token, scheme: scheme))
		}

		background = color(.background)
		foreground = color(.foreground)
		card = color(.card)
		cardForeground = color(.cardForeground)
		muted = color(.muted)
		mutedForeground = color(.mutedForeground)
		primary = color(.primary)
		primaryForeground = color(.primaryForeground)
		accent = color(.accent)
		accentForeground = color(.accentForeground)
		destructive = color(.destructive)
		destructiveForeground = color(.destructiveForeground)
		border = color(.border)
		radius = CGFloat(theme.radius())

		if let family = theme.fontFamily(for: .heading), UIFont(name: family, size: 17) != nil {
			headingFont = .custom(family, size: 17)
		}
		if let family = theme.fontFamily(for: .body), UIFont(name: family, size: 17) != nil {
			bodyFont = .custom(family, size: 17)
		}
	}
}

extension Color {
	init(_ rgba: RGBAColor) {
		self.init(
			red: rgba.red,
			green: rgba.green,
			blue: rgba.blue,
			opacity: rgba.alpha
		)
	}
}

extension SiteTheme {
	/// Resolves the org theme against the device's current appearance.
	func palette(systemIsDark: Bool) -> ThemePalette {
		ThemePalette(theme: self, scheme: resolvedScheme(systemIsDark: systemIsDark))
	}

	/// `light` / `dark` / `nil` (follow the system) for `.preferredColorScheme`.
	var preferredColorScheme: ColorScheme? {
		switch mode.lowercased() {
		case "dark": return .dark
		case "light": return .light
		default: return nil
		}
	}
}

private struct ThemePaletteKey: EnvironmentKey {
	static let defaultValue = ThemePalette(theme: .fallback, scheme: .light)
}

extension EnvironmentValues {
	var themePalette: ThemePalette {
		get { self[ThemePaletteKey.self] }
		set { self[ThemePaletteKey.self] = newValue }
	}
}
