import AppKit
import Combine
import SwiftUI

public struct PlatformIcon: View {
  let platform: String

  public init(platform: String) {
    self.platform = platform
  }

  public var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(
          LinearGradient(
            colors: backgroundColors,
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .strokeBorder(Color.white.opacity(0.34), lineWidth: 0.75)

      if let image = platformImage() {
        Image(nsImage: image)
          .resizable()
          .interpolation(.high)
          .antialiased(true)
          .aspectRatio(contentMode: .fit)
          .padding(logoPadding)
      } else {
        fallbackIcon
      }
    }
    .frame(width: 40, height: 40)
  }

  private func platformImage() -> NSImage? {
    guard let assetName = platformIconAssetName(for: platform),
          let url = platformIconURL(named: assetName),
          let image = NSImage(contentsOf: url) else { return nil }
    return image
  }

  private var accentColor: Color {
    platformAccentColor(for: platform)
  }

  private var backgroundColors: [Color] {
    if platform == "gmail" {
      return [
        Color.white.opacity(0.98),
        Color(red: 0.94, green: 0.95, blue: 0.97),
      ]
    }
    return [
      accentColor.opacity(0.98),
      accentColor.opacity(0.78),
    ]
  }

  private var logoPadding: CGFloat {
    switch platform {
    case "slack":
      9
    case "gmail":
      6
    case "linkedin":
      5
    case "discord", "signal", "whatsapp":
      7
    default:
      7
    }
  }

  @ViewBuilder
  private var fallbackIcon: some View {
    switch platform {
    case "contacts":
      Image(systemName: "person.crop.circle.fill")
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(.white.opacity(0.96))
    case "phone_calls":
      Image(systemName: "phone.fill")
        .font(.system(size: 15, weight: .bold))
        .foregroundStyle(.white)
    case "imessage":
      Image(systemName: "message.fill")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(.white)
    case "gmail":
      Image(systemName: "envelope.fill")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Color(red: 0.26, green: 0.52, blue: 0.96))
    case "slack":
      Image(systemName: "number")
        .font(.system(size: 15, weight: .bold))
        .foregroundStyle(.white)
    case "linkedin":
      Text("in")
        .font(.system(size: 14, weight: .black, design: .rounded))
        .foregroundStyle(.white)
        .offset(y: 0.5)
    case "signal":
      ZStack {
        ZStack {
          Circle()
            .fill(.white.opacity(0.96))
            .frame(width: 12, height: 12)
          Circle()
            .fill(accentColor)
            .frame(width: 3, height: 3)
        }
      }
    case "whatsapp":
      Image(systemName: "phone.fill")
        .font(.system(size: 13, weight: .bold))
        .foregroundStyle(.white)
    default:
      Image(systemName: "link.circle.fill")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(.white)
    }
  }
}
