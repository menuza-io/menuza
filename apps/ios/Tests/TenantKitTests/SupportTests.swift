import XCTest

@testable import TenantKit

final class SupportTests: XCTestCase {
	// MARK: - Phone numbers

	func testNormalizesPhoneNumbersLikeTenantAPI() {
		XCTAssertEqual(PhoneNumber.normalize("+1 (555) 000-1111"), "+15550001111")
		XCTAssertEqual(PhoneNumber.normalize(" +966 50 000 0000 "), "+966500000000")
	}

	func testRejectsNonNumericPhoneNumbers() {
		XCTAssertTrue(PhoneNumber.isValid("+15550001111"))
		XCTAssertTrue(PhoneNumber.isValid("+966 50 000 0000"))
		XCTAssertFalse(PhoneNumber.isValid("123"))
		XCTAssertFalse(PhoneNumber.isValid("+1555"))
		XCTAssertFalse(PhoneNumber.isValid("abcdefg"))
		XCTAssertFalse(PhoneNumber.isValid("+1555-ABC-1111"))
		XCTAssertFalse(PhoneNumber.isValid("+12345678901234567890"))
		// Arabic-Indic digits are numbers but not ASCII, and the OTP path cannot process them.
		XCTAssertFalse(PhoneNumber.isValid("+٥٥٥٠٠٠١١١١"))
	}

	func testFormatsPhoneNumbersForDisplay() {
		XCTAssertEqual(PhoneNumber.display("+15550001111"), "+1 555 000 1111")
		XCTAssertEqual(PhoneNumber.display("+966500000000"), "+966 500 000 000")
		// No `+`: nothing to group, and the raw value is returned unchanged.
		XCTAssertEqual(PhoneNumber.display("5550001111"), "5550001111")
	}

	// MARK: - JWT claims

	func testDecodesAccessTokenClaims() {
		let token = makeAccessToken(customerId: "cust_9", orgId: "org_9", name: "Ada Lovelace")
		let claims = JWTPayload.decode(token)

		XCTAssertEqual(claims?.customerId, "cust_9")
		XCTAssertEqual(claims?.orgId, "org_9")
		XCTAssertEqual(claims?.name, "Ada Lovelace")
		XCTAssertFalse(claims?.isExpired ?? true)
	}

	func testDetectsExpiredTokens() {
		let token = makeAccessToken(expiresIn: -60)
		XCTAssertTrue(JWTPayload.decode(token)?.isExpired ?? false)
	}

	func testRejectsMalformedTokens() {
		XCTAssertNil(JWTPayload.decode("not-a-jwt"))
		XCTAssertNil(JWTPayload.decode("a.b.c"))
	}

	// MARK: - Site addresses

	func testParsesBareSlugIntoBrandSubdomain() {
		let address = SiteAddress.parse("acme", brandDomain: "epic-startup.com")

		XCTAssertEqual(address?.slug, "acme")
		XCTAssertNil(address?.host)
		XCTAssertEqual(address?.origin?.absoluteString, "https://acme.epic-startup.com")
		XCTAssertEqual(address?.authOriginHeader, "https://acme.epic-startup.com")
	}

	func testParsesBrandSubdomainAndCustomDomain() {
		let branded = SiteAddress.parse("ACME.Epic-Startup.com", brandDomain: "epic-startup.com")
		XCTAssertEqual(branded?.slug, "acme")
		XCTAssertNil(branded?.host)

		let custom = SiteAddress.parse("https://www.acme.com/pricing", brandDomain: "epic-startup.com")
		XCTAssertNil(custom?.slug)
		XCTAssertEqual(custom?.host, "www.acme.com")
		XCTAssertEqual(custom?.origin?.absoluteString, "https://www.acme.com")
	}

	func testKeepsLocalDevelopmentOriginsInsecure() {
		let address = SiteAddress.parse("http://acme.epic-startup.test:3010", brandDomain: "epic-startup.test")

		XCTAssertEqual(address?.slug, "acme")
		XCTAssertEqual(address?.origin?.absoluteString, "http://acme.epic-startup.test:3010")
		// tenant-api only accepts Origin binding for https origins.
		XCTAssertNil(address?.authOriginHeader)
	}

	func testRejectsEmptyAddresses() {
		XCTAssertNil(SiteAddress.parse("   ", brandDomain: "epic-startup.com"))
	}

	func testWhiteLabelBindingWinsOverAStoredAddress() {
		let build = SiteAddress(slug: "acme", origin: URL(string: "https://acme.epic-startup.com"))
		let stored = SiteAddress(slug: "other", origin: URL(string: "https://other.epic-startup.com"))

		// A branded build must not be re-pointed by an earlier un-branded install.
		XCTAssertEqual(SiteAddress.resolve(build: build, stored: stored), build)

		// An un-branded build keeps whatever the customer chose.
		let unbound = SiteAddress()
		XCTAssertEqual(SiteAddress.resolve(build: unbound, stored: stored), stored)
		XCTAssertEqual(SiteAddress.resolve(build: unbound, stored: nil), unbound)
	}

	func testBuildsQueryItemsForSlugAndHost() {
		XCTAssertEqual(
			SiteAddress(slug: "acme").queryItems.map(\.name),
			["slug"]
		)
		XCTAssertEqual(
			SiteAddress(slug: "acme", host: "www.acme.com").queryItems.map(\.name),
			["host"]
		)
	}

	// MARK: - Configuration

	func testReadsConfigurationFromInfoDictionary() {
		let configuration = TenantConfiguration.from(infoDictionary: [
			"EpicAppBaseURL": "https://app.epic-startup.com",
			"EpicTenantAPIUSBaseURL": "tenant-us.epic-startup.com",
			"EpicTenantAPIKSABaseURL": "https://tenant-ksa.epic-startup.com",
			"EpicBrandDomain": "epic-startup.com",
			"EpicSiteSlug": "acme",
			"EpicSiteOrigin": "https://acme.epic-startup.com",
		])

		XCTAssertEqual(configuration.appBaseURL.absoluteString, "https://app.epic-startup.com")
		XCTAssertEqual(configuration.tenantAPIBaseURLUS.absoluteString, "https://tenant-us.epic-startup.com")
		XCTAssertEqual(configuration.tenantAPIBaseURL(forDataRegion: "ksa").host, "tenant-ksa.epic-startup.com")
		XCTAssertEqual(configuration.siteAddress.slug, "acme")
		XCTAssertTrue(configuration.isBoundToTenant)
	}

	func testFallsBackToLocalDevelopmentConfiguration() {
		let configuration = TenantConfiguration.from(infoDictionary: [:])

		XCTAssertEqual(configuration.appBaseURL.absoluteString, "http://localhost:3001")
		XCTAssertEqual(configuration.tenantAPIBaseURLUS.absoluteString, "http://localhost:3007")
		XCTAssertEqual(configuration.tenantAPIBaseURL(forDataRegion: "ksa").absoluteString, "http://localhost:3009")
		XCTAssertFalse(configuration.isBoundToTenant)
	}

	func testRegionSelectsTheMatchingTenantAPINode() {
		let configuration = makeConfiguration(region: "us")
		XCTAssertEqual(configuration.tenantAPIBaseURL.host, "tenant-us.epic-startup.com")

		var ksaConfiguration = configuration
		ksaConfiguration.dataRegion = "KSA"
		XCTAssertEqual(ksaConfiguration.tenantAPIBaseURL.host, "tenant-ksa.epic-startup.com")
	}
}
