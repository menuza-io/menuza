package com.epicstartup.tenant.core

import com.epicstartup.tenant.core.localization.AppLanguage
import com.epicstartup.tenant.core.localization.SiteLocale
import com.epicstartup.tenant.core.model.PublicOrganization
import com.epicstartup.tenant.core.support.IconDecode
import com.epicstartup.tenant.core.support.JwtPayload
import com.epicstartup.tenant.core.support.PhoneNumber
import com.epicstartup.tenant.core.support.SiteAddress
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class IconDecodeTest {
	@Test
	fun downsamplesToTheHeaderSize() {
		// A 36dp header needs 144px at the densest screens; 192 keeps headroom.
		assertEquals(1, IconDecode.plan(108, 108)?.sampleSize)
		assertEquals(1, IconDecode.plan(192, 192)?.sampleSize)
		assertEquals(2, IconDecode.plan(384, 384)?.sampleSize)
		assertEquals(4, IconDecode.plan(1024, 1024)?.sampleSize)
		// The shorter side caps the sample size: 1080 / 8 is already below 192.
		assertEquals(4, IconDecode.plan(2048, 1080)?.sampleSize)
		// Powers of two only: `BitmapFactory` rounds anything else down.
		assertEquals(16, IconDecode.sampleSizeFor(4000, 4000))
	}

	@Test
	fun refusesWhatIsNotAnIcon() {
		assertNull(IconDecode.plan(0, 0))
		assertNull(IconDecode.plan(-1, 512))
		assertNull(IconDecode.plan(9_000, 512))
		// 8192² is 67MP: past the pixel budget even though each side fits.
		assertNull(IconDecode.plan(8_192, 8_192))
		assertNull(IconDecode.plan(6_000, 6_000))
		assertNotNull(IconDecode.plan(8_192, 512))
		assertNotNull(IconDecode.plan(4_000, 4_000))
	}
}

class PhoneNumberTest {
	@Test
	fun normalizesLikeTenantApi() {
		assertEquals("+15550000000", PhoneNumber.normalize("+1 (555) 000-0000"))
		assertEquals("+966501234567", PhoneNumber.normalize(" +966 50-123-4567 "))
	}

	@Test
	fun acceptsPlausibleNumbersOnly() {
		assertTrue(PhoneNumber.isValid("+15550000000"))
		assertTrue(PhoneNumber.isValid("5550000000"))
		assertFalse(PhoneNumber.isValid("+1 (555) 000-0000x"))
		assertFalse(PhoneNumber.isValid("1234"))
		assertFalse(PhoneNumber.isValid("+١٢٣٤٥٦٧٨٩٠١٢٣٤٥٦٧"))
	}

	@Test
	fun formatsKnownCountryCodesForDisplay() {
		assertEquals("+966 501 234 567", PhoneNumber.display("+966501234567"))
		assertEquals("+1 555 000 0000", PhoneNumber.display("+15550000000"))
		// An unknown prefix is left alone rather than guessed at.
		assertEquals("+99912345678", PhoneNumber.display("+99912345678"))
		// A short national number is not grouped either.
		assertEquals("+96650", PhoneNumber.display("+96650"))
		assertEquals("5550000", PhoneNumber.display("5550000"))
	}
}

class SiteAddressTest {
	@Test
	fun parsesBareSlugAgainstTheBrandDomain() {
		val address = SiteAddress.parse("acme", "epic-startup.com")
		assertNotNull(address)
		assertEquals("acme", address.slug)
		assertNull(address.host)
		assertEquals("https://acme.epic-startup.com", address.origin)
	}

	@Test
	fun parsesPlatformSubdomainsAsSlugs() {
		val address = SiteAddress.parse("https://acme.epic-startup.com/shop?ref=1", "epic-startup.com")
		assertNotNull(address)
		assertEquals("acme", address.slug)
		assertNull(address.host)
	}

	@Test
	fun parsesCustomDomainsAsHosts() {
		val address = SiteAddress.parse("https://www.acme.com/menu", "epic-startup.com")
		assertNotNull(address)
		assertNull(address.slug)
		assertEquals("www.acme.com", address.host)
		assertEquals(listOf("host" to "www.acme.com"), address.queryItems)
	}

	@Test
	fun parsesNestedSubdomainsOfTheBrandDomainAsHosts() {
		val address = SiteAddress.parse("shop.acme.epic-startup.com", "epic-startup.com")
		assertNotNull(address)
		assertNull(address.slug)
		assertEquals("shop.acme.epic-startup.com", address.host)
	}

	@Test
	fun parsesLocalDevelopmentHosts() {
		// A typed address defaults to https, so it is sent as the binding origin
		// (tenant-api rejects an origin that belongs to another tenant).
		val typed = SiteAddress.parse("acme.localhost:3010", "epic-startup.test")
		assertNotNull(typed)
		assertNull(typed.slug)
		assertEquals("acme.localhost", typed.host)
		assertEquals("https://acme.localhost:3010", typed.authOriginHeader)

		// An explicit http:// origin is local development: no header, so the
		// slug/host body binding applies (which tenant-api allows off-production).
		val local = SiteAddress.parse("http://acme.epic-startup.test:3010", "epic-startup.test")
		assertNotNull(local)
		assertEquals("acme", local.slug)
		assertNull(local.authOriginHeader)
	}

	@Test
	fun rejectsEmptyInput() {
		assertNull(SiteAddress.parse("   ", "epic-startup.com"))
		assertNull(SiteAddress.parse("https://", "epic-startup.com"))
	}

	@Test
	fun onlySendsHttpsOriginsAsTheAuthHeader() {
		val https = SiteAddress(slug = "acme", origin = "https://acme.epic-startup.com")
		assertEquals("https://acme.epic-startup.com", https.authOriginHeader)

		val http = SiteAddress(slug = "acme", origin = "http://acme.epic-startup.test:3010")
		assertNull(http.authOriginHeader)

		val trailing = SiteAddress(slug = "acme", origin = "https://acme.epic-startup.com/")
		assertEquals("https://acme.epic-startup.com", trailing.authOriginHeader)
	}

	@Test
	fun buildBindingWinsOverStoredAddress() {
		val build = SiteAddress(slug = "acme", origin = "https://acme.epic-startup.com")
		val stored = SiteAddress(slug = "other", origin = "https://other.epic-startup.com")
		assertEquals(build, SiteAddress.resolve(build = build, stored = stored))

		val unbound = SiteAddress()
		assertEquals(stored, SiteAddress.resolve(build = unbound, stored = stored))
		assertEquals(unbound, SiteAddress.resolve(build = unbound, stored = null))
	}
}

class JwtPayloadTest {
	@Test
	fun decodesClaimsFromTheAccessToken() {
		val payload = JwtPayload.decode(makeAccessToken(orgId = "org_42", name = "Jane Doe"))
		assertNotNull(payload)
		assertEquals("org_42", payload.orgId)
		assertEquals("cus_1", payload.customerId)
		assertEquals("Jane Doe", payload.name)
		assertFalse(payload.isExpired)
	}

	@Test
	fun fallsBackToTheSubjectClaimForTheCustomerId() {
		val token = "${base64Url("""{"alg":"none"}""")}.${base64Url("""{"sub":"cus_9"}""")}.x"
		assertEquals("cus_9", JwtPayload.decode(token)?.customerId)
	}

	@Test
	fun reportsExpiredTokens() {
		val token = makeAccessToken(expiresAtSeconds = System.currentTimeMillis() / 1000 - 60)
		assertTrue(JwtPayload.decode(token)?.isExpired == true)
	}

	@Test
	fun rejectsMalformedTokens() {
		assertNull(JwtPayload.decode("not-a-jwt"))
		assertNull(JwtPayload.decode("header.!!!not-base64!!!.signature"))
	}

	@Test
	fun decodesBase64UrlWithMissingPadding() {
		val decoded = JwtPayload.base64UrlDecode(base64Url("hello"))
		assertEquals("hello", String(decoded ?: ByteArray(0), Charsets.UTF_8))
	}
}

class SiteLocaleTest {
	@Test
	fun normalizesLocaleTags() {
		assertEquals("ar", SiteLocale.normalized("AR-SA"))
		assertEquals("en", SiteLocale.normalized("  "))
	}

	@Test
	fun negotiatesExactThenLanguageMatches() {
		assertEquals("ar", SiteLocale.match(listOf("ar-SA"), listOf("en", "ar")))
		assertEquals("en", SiteLocale.match(listOf("en-GB"), listOf("en", "ar")))
		assertNull(SiteLocale.match(listOf("ja"), listOf("en", "ar")))
	}

	@Test
	fun negotiateFallsBackToTheOrgDefault() {
		assertEquals(
			"ar",
			SiteLocale.negotiate(preferred = listOf("ja"), supported = listOf("en", "ar"), defaultLocale = "ar"),
		)
		assertEquals(
			"en",
			SiteLocale.negotiate(preferred = listOf("ja"), supported = listOf("en", "ar"), defaultLocale = "ja"),
		)
	}

	private fun organization(locale: String? = null, defaultLocale: String? = null) = PublicOrganization(
		id = "org_1",
		name = "Acme",
		slug = "acme",
		locales = listOf("en", "ar"),
		defaultLocale = defaultLocale,
		locale = locale,
	)

	@Test
	fun languageOverrideWins() {
		val language = AppLanguage.resolve(
			organization = organization(locale = "ar"),
			deviceLanguages = listOf("de-DE"),
			appLocales = SiteLocale.contentLocales,
			override = "en",
		)
		assertEquals("en", language.code)
	}

	@Test
	fun deviceLanguageWinsOverTheOrgLocale() {
		val language = AppLanguage.resolve(
			organization = organization(locale = "ar"),
			deviceLanguages = listOf("de-DE"),
			appLocales = SiteLocale.contentLocales,
		)
		assertEquals("de", language.code)
	}

	@Test
	fun orgLocaleWinsWhenTheDeviceLanguageIsNotTranslated() {
		val language = AppLanguage.resolve(
			organization = organization(locale = "ar"),
			deviceLanguages = listOf("ja-JP"),
			appLocales = SiteLocale.contentLocales,
		)
		assertEquals("ar", language.code)
		assertTrue(language.isRtl)
	}

	@Test
	fun fallsBackToEnglishWithoutAnOrganization() {
		val language = AppLanguage.resolve(
			organization = null,
			deviceLanguages = listOf("ja-JP"),
			appLocales = SiteLocale.contentLocales,
		)
		assertEquals("en", language.code)
		assertFalse(language.isRtl)
	}
}
