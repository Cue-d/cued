// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "prm-llm",
    platforms: [
        .macOS(.v15)  // Minimum deployment, but Apple Intelligence requires macOS 26+
    ],
    products: [
        .executable(name: "prm-llm", targets: ["prm-llm"]),
        .executable(name: "prm-contacts", targets: ["prm-contacts"])
    ],
    // AnyLanguageModel uses Swift 6.1 traits to conditionally include heavy dependencies, allowing you to opt-in only to the language model backends you need. This results in smaller binary sizes and faster build times.
    // By default, no traits are enabled. To enable specific traits, specify them in your package's dependencies:
    // dependencies: [
    //     .package(
    //         url: "https://github.com/mattt/AnyLanguageModel.git",
    //         from: "0.5.0",
    //         traits: ["CoreML", "MLX"] // Enable CoreML and MLX support
    //     )
    // ]
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
        ),
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
