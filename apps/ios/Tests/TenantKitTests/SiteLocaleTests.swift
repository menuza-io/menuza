import XCTest

@testable import TenantKit

final class SiteLocaleTests: XCTestCase {
	func testNormalizesLocaleCodes() {
		XCTAssertEqual(SiteLocale.normalized("ar-SA"), "ar")
		XCTAssertEqual(SiteLocale.normalized("EN"), "en")
		XCTAssertEqual(SiteLocale.normalized(""), "en")
	}

	func testKnowsTheSharedContentLocales() {
		XCTAssertEqual(SiteLocale.contentLocales, ["en", "ar", "es", "fr", "de", "zh"])
		XCTAssertTrue(SiteLocale.isRTL("ar"))
		XCTAssertFalse(SiteLocale.isRTL("en"))
		XCTAssertEqual(SiteLocale.label("zh"), "Chinese")
		XCTAssertEqual(SiteLocale.label("pt"), "pt")
	}

	func testNegotiationPrefersExactThenLanguageThenDefault() {
		XCTAssertEqual(
			SiteLocale.negotiate(preferred: ["ar-SA"], supported: ["en", "ar"], defaultLocale: "en"),
			"ar"
		)
		XCTAssertEqual(
			SiteLocale.negotiate(preferred: ["fr-CA", "de"], supported: ["en", "de"], defaultLocale: "en"),
			"de"
		)
		XCTAssertEqual(
			SiteLocale.negotiate(preferred: ["pt-BR"], supported: ["en", "ar"], defaultLocale: "ar"),
			"ar"
		)
		XCTAssertEqual(
			SiteLocale.negotiate(preferred: [], supported: [], defaultLocale: "en"),
			"en"
		)
	}

	func testAppLanguagePrefersCustomerOverride() {
		let organization = PublicOrganization(
			id: "org_1",
			name: "Acme",
			slug: "acme",
			locales: ["en", "ar"],
			defaultLocale: "en",
			locale: "en"
		)

		let override = AppLanguage.resolve(
			organization: organization,
			deviceLanguages: ["en-US"],
			appLocales: ["en", "ar"],
			override: "ar"
		)
		XCTAssertEqual(override.code, "ar")
		XCTAssertTrue(override.isRTL)
		XCTAssertEqual(override.locale.identifier, "ar")
	}

	func testAppLanguageFollowsTheTranslatedDeviceLanguage() {
		let organization = PublicOrganization(
			id: "org_1",
			name: "Acme",
			slug: "acme",
			locales: ["en", "ar"],
			defaultLocale: "en",
			locale: "ar"
		)

		let language = AppLanguage.resolve(
			organization: organization,
			deviceLanguages: ["de-DE", "en-US"],
			appLocales: ["en", "de", "ar"]
		)

		XCTAssertEqual(language.code, "de")
		XCTAssertFalse(language.isRTL)
	}

	func testAppLanguageFallsBackToTheOrgLocaleWhenTheDeviceIsUntranslated() {
		let organization = PublicOrganization(
			id: "org_1",
			name: "Acme",
			slug: "acme",
			locales: ["ar"],
			defaultLocale: "ar",
			locale: "ar"
		)

		let language = AppLanguage.resolve(
			organization: organization,
			deviceLanguages: ["ja-JP"],
			appLocales: ["en", "ar"]
		)

		XCTAssertEqual(language.code, "ar")
		XCTAssertTrue(language.isRTL)
	}

	func testAppLanguageFallsBackToEnglishWithoutATranslatedMatch() {
		let unsupportedDevice = AppLanguage.resolve(
			organization: nil,
			deviceLanguages: ["ja-JP"],
			appLocales: ["en", "ar"]
		)
		XCTAssertEqual(unsupportedDevice.code, "en")
	}
}
