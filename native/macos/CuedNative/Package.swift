// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "CuedNative",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .library(name: "CuedNativeUI", type: .dynamic, targets: ["CuedNativeUI"]),
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
    .testTarget(
      name: "CuedNativeTests",
      dependencies: ["CuedNative", "CuedNativeUI"],
      path: "Tests/CuedNativeTests"
    ),
  ]
)
