// swift-tools-version: 5.9
import PackageDescription

/// `TenantKit` is the platform-independent half of the tenant iOS app:
/// tenant resolution, the public Sites + regional tenant-api contracts,
/// site theming, and customer session handling. It depends on Foundation
/// only, so it builds and tests on macOS **and** Linux (`swift test`).
///
/// The SwiftUI app itself lives in `Sources/TenantApp` and is compiled by
/// Xcode through `project.yml` (XcodeGen), because SwiftPM cannot produce an
/// iOS application bundle.
let package = Package(
	name: "TenantKit",
	platforms: [
		.iOS(.v17),
		.macOS(.v14),
	],
	products: [
		.library(name: "TenantKit", targets: ["TenantKit"]),
	],
	targets: [
		.target(
			name: "TenantKit",
			path: "Sources/TenantKit"
		),
		.testTarget(
			name: "TenantKitTests",
			dependencies: ["TenantKit"],
			path: "Tests/TenantKitTests"
		),
	],
	swiftLanguageVersions: [.v5]
)
