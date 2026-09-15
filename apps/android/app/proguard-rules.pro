# R8 / resource shrinking rules for the release build.
#
# The app has no reflection, no serialization libraries, and no AndroidX, so the
# only things that must survive shrinking are the manifest entry points — which
# AGP keeps automatically. These rules make that explicit and keep R8 quiet
# about annotations it cannot resolve.

-keep class com.epicstartup.tenant.ui.MainActivity { public <init>(...); }

# Kotlin stdlib annotations are compile-time only.
-dontwarn org.jetbrains.annotations.**

# Keep line numbers so Play Console crash reports stay actionable, without
# shipping a full source file name table.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
