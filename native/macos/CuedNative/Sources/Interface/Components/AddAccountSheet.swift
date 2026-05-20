import AppKit
import Combine
import SwiftUI

struct AddAccountSheet: View {
  let platform: String
  let platformTitle: String
  let suggestedAccountKey: String
  let onCancel: () -> Void
  let onConnect: (String) -> Void

  @State private var accountKey: String

  init(
    platform: String,
    platformTitle: String,
    suggestedAccountKey: String,
    onCancel: @escaping () -> Void,
    onConnect: @escaping (String) -> Void
  ) {
    self.platform = platform
    self.platformTitle = platformTitle
    self.suggestedAccountKey = suggestedAccountKey
    self.onCancel = onCancel
    self.onConnect = onConnect
    _accountKey = State(initialValue: suggestedAccountKey)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Add \(platformTitle) \(accountNoun(for: platform))")
        .font(.title2.weight(.semibold))

      Text("Choose a stable account key. For Slack, a workspace slug or team ID works well.")
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      VStack(alignment: .leading, spacing: 6) {
        Text("Account key")
          .font(.subheadline.weight(.medium))
        TextField("Account key", text: $accountKey)
          .textFieldStyle(.roundedBorder)
      }

      HStack {
        Spacer(minLength: 0)
        Button("Cancel", action: onCancel)
          .buttonStyle(
            PermissionActionButtonStyle(
              variant: .secondary,
              size: .regular
            )
          )
        Button("Connect") {
          let trimmed = accountKey.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !trimmed.isEmpty else {
            return
          }
          onConnect(trimmed)
        }
        .buttonStyle(
          PermissionActionButtonStyle(
            variant: .prominent,
            size: .regular
          )
        )
        .disabled(accountKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(24)
    .frame(width: 420)
  }
}
