/** @type {import('@bacons/apple-targets').Config} */
module.exports = {
  type: "widget",
  name: "ActionCountWidget",
  displayName: "Cued Actions",
  // Widget bundle identifier appended to main app identifier
  bundleIdentifier: ".widget",
  // iOS 17+ for modern widget styling
  deploymentTarget: "17.0",
  frameworks: ["SwiftUI", "WidgetKit"],
  entitlements: {
    // App Group for sharing data between main app and widget
    "com.apple.security.application-groups": ["group.so.cued.app"],
  },
  colors: {
    // iOS system blue as accent color
    $accent: "#007AFF",
    // Widget background
    $widgetBackground: "#FFFFFF",
  },
};
