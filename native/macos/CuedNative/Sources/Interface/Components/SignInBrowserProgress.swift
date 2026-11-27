import SwiftUI

/// What a browser sign-in is waiting on before its window opens, as the daemon reports it in
/// the onboarding snapshot. On a Mac with no supported browser this is mostly the download of
/// Cued's own Chromium, which takes minutes.
public struct SignInBrowserStatus: Decodable, Equatable, Sendable {
  public let platform: String
  public let accountKey: String
  public let stage: String
  public let receivedBytes: Int64?
  public let totalBytes: Int64?
  public let error: String?

  public init(
    platform: String,
    accountKey: String,
    stage: String,
    receivedBytes: Int64? = nil,
    totalBytes: Int64? = nil,
    error: String? = nil
  ) {
    self.platform = platform
    self.accountKey = accountKey
    self.stage = stage
    self.receivedBytes = receivedBytes
    self.totalBytes = totalBytes
    self.error = error
  }

  public var isFailed: Bool { stage == "failed" }

  /// Between 0 and 1 while the download size is known, otherwise nil.
  public var fractionComplete: Double? {
    guard stage == "downloading", let totalBytes, totalBytes > 0 else {
      return nil
    }
    return min(1, Double(receivedBytes ?? 0) / Double(totalBytes))
  }

  public var message: String {
    let megabyte: Int64 = 1024 * 1024
    switch stage {
    case "finding":
      return "Looking for a browser for the sign-in window"
    case "downloading":
      let received = (receivedBytes ?? 0) / megabyte
      if let totalBytes, totalBytes > 0 {
        let total = (totalBytes + megabyte - 1) / megabyte
        return "Downloading sign-in browser, \(received) of \(total) MB"
      }
      return "Downloading sign-in browser, \(received) MB"
    case "verifying":
      return "Checking the downloaded sign-in browser"
    case "extracting":
      return "Installing the sign-in browser"
    case "launching":
      return "Opening the sign-in window"
    case "failed":
      return error ?? "The sign-in browser could not be set up."
    default:
      return "Preparing the sign-in window"
    }
  }

  func matches(platform: String, accountKey: String) -> Bool {
    self.platform == platform && self.accountKey == accountKey
  }
}

extension RootView {
  /// Progress shown under an account that is waiting for its sign-in window. The account row's
  /// own Cancel button stops it, download included.
  func signInBrowserProgress(_ status: SignInBrowserStatus) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      if let fraction = status.fractionComplete {
        ProgressView(value: fraction)
          .progressViewStyle(.linear)
          .frame(maxWidth: 280)
          .accessibilityLabel(status.message)
      }
      Text(status.message)
        .font(.caption)
        .foregroundStyle(.secondary)
        .monospacedDigit()
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.top, 4)
  }

  /// Shown on the platform card when the last sign-in could not get a browser, with a retry.
  func signInBrowserFailure(
    _ status: SignInBrowserStatus,
    retry: @escaping () -> Void
  ) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.orange)
        .padding(.top, 2)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        Text("The sign-in window could not open")
          .font(.subheadline.weight(.semibold))
        Text(status.message)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
      }
      Spacer(minLength: 12)
      actionButton(title: "Try again", action: retry)
    }
    .padding(12)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(Color.orange.opacity(0.08))
    )
    .padding(.leading, 40)
  }
}
