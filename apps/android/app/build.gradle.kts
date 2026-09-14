import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Tenant Android app module — a branded shell, phone-OTP sign-in, and the
// customer profile. See ../README.md for the size budget and why this app has
// no AndroidX/Compose/third-party runtime dependencies.
plugins {
	id("com.android.application")
	id("org.jetbrains.kotlin.android")
}

// ---------------------------------------------------------------- tenant config --
// `app/tenant.properties` is written by `scripts/generate-tenant.mjs` from
// `tenants/<slug>.json`. When it is absent the build is the *un-branded* app:
// production endpoints for release, local dev servers for debug, and the
// customer connects their own site on first launch (mirrors apps/ios).
val tenant = Properties().apply {
	val file = rootProject.file("app/tenant.properties")
	if (file.exists()) file.inputStream().use { load(it) }
}
val isTenantBuild = tenant.isNotEmpty()

fun tenantValue(key: String, fallback: String): String =
	tenant.getProperty(key)?.trim().orEmpty().ifEmpty { fallback }

fun tenantFlag(key: String, fallback: Boolean): Boolean =
	when (tenantValue(key, "").lowercase()) {
		"yes", "true", "1" -> true
		"no", "false", "0" -> false
		else -> fallback
	}

// Release signing comes from `app/keystore.properties` (gitignored, written by
// CI from the tenant's GitHub environment). Without it the release build is
// unsigned, which is what `npm run android:apk` does locally to measure size.
// Un-branded debug builds point at the emulator's host alias. A physical device
// (or a machine where the dev servers are not on the host loopback) can override
// it, typically after `adb reverse`:
//
//   npm run android:run -w android -- -PdevHost=localhost
val devHost = (project.findProperty("devHost") as? String)?.trim().orEmpty().ifEmpty { "10.0.2.2" }

val keystore = Properties().apply {
	val file = rootProject.file("app/keystore.properties")
	if (file.exists()) file.inputStream().use { load(it) }
}

android {
	namespace = "com.epicstartup.tenant"
	compileSdk = 36

	defaultConfig {
		applicationId = tenantValue("applicationId", "com.epicstartup.tenant")
		// 26 keeps adaptive launcher icons (no legacy bitmap set to ship) and
		// still reaches ~97% of active devices; R8 also gets to drop more
		// API-compatibility code. Lower it only with a reason.
		minSdk = 26
		targetSdk = 36
		versionCode = tenantValue("versionCode", "1").toIntOrNull() ?: 1
		versionName = tenantValue("versionName", "1.0.0")

		// Endpoints are resources (not BuildConfig): a tenant config is a data
		// change, so `npm run android:tenant` never rewrites Kotlin sources.
		// Values are host-or-URL strings; the app adds the scheme from `use_tls`
		// and refuses cleartext to anything but loopback (TenantConfiguration).
		resValue("string", "app_name", tenantValue("appName", "Tenant"))
		resValue("bool", "tenant_use_tls", tenantFlag("useTls", true).toString())
		resValue("string", "tenant_app_base_url", tenantValue("appBaseUrl", "app.epic-startup.com"))
		resValue("string", "tenant_brand_domain", tenantValue("brandDomain", "epic-startup.com"))
		resValue("string", "tenant_api_us_base_url", tenantValue("tenantApiUs", "tenant-us.epic-startup.com"))
		resValue("string", "tenant_api_ksa_base_url", tenantValue("tenantApiKsa", "tenant-ksa.epic-startup.com"))
		resValue("string", "tenant_site_slug", tenantValue("siteSlug", ""))
		resValue("string", "tenant_site_host", tenantValue("siteHost", ""))
		resValue("string", "tenant_site_origin", tenantValue("siteOrigin", ""))
		resValue("integer", "tenant_request_timeout_ms", tenantValue("requestTimeoutMs", "15000"))
	}

	signingConfigs {
		if (keystore.isNotEmpty()) {
			create("release") {
				storeFile = rootProject.file(keystore.getProperty("storeFile"))
				storePassword = keystore.getProperty("storePassword")
				keyAlias = keystore.getProperty("keyAlias")
				keyPassword = keystore.getProperty("keyPassword")
			}
		}
	}

	buildTypes {
		debug {
			// Un-branded debug builds talk to the local dev servers over http.
			// 10.0.2.2 is the emulator's alias for the host machine, so the app
			// works from the emulator without extra setup; on a physical device
			// either run `adb reverse tcp:3001 tcp:3001` (and use localhost) or
			// write a tenant.properties with the machine's LAN address.
			// Cleartext is only permitted for loopback hosts.
			if (!isTenantBuild) {
				resValue("bool", "tenant_use_tls", "false")
				resValue("string", "tenant_app_base_url", "$devHost:3001")
				resValue("string", "tenant_brand_domain", "epic-startup.test")
				resValue("string", "tenant_api_us_base_url", "$devHost:3007")
				resValue("string", "tenant_api_ksa_base_url", "$devHost:3009")
			}
		}
		release {
			isMinifyEnabled = true
			isShrinkResources = true
			proguardFiles(
				getDefaultProguardFile("proguard-android-optimize.txt"),
				"proguard-rules.pro",
			)
			if (keystore.isNotEmpty()) {
				signingConfig = signingConfigs.getByName("release")
			}
		}
	}

	// Only the locales the app ships. Anything else is dead weight.
	androidResources {
		localeFilters += listOf("en", "ar", "de", "es", "fr", "zh")
	}

	// Language splits are off on purpose: the profile screen lets a customer
	// switch language at runtime, and a device that only downloaded its own
	// language split would silently fall back to English for the others (the
	// `AppBundleLocaleChanges` lint check). Six locales cost ~30 KB compressed,
	// and `localeFilters` above keeps every other language out.
	bundle {
		language {
			enableSplit = false
		}
	}

	// Keep the AAB lean. `kotlin/**/*.kotlin_builtins` is stdlib metadata that is
	// only read through kotlin-reflect, which this app does not ship (verified
	// against the release dex). If a reflection-based library is ever added
	// (kotlinx.serialization, a DI container, ...), drop that exclusion.
	packaging {
		resources {
			excludes += listOf(
				"/META-INF/{AL2.0,LGPL2.1}",
				"META-INF/*.version",
				"META-INF/*.kotlin_module",
				"kotlin-tooling-metadata.json",
				"DebugProbesKt.bin",
				"/kotlin/**",
			)
		}
	}

	// Play uploads are gated on CI instead (see .github/workflows/android.yml).
	lint {
		checkReleaseBuilds = false
		// Every view in this app is built in code, so the "custom view needs a
		// (Context, AttributeSet) constructor" rule cannot apply.
		disable += "ViewConstructor"
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}
}

kotlin {
	compilerOptions {
		jvmTarget = JvmTarget.JVM_17
	}
}

// The core (config, models, networking, session, theme, localization) is plain
// Kotlin + org.json, so it runs on the JVM and is covered by `testDebugUnitTest`.
// `org.json:json` is the real implementation; without it the unit tests would
// see the stubbed android.jar version.
dependencies {
	testImplementation("junit:junit:4.13.2")
	testImplementation("org.json:json:20260814")
	testImplementation(kotlin("test"))
}
