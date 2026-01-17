// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "prm-contacts",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(name: "prm-contacts", targets: ["prm-contacts"])
    ],
    targets: [
        .executableTarget(
            name: "prm-contacts",
            dependencies: [],
            swiftSettings: [
                .swiftLanguageMode(.v6),
                .unsafeFlags(["-parse-as-library"])
            ]
        )
    ]
)
