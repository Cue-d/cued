import Foundation

/// Reports writes to a SQLite database that another process owns.
///
/// A database in WAL mode takes new rows in its `-wal` file, and a vnode source on the
/// directory only sees entries being added, removed or renamed. So each of the database file,
/// its `-wal` and its `-shm` has a source of its own, and the directory's source re-arms them:
/// a checkpoint can delete the WAL, the writer recreates it, and the database file can be
/// replaced by a rename. A file source that reports delete, rename or revoke is re-armed too.
///
/// Changes are coalesced: the first one is reported at once, and any that follow within
/// `coalesceInterval` are reported once when it ends. All work runs on `queue`.
final class SQLiteChangeWatcher: @unchecked Sendable {
  static let fileSuffixes = ["", "-wal", "-shm"]

  private struct WatchedFile {
    let source: DispatchSourceFileSystemObject
    let device: dev_t
    let inode: ino_t
  }

  let directoryPath: String
  let filePaths: [String]
  private let queue: DispatchQueue
  private let coalesceInterval: DispatchTimeInterval
  private let onChange: @Sendable () -> Void
  private let onDirectoryLost: @Sendable () -> Void
  private var directorySource: DispatchSourceFileSystemObject?
  private var fileSources: [String: WatchedFile] = [:]
  private var running = false
  private var coalescing = false
  private var changedWhileCoalescing = false

  init(
    databasePath: String,
    queue: DispatchQueue,
    coalesceInterval: DispatchTimeInterval = .milliseconds(250),
    onChange: @escaping @Sendable () -> Void,
    onDirectoryLost: @escaping @Sendable () -> Void
  ) {
    let url = URL(fileURLWithPath: databasePath)
    directoryPath = url.deletingLastPathComponent().path
    filePaths = Self.fileSuffixes.map { url.path + $0 }
    self.queue = queue
    self.coalesceInterval = coalesceInterval
    self.onChange = onChange
    self.onDirectoryLost = onDirectoryLost
  }

  /// Files that currently have a source, for tests and diagnostics.
  var watchedFilePaths: Set<String> {
    dispatchPrecondition(condition: .onQueue(queue))
    return Set(fileSources.keys)
  }

  /// Starts watching. Call on `queue`; returns false when the directory cannot be opened.
  func start() -> Bool {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !running else { return true }
    let fd = open(directoryPath, O_EVTONLY)
    guard fd >= 0 else { return false }
    let source = DispatchSource.makeFileSystemObjectSource(
      fileDescriptor: fd,
      eventMask: [.write, .delete, .rename, .revoke],
      queue: queue
    )
    source.setEventHandler { [weak self, weak source] in
      guard let self, let source else { return }
      self.handleDirectoryEvent(source.data)
    }
    source.setCancelHandler { close(fd) }
    directorySource = source
    running = true
    source.resume()
    for path in filePaths {
      _ = rearm(path)
    }
    return true
  }

  func stop() {
    dispatchPrecondition(condition: .onQueue(queue))
    running = false
    directorySource?.cancel()
    directorySource = nil
    for file in fileSources.values {
      file.source.cancel()
    }
    fileSources.removeAll()
  }

  private func handleDirectoryEvent(_ event: DispatchSource.FileSystemEvent) {
    guard running else { return }
    if !event.isDisjoint(with: [.delete, .rename, .revoke]) {
      stop()
      onDirectoryLost()
      return
    }
    // Other entries in the directory come and go too; only a database file being created,
    // replaced or removed counts as a change.
    var changed = false
    for path in filePaths where rearm(path) {
      changed = true
    }
    if changed {
      noteChange()
    }
  }

  private func handleFileEvent(path: String, event: DispatchSource.FileSystemEvent) {
    guard running else { return }
    if !event.isDisjoint(with: [.delete, .rename, .revoke]) {
      fileSources.removeValue(forKey: path)?.source.cancel()
      _ = rearm(path)
    }
    noteChange()
  }

  /// Points the source for `path` at the file now at that path. Returns whether that changed
  /// which file (if any) is watched.
  private func rearm(_ path: String) -> Bool {
    var status = stat()
    let exists = stat(path, &status) == 0
    if let current = fileSources[path] {
      if exists && current.device == status.st_dev && current.inode == status.st_ino {
        return false
      }
      current.source.cancel()
      fileSources.removeValue(forKey: path)
    } else if !exists {
      return false
    }
    guard exists else { return true }

    let fd = open(path, O_EVTONLY)
    guard fd >= 0 else { return true }
    // Identify the file by the descriptor, not the earlier stat, in case it was replaced since.
    guard fstat(fd, &status) == 0 else {
      close(fd)
      return true
    }
    let source = DispatchSource.makeFileSystemObjectSource(
      fileDescriptor: fd,
      eventMask: [.write, .extend, .delete, .rename, .revoke],
      queue: queue
    )
    source.setEventHandler { [weak self, weak source] in
      guard let self, let source else { return }
      self.handleFileEvent(path: path, event: source.data)
    }
    source.setCancelHandler { close(fd) }
    fileSources[path] = WatchedFile(source: source, device: status.st_dev, inode: status.st_ino)
    source.resume()
    return true
  }

  private func noteChange() {
    guard !coalescing else {
      changedWhileCoalescing = true
      return
    }
    coalescing = true
    onChange()
    queue.asyncAfter(deadline: .now() + coalesceInterval) { [weak self] in
      guard let self else { return }
      self.coalescing = false
      if self.changedWhileCoalescing && self.running {
        self.changedWhileCoalescing = false
        self.noteChange()
      }
    }
  }
}
