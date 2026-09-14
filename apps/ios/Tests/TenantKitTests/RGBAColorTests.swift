import XCTest

@testable import TenantKit

/// The App compiles org themes to `oklch()` custom properties, so the app has to
/// do the color-space conversion itself (CSS colors are not available on iOS).
/// Reference values were computed with the same Ottosson matrices.
final class RGBAColorTests: XCTestCase {
	private func assertColor(
		_ color: RGBAColor?,
		_ red: Double,
		_ green: Double,
		_ blue: Double,
		alpha: Double = 1,
		tolerance: Double = 0.002,
		file: StaticString = #filePath,
		line: UInt = #line
	) {
		guard let color else {
			return XCTFail("Expected a parsed color", file: file, line: line)
		}
		XCTAssertEqual(color.red, red, accuracy: tolerance, file: file, line: line)
		XCTAssertEqual(color.green, green, accuracy: tolerance, file: file, line: line)
		XCTAssertEqual(color.blue, blue, accuracy: tolerance, file: file, line: line)
		XCTAssertEqual(color.alpha, alpha, accuracy: tolerance, file: file, line: line)
	}

	func testParsesOpaqueWhiteAndBlack() {
		assertColor(RGBAColor.from(cssValue: "oklch(1 0 0)"), 1, 1, 1)
		assertColor(RGBAColor.from(cssValue: "oklch(0 0 0)"), 0, 0, 0)
	}

	func testParsesNeutralGrays() {
		assertColor(RGBAColor.from(cssValue: "oklch(0.145 0 0)"), 0.039388, 0.039388, 0.039388)
		assertColor(RGBAColor.from(cssValue: "oklch(0.985 0 0)"), 0.980256, 0.980256, 0.980256)
		assertColor(RGBAColor.from(cssValue: "oklch(0.205 0 0)"), 0.090527, 0.090527, 0.090527)
	}

	func testParsesChromaticTokens() {
		assertColor(
			RGBAColor.from(cssValue: "oklch(0.577 0.245 27.325)"),
			0.906458,
			0,
			0.042215
		)
		assertColor(
			RGBAColor.from(cssValue: "oklch(0.623 0.214 259.815)"),
			0.169333,
			0.498049,
			1
		)
	}

	func testParsesPercentageLightness() {
		assertColor(
			RGBAColor.from(cssValue: "oklch(62.3% 0.214 259.815)"),
			0.169333,
			0.498049,
			1
		)
	}

	func testParsesAlpha() {
		let color = RGBAColor.from(cssValue: "oklch(0.577 0.245 27.325 / 50%)")
		XCTAssertEqual(color?.alpha ?? 0, 0.5, accuracy: 0.0001)

		let rgb = RGBAColor.from(cssValue: "rgb(255 0 0 / 0.25)")
		XCTAssertEqual(rgb?.alpha ?? 0, 0.25, accuracy: 0.0001)
	}

	func testParsesHexForms() {
		assertColor(RGBAColor.from(cssValue: "#ffffff"), 1, 1, 1)
		assertColor(RGBAColor.from(cssValue: "#000"), 0, 0, 0)
		assertColor(RGBAColor.from(cssValue: "#ffffff1a"), 1, 1, 1, alpha: 0.1019607843)
		assertColor(RGBAColor.from(cssValue: "#0f0f0f"), 0.0588235294, 0.0588235294, 0.0588235294)
	}

	func testParsesLegacyRGBAndHSL() {
		assertColor(RGBAColor.from(cssValue: "rgb(255, 0, 0)"), 1, 0, 0)
		assertColor(RGBAColor.from(cssValue: "rgba(0, 128, 255, 0.5)"), 0, 0.5019607843, 1, alpha: 0.5)
		assertColor(RGBAColor.from(cssValue: "hsl(0 100% 50%)"), 1, 0, 0)
		assertColor(RGBAColor.from(cssValue: "hsl(120, 100%, 25%)"), 0, 0.5, 0)
	}

	func testRejectsInvalidAlpha() {
		XCTAssertNil(RGBAColor.from(cssValue: "rgb(255 0 0 / invalid)"))
		XCTAssertNil(RGBAColor.from(cssValue: "oklch(0.5 0.1 30 / nope)"))
		XCTAssertNil(RGBAColor.from(cssValue: "hsl(0 100% 50% / half)"))
	}

	func testParsesNamedColors() {
		assertColor(RGBAColor.from(cssValue: "white"), 1, 1, 1)
		assertColor(RGBAColor.from(cssValue: "transparent"), 0, 0, 0, alpha: 0)
	}

	func testRejectsEmptyFunctionBodies() {
		XCTAssertNil(RGBAColor.from(cssValue: "rgb()"))
		XCTAssertNil(RGBAColor.from(cssValue: "hsl()"))
		XCTAssertNil(RGBAColor.from(cssValue: "oklch()"))
	}

	func testRejectsUnparsableHue() {
		XCTAssertNil(RGBAColor.from(cssValue: "oklch(0.5 0.1 not-a-hue)"))
		// `none` is valid CSS and means an achromatic color.
		XCTAssertNotNil(RGBAColor.from(cssValue: "oklch(0.5 0 none)"))
	}

	/// Relative color syntax (`oklch(from var(--destructive) …)`) cannot be
	/// resolved without a CSS engine — callers fall back to their default token.
	func testRejectsRelativeColorSyntax() {
		XCTAssertNil(RGBAColor.from(cssValue: "oklch(from var(--destructive) min(l, 0.42) c h)"))
		XCTAssertNil(RGBAColor.from(cssValue: "var(--primary)"))
		XCTAssertNil(RGBAColor.from(cssValue: ""))
	}

	func testContrastAndLuminanceHelpers() {
		XCTAssertTrue(RGBAColor.white.isLight)
		XCTAssertFalse(RGBAColor.black.isLight)
		XCTAssertEqual(RGBAColor.black.contrastRatio(against: .white), 21, accuracy: 0.01)
		XCTAssertEqual(RGBAColor.white.hexString, "#ffffff")
		XCTAssertEqual(RGBAColor(red: 1, green: 0, blue: 0).hexString, "#ff0000")
	}
}
