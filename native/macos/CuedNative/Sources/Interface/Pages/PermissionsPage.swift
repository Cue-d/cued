import AppKit
import Combine
import SwiftUI

extension RootView {
  var permissionsPage: some View {
    pageContainer {
      Text("Permissions")
        .font(.largeTitle.weight(.semibold))

      Text("Cued needs these permissions to sync your data in the background into a local database.")
        .font(.body)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 540)

      HStack(alignment: .top, spacing: 6) {
        Image(systemName: "bolt.badge.automatic.fill")
          .font(.caption)
          .foregroundStyle(.tertiary)
        Text("CLI access and background launch are configured automatically.")
          .font(.caption)
          .foregroundStyle(.tertiary)
      }
      .padding(.top, 2)

      VStack(spacing: 12) {
        ForEach(viewModel.permissionStatuses) { permission in
          permissionRow(permission)
        }
        skillRow
      }
    }
  }



}
