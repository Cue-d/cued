import AppKit
import Combine
import SwiftUI

extension RootView {
  func platformCard(_ configuration: PlatformConfig) -> some View {
    let isFullyConnected = isPlatformComplete(configuration)
    let shouldShowAccountControls = showsAccountRows(for: configuration)
    let shouldDimCard = isFullyConnected && !shouldShowAccountControls

    return VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 12) {
        PlatformIcon(platform: configuration.platform)

        VStack(alignment: .leading, spacing: 5) {
          Text(configuration.title)
            .font(.headline)
            .foregroundStyle(isFullyConnected ? .secondary : .primary)
          Text(platformDescription(for: configuration))
            .font(.subheadline)
            .foregroundStyle(isFullyConnected ? .tertiary : .secondary)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
        }

        Spacer(minLength: 12)

        if configuration.needsPermission {
          attentionBadge(title: "Needs access")
        } else if isFullyConnected {
          Image(systemName: "checkmark.circle.fill")
            .font(.title3.weight(.semibold))
            .foregroundStyle(.green)
            .accessibilityLabel("\(configuration.title) connected")
        } else if !shouldShowAccountControls && visibleKnownAccounts(for: configuration).contains(where: {
          pendingIntegrationActionIDs.contains($0.id)
        }) {
          ProgressView()
            .controlSize(.small)
            .padding(.top, 10)
        } else if !shouldShowAccountControls, let action = platformLevelAction(for: configuration) {
          actionButton(title: action.title, action: action.handler)
        }
      }

      if shouldShowAccountControls {
        if configuration.supportsMultipleAccounts {
          multiAccountRows(configuration)
        } else if let integration = configuration.accounts.first ?? configuration.placeholder {
          accountRow(configuration, integration: integration)
        }
      }
    }
    .padding(.vertical, 2)
    .opacity(shouldDimCard ? 0.7 : 1.0)
  }

  func showsAccountRows(for configuration: PlatformConfig) -> Bool {
    if configuration.supportsMultipleAccounts {
      return !visibleAccounts(for: configuration).isEmpty
    }

    guard let integration = visibleAccounts(for: configuration).first else {
      return false
    }

    if isConnectedAuthState(integration.authState) {
      return true
    }

    return integration.authState == "requested"
      || integration.authState == "in_progress"
      || integration.authState == "blocked"
      || integration.authState == "check_failed"
  }

  func visibleAccounts(for configuration: PlatformConfig) -> [IntegrationStatus] {
    configuration.accounts.filter { !pendingRemovedIntegrationIDs.contains($0.id) }
  }

  func visibleKnownAccounts(for configuration: PlatformConfig) -> [IntegrationStatus] {
    let accounts = visibleAccounts(for: configuration)
    if accounts.isEmpty, let placeholder = configuration.placeholder,
       !pendingRemovedIntegrationIDs.contains(placeholder.id) {
      return [placeholder]
    }
    return accounts
  }

  func multiAccountRows(_ configuration: PlatformConfig) -> some View {
    let accounts = visibleAccounts(for: configuration)
    return VStack(alignment: .leading, spacing: 10) {
      if !accounts.isEmpty {
        ForEach(Array(accounts.enumerated()), id: \.element.id) { index, integration in
          accountRow(configuration, integration: integration)
          if index < accounts.count - 1 {
            Divider()
          }
        }
      }

      if let action = platformLevelAction(for: configuration) {
        HStack {
          Spacer(minLength: 0)
          actionButton(title: action.title, prominent: false, action: action.handler)
        }
      }
    }
  }

  func accountRow(
    _ configuration: PlatformConfig,
    integration: IntegrationStatus
  ) -> some View {
    let action = primaryAccountAction(for: configuration, integration: integration)
    let removeAccountAction = removeAccountAction(for: configuration, integration: integration)
    let isPending = pendingIntegrationActionIDs.contains(integration.id)

    return HStack(alignment: .top, spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        Text(accountTitle(for: configuration, integration: integration))
          .font(.subheadline.weight(.semibold))
        Text(accountDetail(for: configuration, integration: integration))
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
      }

      Spacer(minLength: 12)

      if isPending {
        pendingIndicator()
          .padding(.top, 3)
      }
      if let removeAccountAction {
        actionButton(title: removeAccountAction.title, action: removeAccountAction.handler)
      }
      if let action {
        actionButton(title: action.title, action: action.handler)
      }
    }
    .padding(.leading, 40)
  }

  func actionButton(
    title: String,
    prominent: Bool = false,
    action: @escaping () -> Void
  ) -> some View {
    Group {
      if prominent {
        Button(title, action: action)
          .buttonStyle(
            PermissionActionButtonStyle(
              variant: .prominent,
              size: .regular
            )
          )
      } else {
        Button(title, action: action)
          .buttonStyle(
            PermissionActionButtonStyle(
              variant: .secondary,
              size: .regular
            )
          )
      }
    }
  }

  func pendingIndicator() -> some View {
    ProgressView()
      .controlSize(.small)
      .frame(width: 24, height: 24, alignment: .center)
  }

  func primaryAccountAction(
    for configuration: PlatformConfig,
    integration: IntegrationStatus
  ) -> (title: String, handler: () -> Void)? {
    if configuration.capability.availability == "unsupported" || configuration.capability.availability == "requires_helper" {
      return nil
    }
    if configuration.needsPermission {
      return (
        "Open permissions",
        {
          withAnimation {
            viewModel.currentPage = RootPage.permissions.rawValue
          }
        }
      )
    }
    guard configuration.isRequestable else {
      return nil
    }

    let isConnected = isConnectedAuthState(integration.authState)
    if !integration.enabled && isConnected {
      return (
        "Turn on",
        {
          pendingIntegrationActionIDs.insert(integration.id)
          onEnableIntegration(configuration.platform, integration.accountKey)
        }
      )
    }
    if isConnected {
      return nil
    }
    if integration.authState == "requested" || integration.authState == "in_progress" {
      return nil
    }

    let title =
      integration.authState == "failed"
        || needsAuthAttention(configuration.platform, authState: integration.authState)
        ? "Connect again"
        : "Connect"
    return (
      title,
      {
        pendingIntegrationActionIDs.insert(integration.id)
        onConnectIntegration(configuration.platform, integration.accountKey)
      }
    )
  }

  func removeAccountAction(
    for configuration: PlatformConfig,
    integration: IntegrationStatus
  ) -> (title: String, handler: () -> Void)? {
    guard configuration.accounts.contains(where: {
      $0.platform == integration.platform && $0.accountKey == integration.accountKey
    }) else {
      return nil
    }

    guard configuration.isRequestable else {
      return nil
    }

    if integration.authState == "requested" || integration.authState == "in_progress" {
      return (
        "Cancel",
        {
          pendingIntegrationActionIDs.insert(integration.id)
          pendingRemovedIntegrationIDs.insert(integration.id)
          onRemoveIntegration(configuration.platform, integration.accountKey)
        }
      )
    }

    return (
      "Remove",
      {
        removalPrompt = RemovalPrompt(
          platform: configuration.platform,
          platformTitle: configuration.title,
          accountKey: integration.accountKey,
          accountTitle: accountTitle(for: configuration, integration: integration)
        )
      }
    )
  }

  func platformLevelAction(
    for configuration: PlatformConfig
  ) -> (title: String, handler: () -> Void)? {
    if configuration.capability.availability == "unsupported" || configuration.capability.availability == "requires_helper" {
      return nil
    }
    if configuration.needsPermission {
      return (
        "Open permissions",
        {
          withAnimation {
            viewModel.currentPage = RootPage.permissions.rawValue
          }
        }
      )
    }
    guard configuration.isConnectable else {
      return nil
    }

    if configuration.supportsMultipleAccounts {
      let noun = accountNoun(for: configuration.platform)
      let title = visibleAccounts(for: configuration).isEmpty && supportsAutomaticAccountDiscovery(configuration.platform)
        ? "Connect"
        : "Add \(noun)"
      return (
        title,
        {
          if supportsAutomaticAccountDiscovery(configuration.platform) {
            onConnectIntegration(
              configuration.platform,
              viewModel.suggestedAccountKey(for: configuration.platform)
            )
          } else {
            addAccountPrompt = AddAccountPrompt(
              platform: configuration.platform,
              platformTitle: configuration.title,
              suggestedAccountKey: viewModel.suggestedAccountKey(for: configuration.platform)
            )
          }
        }
      )
    }

    if let integration = configuration.placeholder ?? configuration.accounts.first {
      let isConnected = isConnectedAuthState(integration.authState)
      if !integration.enabled && isConnected {
        return (
          "Turn on",
          {
            pendingIntegrationActionIDs.insert(integration.id)
            onEnableIntegration(configuration.platform, integration.accountKey)
          }
        )
      }
      return (
        isConnected ? "Connect again" : "Connect",
        {
          pendingIntegrationActionIDs.insert(integration.id)
          onConnectIntegration(configuration.platform, integration.accountKey)
        }
      )
    }

    return nil
  }

  func accountTitle(
    for configuration: PlatformConfig,
    integration: IntegrationStatus
  ) -> String {
    if hidesAccountKey(platform: integration.platform, accountKey: integration.accountKey) {
      return fallbackAccountTitle(for: configuration.platform, authState: integration.authState)
    }

    let title = integration.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let title, !title.isEmpty {
      return title
    }
    if !hidesAccountKey(platform: integration.platform, accountKey: integration.accountKey) {
      return integration.accountKey
    }
    return fallbackAccountTitle(for: configuration.platform, authState: integration.authState)
  }

  func accountDetail(
    for configuration: PlatformConfig,
    integration: IntegrationStatus
  ) -> String {
    var parts = [readableAuthState(configuration.platform, integration.authState)]
    if let dataSummary = dataSummary(integration) {
      parts.append(dataSummary)
    }
    if !integration.enabled && isConnectedAuthState(integration.authState) {
      parts.append("turned off")
    }
    if configuration.needsPermission {
      parts[0] = "Needs Full Disk Access"
    }
    if normalizedTitle(accountTitle(for: configuration, integration: integration))
      != normalizedTitle(integration.accountKey),
       !hidesAccountKey(platform: integration.platform, accountKey: integration.accountKey) {
      parts.append(integration.accountKey)
    }
    return parts.joined(separator: " • ")
  }

  func dataSummary(_ integration: IntegrationStatus) -> String? {
    guard let stats = integration.projectionStats else {
      return nil
    }
    if !isConnectedAuthState(integration.authState) && integration.platform != "whatsapp" {
      return nil
    }

    if stats.projectedMessages > 0 {
      return "\(formatCount(stats.projectedMessages)) messages indexed"
    }
    if stats.projectedContacts > 0 {
      return "\(formatCount(stats.projectedContacts)) contacts indexed"
    }

    let projectedItems =
      stats.projectedContacts + stats.projectedConversations + stats.projectedMessages
    if stats.rawEvents > 0 && projectedItems == 0 {
      return "\(formatCount(stats.rawEvents)) items captured, indexing"
    }
    return nil
  }

  func isPlatformComplete(_ configuration: PlatformConfig) -> Bool {
    if configuration.needsPermission {
      return false
    }
    if configuration.platform == "phone_calls" {
      return true
    }
    let accounts = visibleAccounts(for: configuration)
    if accounts.isEmpty {
      return false
    }
    return accounts.allSatisfy { showsCompletionCheckmark(for: configuration, integration: $0) }
  }

  func attentionBadge(title: String) -> some View {
    Text(title)
      .font(.caption.weight(.semibold))
      .foregroundStyle(.orange)
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .background(
        Capsule(style: .continuous)
          .fill(Color.orange.opacity(0.13))
      )
  }
}
