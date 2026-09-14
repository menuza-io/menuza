import XCTest

@testable import TenantKit

final class SiteThemeTokensTests: XCTestCase {
	/// Shape produced by `buildSiteThemeCss()` for an org using the blue theme.
	private let css = """
	html {
	\t--background: oklch(1 0 0);
	\t--foreground: oklch(0.145 0 0);
	\t--primary: oklch(0.205 0 0);
	\t--primary-foreground: oklch(0.985 0 0);
	\t--border: oklch(0.922 0 0);
	\t--radius: 0.625rem;
	}

	html.dark {
	\t--background: oklch(0.145 0 0);
	\t--foreground: oklch(0.985 0 0);
	\t--primary: oklch(0.488 0.243 264.376);
	\t--primary-foreground: oklch(0.97 0.014 254.604);
	\t--radius: 0.625rem;
	}
	"""

	func testParsesLightAndDarkTokens() {
		let tokens = SiteThemeTokens.parse(css: css)

		XCTAssertEqual(tokens.light["background"]?.red ?? 0, 1, accuracy: 0.002)
		XCTAssertEqual(tokens.light["foreground"]?.red ?? 0, 0.039388, accuracy: 0.002)
		XCTAssertNotNil(tokens.dark["primary"])
		XCTAssertEqual(tokens.dark["foreground"]?.red ?? 0, 0.980256, accuracy: 0.002)
		XCTAssertEqual(tokens.radiusRem ?? 0, 0.625, accuracy: 0.0001)
	}

	func testParsesRadiusInPixels() {
		let tokens = SiteThemeTokens.parse(css: "html { --radius: 12px; }")
		XCTAssertEqual(tokens.radiusRem ?? 0, 0.75, accuracy: 0.0001)
	}

	func testIgnoresUnknownColorSpaces() {
		let tokens = SiteThemeTokens.parse(css: "html { --primary: color(display-p3 1 0 0); --ring: #ff0000; }")
		XCTAssertNil(tokens.light["primary"])
		XCTAssertNotNil(tokens.light["ring"])
	}

	func testFallsBackToNeutralDefaults() {
		let theme = SiteTheme(theme: nil)
		let background = theme.color(.background, scheme: .light)
		XCTAssertEqual(background, RGBAColor.white)

		let darkBackground = theme.color(.background, scheme: .dark)
		XCTAssertLessThan(darkBackground.relativeLuminance, 0.2)
	}

	func testResolvesThemeMode() {
		let darkTheme = SiteTheme(theme: PublicSiteTheme(
			baseColor: "neutral",
			theme: "blue",
			radius: "default",
			mode: "dark",
			headingFont: "inter",
			bodyFont: "inter",
			headingCustomFont: nil,
			bodyCustomFont: nil,
			css: css
		))
		XCTAssertEqual(darkTheme.resolvedScheme(systemIsDark: false), .dark)

		let systemTheme = SiteTheme(theme: PublicSiteTheme(
			baseColor: "neutral",
			theme: "blue",
			radius: "default",
			mode: "system",
			headingFont: "inter",
			bodyFont: "inter",
			headingCustomFont: nil,
			bodyCustomFont: nil,
			css: css
		))
		XCTAssertEqual(systemTheme.resolvedScheme(systemIsDark: false), .light)
		XCTAssertEqual(systemTheme.resolvedScheme(systemIsDark: true), .dark)
	}

	func testRadiusScalesLikeTheTailwindTokens() {
		let theme = SiteTheme(theme: PublicSiteTheme(
			baseColor: "neutral",
			theme: "neutral",
			radius: "default",
			mode: "light",
			headingFont: "inter",
			bodyFont: "inter",
			headingCustomFont: nil,
			bodyCustomFont: nil,
			css: css
		))
		XCTAssertEqual(theme.radius(), 10, accuracy: 0.01)
		XCTAssertEqual(theme.radius(scale: 0.7), 7, accuracy: 0.01)
	}

	func testMapsSiteFontIdsToIOSFamilies() {
		let theme = SiteTheme(theme: PublicSiteTheme(
			baseColor: "neutral",
			theme: "neutral",
			radius: "default",
			mode: "light",
			headingFont: "space-grotesk",
			bodyFont: "ibm-plex-sans",
			headingCustomFont: nil,
			bodyCustomFont: nil,
			css: css
		))
		XCTAssertEqual(theme.fontFamily(for: .heading), "Space Grotesk")
		XCTAssertEqual(theme.fontFamily(for: .body), "IBM Plex Sans")
	}
}
