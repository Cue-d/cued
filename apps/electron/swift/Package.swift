// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "cued-contacts",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(name: "cued-contacts", targets: ["cued-contacts"])
    ],
    targets: [
        .executableTarget(
            name: "cued-contacts",
            dependencies: [],
            swiftSettings: [
                .swiftLanguageMode(.v6),
                .unsafeFlags(["-parse-as-library"])
            ]
        )
    ]
)
