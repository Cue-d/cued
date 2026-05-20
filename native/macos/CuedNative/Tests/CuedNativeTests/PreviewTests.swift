import Foundation
import XCTest
@testable import Interface
@testable import PreviewSupport

final class PreviewTests: XCTestCase {
  func testPreviewCasesAreStableAndNamedForTheirRootState() {
    XCTAssertEqual(
      Preview.cases.map(\.name),
      [
        "welcome",
        "permissions-missing",
        "permissions-granted",
        "platforms-fresh",
        "platforms-mixed",
        "use-cases",
        "application-home",
      ]
    )
    XCTAssertEqual(Set(Preview.cases.map(\.name)).count, Preview.cases.count)
  }

  func testUnknownPreviewCaseIsRejected() {
    XCTAssertNil(Preview.previewCase(named: "missing"))
  }

  func testPreviewSizeOverridePreservesCaseIdentity() throws {
    let previewCase = try XCTUnwrap(
      Preview.previewCase(named: "platforms-mixed", size: CGSize(width: 700, height: 800))
    )

    XCTAssertEqual(previewCase.name, "platforms-mixed")
    XCTAssertEqual(previewCase.page, 2)
    XCTAssertEqual(previewCase.size, CGSize(width: 700, height: 800))
  }

  func testMissingSkillPreviewUsesDefaultSkillStatusCopy() {
    XCTAssertEqual(
      defaultPreviewSkillStatus().summary,
      "Checks whether the global Cued skill is available to your agents."
    )
  }

  @MainActor
  func testRendersEveryPreviewFixture() throws {
    let outputDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent("cued-preview-tests", isDirectory: true)
    try? FileManager.default.removeItem(at: outputDirectory)

    let results = try Preview.renderAll(outputDirectory: outputDirectory)

    XCTAssertEqual(results.map(\.previewCase.name), Preview.cases.map(\.name))
    for result in results {
      XCTAssertGreaterThanOrEqual(result.metrics.width, Int(result.previewCase.size.width))
      XCTAssertGreaterThanOrEqual(result.metrics.height, Int(result.previewCase.size.height))
      XCTAssertTrue(result.metrics.isVisuallyNonBlank, "\(result.previewCase.name) rendered blank")
      XCTAssertTrue(FileManager.default.fileExists(atPath: result.url.path))
    }
  }
}
