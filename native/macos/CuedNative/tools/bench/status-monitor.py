#!/usr/bin/env python3
"""Compare real native filesystem monitors and timer callbacks in isolation.

Usage: status-monitor.py BEFORE_REPO AFTER_REPO [SECONDS=16]
This does not run the app or access user data. Callback counts measure scheduling
work, not energy use or the cost of database queries/menu construction.
"""
import pathlib
import re
import subprocess
import sys
import tempfile

seconds = float(sys.argv[3]) if len(sys.argv) > 3 else 16
for label, root in zip(("before", "after"), sys.argv[1:3]):
    source = (pathlib.Path(root) / "native/macos/CuedNative/Sources/CuedNative/AppRuntime.swift").read_text()
    name = "DatabaseActivityMonitor" if "class DatabaseActivityMonitor:" in source else "StatusFileMonitor"
    start = source.index("class " + name + ":")
    start = source.rfind("\n", 0, start) + 1
    end = source.index("\nprivate func isConnectedIntegrationState", start)
    monitor = source[start:end].replace("private final class", "final class")
    interval = re.search(r"Timer.scheduledTimer\(timeInterval: (\d+), target: self", source).group(1)
    ctor = f'{name}(dbPath: db.path)' if name == "DatabaseActivityMonitor" else f'{name}(path: status.path)'
    harness = '''
@main struct Bench {
  @MainActor static func main() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let db = directory.appendingPathComponent("local.db")
    let wal = directory.appendingPathComponent("local.db-wal")
    let status = directory.appendingPathComponent("menu-bar-status.json")
    for path in [db, wal, status] { try Data("initial".utf8).write(to: path) }
    var fileCallbacks = 0
    var timerCallbacks = 0
    let monitor = CTOR { fileCallbacks += 1 }
    monitor.start()
    let timer = Timer.scheduledTimer(withTimeInterval: INTERVAL, repeats: true) { _ in
      MainActor.assumeIsolated { timerCallbacks += 1 }
    }
    // No source changes: the old app rebuilt its menu on every timer tick.
    RunLoop.main.run(until: Date().addingTimeInterval(SECONDS))
    print("idle timer_callbacks=\\(timerCallbacks) file_callbacks=\\(fileCallbacks)")
    timer.invalidate()
    fileCallbacks = 0
    // One isolated WAL append per 250ms, but only one published snapshot/sec.
    // This represents projection writes between the daemon's UI publications.
    var writes = 0
    let writer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
      MainActor.assumeIsolated {
        writes += 1
        try! Data("wal-\\(writes)".utf8).write(to: wal)
        if writes % 4 == 0 { try! Data("snapshot-\\(writes)".utf8).write(to: status, options: .atomic) }
      }
    }
    RunLoop.main.run(until: Date().addingTimeInterval(SECONDS))
    writer.invalidate()
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    monitor.stop()
    print("projection writes=\\(writes) file_callbacks=\\(fileCallbacks)")
  }
}
'''.replace("CTOR", ctor).replace("INTERVAL", interval).replace("SECONDS", str(seconds))
    with tempfile.TemporaryDirectory(prefix="cued-native-bench-") as directory:
        swift = pathlib.Path(directory) / "bench.swift"
        binary = pathlib.Path(directory) / "bench"
        swift.write_text("import Foundation\nimport Darwin\n" + monitor + harness)
        subprocess.run(["swiftc", "-parse-as-library", "-O", str(swift), "-o", str(binary)], check=True)
        print(label, flush=True)
        subprocess.run([str(binary)], check=True)
