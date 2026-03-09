// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "CuedNative",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .executable(name: "CuedNative", targets: ["CuedNative"]),
  ],
  targets: [
    .executableTarget(
      name: "CuedNative",
      path: "Sources/CuedNative",
      swiftSettings: [
        .unsafeFlags(["-parse-as-library"]),
      ],
      linkerSettings: [
        .linkedLibrary("sqlite3"),
      ]
    ),
  ]
)
