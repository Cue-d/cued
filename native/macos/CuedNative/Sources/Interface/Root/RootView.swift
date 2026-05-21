import AppKit
import Combine
import SwiftUI

private let onboardingLastPageUserDefaultsKey = "so.cued.onboarding.lastPage"

public func savedOnboardingPage(maxPage: Int) -> Int {
  let saved = UserDefaults.standard.integer(forKey: onboardingLastPageUserDefaultsKey)
  return min(max(saved, 0), max(0, maxPage))
}

public func saveOnboardingPage(_ page: Int) {
  UserDefaults.standard.set(max(0, page), forKey: onboardingLastPageUserDefaultsKey)
}

public struct RootView: View {
  @ObservedObject var viewModel: RootViewModel

  let onRefresh: () -> Void
  let onGuidePermission: (String) -> Void
  let onDismissPermissionGuide: () -> Void
  let onRequestPermission: ([String]) -> Void
  let onInstallGlobalSkill: () -> Void
  let onEnableIntegration: (String, String) -> Void
  let onRemoveIntegration: (String, String) -> Void
  let onConnectIntegration: (String, String) -> Void
  let onLaunchAgentExample: (AgentExampleID, AgentTarget) -> Void
  let onFinish: () -> Void

  @State var addAccountPrompt: AddAccountPrompt?
  @State var removalPrompt: RemovalPrompt?
  @State var pendingGlobalSkillInstall = false
  @State var pendingIntegrationActionIDs = Set<String>()
  @State var pendingRemovedIntegrationIDs = Set<String>()
  @State var activePermissionGuideKey: String?

  public init(
    viewModel: RootViewModel,
    onRefresh: @escaping () -> Void,
    onGuidePermission: @escaping (String) -> Void,
    onDismissPermissionGuide: @escaping () -> Void,
    onRequestPermission: @escaping ([String]) -> Void,
    onInstallGlobalSkill: @escaping () -> Void,
    onEnableIntegration: @escaping (String, String) -> Void,
    onRemoveIntegration: @escaping (String, String) -> Void,
    onConnectIntegration: @escaping (String, String) -> Void,
    onLaunchAgentExample: @escaping (AgentExampleID, AgentTarget) -> Void,
    onFinish: @escaping () -> Void
  ) {
    self.viewModel = viewModel
    self.onRefresh = onRefresh
    self.onGuidePermission = onGuidePermission
    self.onDismissPermissionGuide = onDismissPermissionGuide
    self.onRequestPermission = onRequestPermission
    self.onInstallGlobalSkill = onInstallGlobalSkill
    self.onEnableIntegration = onEnableIntegration
    self.onRemoveIntegration = onRemoveIntegration
    self.onConnectIntegration = onConnectIntegration
    self.onLaunchAgentExample = onLaunchAgentExample
    self.onFinish = onFinish
  }

  public var body: some View {
    VStack(spacing: 0) {
      GeometryReader { geo in
        HStack(spacing: 0) {
          ForEach(0..<viewModel.pageCount, id: \.self) { pageIndex in
            page(for: pageIndex)
              .frame(width: viewModel.pageWidth, height: geo.size.height)
          }
        }
        .offset(x: CGFloat(-viewModel.currentPage) * viewModel.pageWidth)
        .animation(
          .interactiveSpring(response: 0.5, dampingFraction: 0.86, blendDuration: 0.25),
          value: viewModel.currentPage
        )
        .clipped()
      }

      navigationFooter
    }
    .frame(width: viewModel.pageWidth, height: RootViewModel.windowHeight)
    .background(Color(NSColor.windowBackgroundColor))
    .onAppear {
      if viewModel.currentPage >= viewModel.pageCount {
        viewModel.currentPage = 0
      }
      onRefresh()
    }
    .onReceive(
      NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)
        .debounce(for: .milliseconds(250), scheduler: RunLoop.main)
    ) { _ in
      onRefresh()
    }
    .onChange(of: viewModel.refreshSequence) { _ in
      pendingGlobalSkillInstall = false
      prunePendingIntegrationActions()
      if shouldDismissPermissionGuide(
        activePermissionKey: activePermissionGuideKey,
        permissions: viewModel.permissionStatuses
      ) {
        activePermissionGuideKey = nil
        onDismissPermissionGuide()
      }
    }
    .onChange(of: viewModel.currentPage) { page in
      saveOnboardingPage(page)
      guard rootPage(for: page) != .permissions else {
        return
      }
      activePermissionGuideKey = nil
      onDismissPermissionGuide()
    }
    .onChange(of: platformRefreshSignature) { _ in
      pendingIntegrationActionIDs.removeAll()
      pendingRemovedIntegrationIDs.removeAll()
    }
    .sheet(item: $addAccountPrompt) { prompt in
      AddAccountSheet(
        platform: prompt.platform,
        platformTitle: prompt.platformTitle,
        suggestedAccountKey: prompt.suggestedAccountKey,
        onCancel: { addAccountPrompt = nil },
        onConnect: { accountKey in
          addAccountPrompt = nil
          onConnectIntegration(prompt.platform, accountKey)
        }
      )
    }
    .alert(item: $removalPrompt) { prompt in
      Alert(
        title: SwiftUI.Text("Remove \(prompt.accountTitle)?"),
        message: SwiftUI.Text("This deletes the saved \(prompt.platformTitle) connection from this Mac."),
        primaryButton: .destructive(SwiftUI.Text("Remove")) {
          pendingIntegrationActionIDs.insert(prompt.id)
          pendingRemovedIntegrationIDs.insert(prompt.id)
          onRemoveIntegration(prompt.platform, prompt.accountKey)
        },
        secondaryButton: .cancel()
      )
    }
  }

  func prunePendingIntegrationActions() {
    let activePendingIDs = Set(
      viewModel.platformConfigurations.flatMap { configuration in
        visibleKnownAccounts(for: configuration).compactMap { integration in
          integration.authState == "requested" || integration.authState == "in_progress"
            ? integration.id
            : nil
        }
      }
    )
    pendingIntegrationActionIDs.formIntersection(activePendingIDs)
  }

  var platformRefreshSignature: [String] {
    viewModel.platformConfigurations.flatMap { configuration in
      configuration.knownAccounts.map { integration in
        "\(integration.id):\(integration.authState):\(integration.enabled)"
      }
    }
  }

  @ViewBuilder
  func page(for pageIndex: Int) -> some View {
    switch rootPage(for: pageIndex) {
    case .welcome:
      welcomePage
    case .permissions:
      permissionsPage
    case .platforms:
      platformsPage
    case .useCases:
      useCasesPage
    case .application:
      applicationPage
    }
  }

  var navigationFooter: some View {
    HStack(spacing: 20) {
      ZStack(alignment: .leading) {
        Button(action: {}, label: {
          Label("Back", systemImage: "chevron.left").labelStyle(.iconOnly)
        })
        .buttonStyle(
          PermissionActionButtonStyle(
            variant: .secondary,
            size: .icon
          )
        )
        .opacity(0)
        .disabled(true)

        if viewModel.canGoBack {
          Button {
            withAnimation {
              viewModel.currentPage = max(0, viewModel.currentPage - 1)
            }
          } label: {
            Label("Back", systemImage: "chevron.left").labelStyle(.iconOnly)
          }
          .buttonStyle(
            PermissionActionButtonStyle(
              variant: .secondary,
              size: .icon
            )
          )
          .foregroundStyle(.secondary)
          .opacity(0.8)
          .transition(.opacity.combined(with: .scale(scale: 0.9)))
        }
      }
      .frame(minWidth: 80, alignment: .leading)

      Spacer()

      VStack(spacing: 8) {
        Text(viewModel.currentPageTitle)
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)

        HStack(spacing: 7) {
          ForEach(0..<viewModel.pageCount, id: \.self) { index in
            Button {
              withAnimation {
                viewModel.currentPage = index
              }
            } label: {
              Capsule(style: .continuous)
                .fill(index == viewModel.currentPage ? Color.accentColor : Color.gray.opacity(0.28))
                .frame(width: index == viewModel.currentPage ? 18 : 7, height: 7)
            }
            .buttonStyle(.plain)
            .help(rootPage(for: index).title)
          }
        }
      }

      Spacer()

      Button(action: handleNext) {
        Text(viewModel.buttonTitle)
      }
      .keyboardShortcut(.return)
      .buttonStyle(
        PermissionActionButtonStyle(
          variant: viewModel.buttonTitle == "Skip for now" ? .secondary : .prominent,
          size: .regular
        )
      )
    }
    .padding(.horizontal, 28)
    .padding(.top, 10)
    .padding(.bottom, 13)
    .frame(minHeight: 68, alignment: .bottom)
  }

  func handleNext() {
    if viewModel.currentPage == viewModel.pageCount - 1 {
      onFinish()
      return
    }
    withAnimation {
      viewModel.currentPage += 1
    }
  }

  func pageContainer(@ViewBuilder _ content: () -> some View) -> some View {
    ScrollView {
      VStack(spacing: 16) {
        content()
        Spacer(minLength: 0)
      }
      .frame(maxWidth: .infinity, alignment: .top)
      .padding(.top, 24)
      .padding(.bottom, 88)
    }
    .scrollIndicators(.never)
    .padding(.horizontal, 28)
    .frame(width: viewModel.pageWidth, alignment: .top)
  }

  func card(
    spacing: CGFloat = 12,
    padding: CGFloat = 16,
    @ViewBuilder _ content: () -> some View
  ) -> some View {
    VStack(alignment: .leading, spacing: spacing) {
      content()
    }
    .padding(padding)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(Color(NSColor.controlBackgroundColor))
        .shadow(color: .black.opacity(0.06), radius: 8, y: 3)
    )
  }
}
