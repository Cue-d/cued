// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "CuedNative",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .library(name: "CuedNativeUI", type: .dynamic, targets: ["CuedNativeUI"]),
    .executable(name: "onboarding-preview", targets: ["Preview"]),
    .executable(name: "CuedNative", targets: ["CuedNative"]),
  ],
  targets: [
    .target(
      name: "CuedNativeUI",
      path: "Sources/CuedNativeUI",
      resources: [
        .process("Resources"),
      ],
      swiftSettings: [
        .unsafeFlags(["-parse-as-library"]),
      ]
    ),
    .executableTarget(
      name: "CuedNative",
      dependencies: ["CuedNativeUI"],
      path: "Sources/CuedNative",
      swiftSettings: [
        .unsafeFlags(["-parse-as-library"]),
      ],
      linkerSettings: [
        .linkedLibrary("sqlite3"),
      ]
    ),
    .target(
      name: "PreviewSupport",
      dependencies: ["CuedNativeUI"],
      path: "tools/onboarding-preview/support",
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("SwiftUI"),
      ]
    ),
    .executableTarget(
      name: "Preview",
      dependencies: ["PreviewSupport"],
      path: "tools/onboarding-preview/source"
    ),
    .testTarget(
      name: "CuedNativeTests",
      dependencies: ["CuedNative", "CuedNativeUI", "PreviewSupport"],
      path: "Tests/CuedNativeTests"
    ),
  ]
)
