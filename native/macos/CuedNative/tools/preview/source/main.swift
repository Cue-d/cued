import Foundation
import PreviewSupport

enum PreviewCommand {
  @MainActor
  static func run() throws {
    var arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first else {
      printUsage()
      return
    }
    arguments.removeFirst()

    let options = try PreviewOptions(arguments: arguments)
    switch command {
    case "list":
      for previewCase in Preview.cases {
        print("\(previewCase.name)\tpage=\(previewCase.page)\t\(Int(previewCase.size.width))x\(Int(previewCase.size.height))")
      }
    case "all":
      printResults(try Preview.renderAll(outputDirectory: options.outputDirectory))
    case "help", "--help", "-h":
      printUsage()
    default:
      guard let previewCase = Preview.previewCase(named: command, size: options.size) else {
        throw PreviewError.unknownCase(command)
      }
      printResults([
        try Preview.render(previewCase, outputDirectory: options.outputDirectory)
      ])
    }
  }

  private static func printResults(_ results: [PreviewResult]) {
    for result in results {
      let metrics = result.metrics
      print(
        [
          result.previewCase.name,
          result.url.path,
          "\(metrics.width)x\(metrics.height)",
          "bytes=\(metrics.byteCount)",
          "colors=\(metrics.distinctSampledColors)",
          "nonBackground=\(metrics.nonBackgroundSampleCount)",
        ].joined(separator: "\t")
      )
    }
  }

  private static func printUsage() {
    print(
      """
      Usage:
        swift run preview list
        swift run preview all [--output .build/previews]
        swift run preview <case-name> [--size 630x752] [--output dir]

      Examples:
        swift run preview all
        swift run preview permissions-missing
        swift run preview platforms-mixed --output .build/previews
      """
    )
  }
}

do {
  try await MainActor.run {
    try PreviewCommand.run()
  }
} catch {
  FileHandle.standardError.write(Data("\(error)\n".utf8))
  Foundation.exit(1)
}

private struct PreviewOptions {
  var size: CGSize?
  var outputDirectory = Preview.defaultOutputDirectory

  init(arguments: [String]) throws {
    var index = 0
    while index < arguments.count {
      let argument = arguments[index]
      let value = index + 1 < arguments.count ? arguments[index + 1] : nil
      switch argument {
      case "--size":
        guard let value else {
          throw PreviewError.invalidOption("--size requires a value like 630x752")
        }
        guard let parsedSize = Self.parseSize(value) else {
          throw PreviewError.invalidOption("--size must use WIDTHxHEIGHT, got \(value)")
        }
        size = parsedSize
        index += 2
      case "--output":
        guard let value else {
          throw PreviewError.invalidOption("--output requires a directory")
        }
        outputDirectory = URL(fileURLWithPath: value, isDirectory: true)
        index += 2
      default:
        throw PreviewError.invalidOption("unknown option \(argument)")
      }
    }
  }

  private static func parseSize(_ raw: String) -> CGSize? {
    let parts = raw.lowercased().split(separator: "x")
    guard parts.count == 2,
          let width = Double(parts[0]),
          let height = Double(parts[1]) else {
      return nil
    }
    return CGSize(width: width, height: height)
  }
}
