// Root build for the tenant Android app.
//
// Android Gradle Plugin 8.13 is the last 8.x line: it supports compileSdk 36
// (Play requires API 36 targets) on Gradle 8.14 and JDK 17, without the
// migration work AGP 9 asks for. Kotlin 2.2 matches that toolchain.
plugins {
	id("com.android.application") version "8.13.2" apply false
	id("org.jetbrains.kotlin.android") version "2.2.21" apply false
}
