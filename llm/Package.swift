// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "prm-llm",
    platforms: [
        .macOS(.v15)  // Minimum deployment, but Apple Intelligence requires macOS 26+
    ],
    products: [
        .executable(name: "prm-llm", targets: ["prm-llm"])
    ],
    dependencies: [
        .package(url: "https://github.com/mattt/AnyLanguageModel.git", from: "0.5.0")
    ],
    targets: [
        .executableTarget(
            name: "prm-llm",
            dependencies: [
                .product(name: "AnyLanguageModel", package: "AnyLanguageModel")
            ],
            swiftSettings: [
                .swiftLanguageMode(.v6)
            ]
        )
    ]
)
