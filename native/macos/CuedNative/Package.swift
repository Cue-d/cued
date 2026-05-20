// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "CuedNative",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .library(name: "Interface", type: .dynamic, targets: ["Interface"]),
    .executable(name: "preview", targets: ["Preview"]),
    .executable(name: "CuedNative", targets: ["CuedNative"]),
  ],
  targets: [
    .target(
      name: "Interface",
      path: "Sources/Interface",
      resources: [
        .process("Resources"),
      ],
      swiftSettings: [
        .unsafeFlags(["-parse-as-library"]),
      ]
    ),
    .executableTarget(
      name: "CuedNative",
      dependencies: ["Interface"],
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
      dependencies: ["Interface"],
      path: "tools/preview/support",
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("SwiftUI"),
      ]
    ),
    .executableTarget(
      name: "Preview",
      dependencies: ["PreviewSupport"],
      path: "tools/preview/source"
    ),
    .testTarget(
      name: "CuedNativeTests",
      dependencies: ["CuedNative", "Interface", "PreviewSupport"],
      path: "Tests/CuedNativeTests"
    ),
  ]
)
