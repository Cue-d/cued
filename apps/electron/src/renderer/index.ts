// Renderer process entry point
export {}

declare global {
  interface Window {
    electron: {
      versions: {
        node: () => string
        chrome: () => string
        electron: () => string
      }
    }
  }
}

// Display version information
const versionsDiv = document.getElementById('versions')
if (versionsDiv && window.electron) {
  versionsDiv.innerHTML = `
    <p><strong>Electron:</strong> ${window.electron.versions.electron()}</p>
    <p><strong>Chrome:</strong> ${window.electron.versions.chrome()}</p>
    <p><strong>Node:</strong> ${window.electron.versions.node()}</p>
  `
}
