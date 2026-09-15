// Tenant Android app (apps/android) — see README.md.
//
// Deliberately dependency-free at runtime: the app uses only the Android
// framework (no AndroidX, no Compose, no third-party networking/serialization),
// which is what keeps the per-tenant download under a megabyte. Everything
// below is build-time tooling.
pluginManagement {
	repositories {
		google()
		mavenCentral()
		gradlePluginPortal()
	}
}

dependencyResolutionManagement {
	repositories {
		google()
		mavenCentral()
	}
}

rootProject.name = "EpicTenantApp"
include(":app")
