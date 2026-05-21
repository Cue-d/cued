import AppKit
import Combine
import SwiftUI

extension RootView {
  var platformsPage: some View {
    pageContainer {
      Text("Sources")
        .font(.largeTitle.weight(.semibold))

      Text("Choose what Cued keeps current. Indexed history stays local on this Mac.")
        .font(.body)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 540)

      card {
        if viewModel.platformConfigurations.isEmpty {
          VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
              Image(systemName: viewModel.hasLoadedSnapshot ? "sparkle.magnifyingglass" : "arrow.triangle.2.circlepath")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 26)
              VStack(alignment: .leading, spacing: 4) {
                Text(viewModel.hasLoadedSnapshot ? "No sources are available yet" : "Loading local sources")
                  .font(.headline)
                Text(
                  viewModel.hasLoadedSnapshot
                    ? "Sources appear here as soon as the daemon reports supported integrations for this Mac."
                    : "Reading the local Cued snapshot from this Mac."
                )
                  .font(.subheadline)
                  .foregroundStyle(.secondary)
              }
            }
          }
        } else {
          ForEach(Array(viewModel.platformConfigurations.enumerated()), id: \.element.id) { index, configuration in
            platformCard(configuration)
            if index < viewModel.platformConfigurations.count - 1 {
              Divider()
            }
          }
        }
      }
    }
  }

}
