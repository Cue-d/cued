import AppKit
import Contacts
import Darwin
import Foundation
import Security
import SQLite3
import WebKit

private let appleEpochOffset = 978_307_200
nonisolated(unsafe) private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
private let defaultMessagesDBPath =
  FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent("Library/Messages/chat.db").path

struct ContactRecord: Encodable {
  let sourceId: String
  let displayName: String
  let company: String?
  let avatarUrl: String?
  let phoneNumbers: [String]
  let emails: [String]
}

struct IMessageHandle: Codable {
  let id: Int
  let identifier: String
  let service: String
}

struct IMessageChat: Codable {
  let id: Int
  let identifier: String
  let displayName: String?
  let isGroup: Bool
  let participants: [IMessageHandle]
}

struct IMessageReaction: Codable {
  let emoji: String
  let reactorIdentifier: String
  let isFromMe: Bool
  let timestamp: Int
}

struct IMessageAttachment: Codable {
  let guid: String
  let filename: String?
  let transferName: String?
  let mimeType: String?
  let uti: String?
  let totalBytes: Int?
  let isSticker: Bool
  let hideAttachment: Bool
  let ckRecordId: String?
}

struct IMessageMessage: Codable {
  let id: Int
  let guid: String
  let chatId: Int
  let itemType: Int?
  let text: String?
  let timestamp: Int
  let isFromMe: Bool
  let isRead: Bool
  let readAt: Int?
  let status: String
  let errorCode: Int
  let hasAttachments: Bool
  var attachments: [IMessageAttachment]
  let sender: IMessageHandle?
  var reactions: [IMessageReaction]
}

struct IMessageSyncBatch: Codable {
  let cursor: Int
  let fetchedCount: Int
  let chats: [IMessageChat]
  let messages: [IMessageMessage]
  let handles: [IMessageHandle]
}

struct IMessageDumpOptions {
  var dbPath: String = defaultMessagesDBPath
  var afterRowID = 0
  var limit = 500
}

struct IMessageWatchOptions {
  var dbPath: String = defaultMessagesDBPath
}

struct AuthOpenOptions {
  var platform = ""
  var accountKey = ""
  var sessionID = ""
  var dbPath = ""
}

struct AuthQROptions {
  var title = ""
  var subtitle = ""
  var uri = ""
}

struct WatchEvent: Encodable {
  let event: String
  let timestamp: Int
}

private struct MessageRow {
  let rowID: Int
  let guid: String
  let chatID: Int
  let itemType: Int
  let senderID: Int?
  let senderIdentifier: String?
  let senderService: String?
  let text: String?
  let attributedBody: Data?
  let unixDate: Int?
  let isFromMe: Bool
  let isSent: Bool
  let isDelivered: Bool
  let isRead: Bool
  let unixDateRead: Int?
  let errorCode: Int
  let hasAttachments: Bool
  let associatedMessageType: Int
}

private struct AttachmentRow {
  let messageID: Int
  let guid: String
  let filename: String?
  let transferName: String?
  let mimeType: String?
  let uti: String?
  let totalBytes: Int?
  let isSticker: Bool
  let hideAttachment: Bool
  let ckRecordID: String?
}

private struct ReactionRow {
  let targetGUID: String
  let associatedMessageType: Int
  let associatedMessageEmoji: String?
  let reactorIdentifier: String?
  let isFromMe: Bool
  let unixDate: Int?
}

enum CLIError: Error, LocalizedError {
  case invalidCommand
  case invalidOption(String)
  case contactsAccessDenied
  case sqlite(String)
  case browser(String)
  case auth(String)
  case imessageWatch(String)

  var errorDescription: String? {
    switch self {
    case .invalidCommand:
      return "usage: CuedNative contacts dump|status|watch | CuedNative imessage dump [--db-path PATH] [--after-rowid N] [--limit N] | CuedNative imessage watch [--db-path PATH] | CuedNative browser open --url URL | CuedNative browser close --url-prefix PREFIX | CuedNative auth open --platform PLATFORM --account-key KEY --session-id ID --db-path PATH | CuedNative auth qr --title TITLE --subtitle TEXT --uri URI | CuedNative --menu-bar"
    case .invalidOption(let message):
      return message
    case .contactsAccessDenied:
      return "contacts access denied"
    case .sqlite(let message):
      return message
    case .browser(let message):
      return message
    case .auth(let message):
      return message
    case .imessageWatch(let message):
      return message
    }
  }
}

struct BrowserCommandResult: Encodable {
  let ok: Bool
  let action: String
  let target: String
  let closedTabs: Int?
}

struct NativeAuthResult: Encodable {
  let sessionId: String
  let platform: String
  let accountKey: String
  let state: String
  let keychainService: String?
  let keychainAccount: String?
  let resultSummary: [String: String]?
  let errorSummary: String?
}

struct NativeQRResult: Encodable {
  let state: String
}

final class ContactsAccessState: @unchecked Sendable {
  var granted = false
}

final class SQLiteConnection {
  private var db: OpaquePointer?

  init(path: String) throws {
    if sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) != SQLITE_OK {
      let message = db.flatMap { String(cString: sqlite3_errmsg($0)) } ?? "unable to open sqlite database"
      if let db {
        sqlite3_close(db)
      }
      throw CLIError.sqlite(message)
    }
  }

  deinit {
    sqlite3_close(db)
  }

  func query<T>(
    sql: String,
    bind: ((OpaquePointer?) throws -> Void)? = nil,
    mapRow: (OpaquePointer?) throws -> T
  ) throws -> [T] {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
      throw CLIError.sqlite(errorMessage())
    }
    defer { sqlite3_finalize(statement) }

    try bind?(statement)

    var rows: [T] = []
    while true {
      let stepResult = sqlite3_step(statement)
      if stepResult == SQLITE_ROW {
        rows.append(try mapRow(statement))
        continue
      }

      if stepResult == SQLITE_DONE {
        return rows
      }

      throw CLIError.sqlite(errorMessage())
    }
  }

  private func errorMessage() -> String {
    guard let db else {
      return "sqlite error"
    }

    return String(cString: sqlite3_errmsg(db))
  }
}

@main
struct CuedNativeCLI {
  static func main() {
    do {
      try run()
    } catch {
      fputs("\((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)\n", stderr)
      Darwin.exit(1)
    }
  }

  @MainActor
  private static func run() throws {
    let arguments = Array(CommandLine.arguments.dropFirst())

    if arguments.isEmpty || arguments == ["--menu-bar"] {
      runMenuBarApp()
      return
    }

    guard arguments.count >= 2 else {
      throw CLIError.invalidCommand
    }

    switch (arguments[0], arguments[1]) {
    case ("contacts", "dump"):
      try writeJSON(dumpContacts())
    case ("contacts", "status"):
      try writeJSON(["status": contactsAuthorizationStatus()])
    case ("contacts", "watch"):
      try streamContactChanges()
    case ("imessage", "dump"):
      let options = try parseIMessageOptions(Array(arguments.dropFirst(2)))
      try writeJSON(dumpIMessage(options: options))
    case ("imessage", "watch"):
      let options = try parseIMessageWatchOptions(Array(arguments.dropFirst(2)))
      try streamIMessageChanges(options: options)
    case ("auth", "open"):
      let options = try parseAuthOpenOptions(Array(arguments.dropFirst(2)))
      try writeJSON(runManagedAuth(options: options))
    case ("auth", "qr"):
      let options = try parseAuthQROptions(Array(arguments.dropFirst(2)))
      try writeJSON(runAuthQRCode(options: options))
    case ("browser", "open"):
      let url = try parseBrowserOpenURL(Array(arguments.dropFirst(2)))
      try writeJSON(openBrowser(urlString: url))
    case ("browser", "close"):
      let prefix = try parseBrowserClosePrefix(Array(arguments.dropFirst(2)))
      try writeJSON(closeBrowserTabs(urlPrefix: prefix))
    default:
      throw CLIError.invalidCommand
    }
  }

  private static func writeJSON<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    let data = try encoder.encode(value)
    FileHandle.standardOutput.write(data)
  }

  private static func writeJSONLine<T: Encodable>(_ value: T) throws {
    try writeJSON(value)
    FileHandle.standardOutput.write(Data("\n".utf8))
  }

  private static func parseIMessageOptions(_ arguments: [String]) throws -> IMessageDumpOptions {
    var options = IMessageDumpOptions()
    var index = 0

    while index < arguments.count {
      switch arguments[index] {
      case "--db-path":
        index += 1
        guard index < arguments.count else {
          throw CLIError.invalidOption("--db-path requires a value")
        }
        options.dbPath = arguments[index]
      case "--after-rowid":
        index += 1
        guard index < arguments.count, let value = Int(arguments[index]) else {
          throw CLIError.invalidOption("--after-rowid requires an integer")
        }
        options.afterRowID = value
      case "--limit":
        index += 1
        guard index < arguments.count, let value = Int(arguments[index]) else {
          throw CLIError.invalidOption("--limit requires an integer")
        }
        options.limit = value
      default:
        throw CLIError.invalidOption("unknown option: \(arguments[index])")
      }
      index += 1
    }

    return options
  }

  private static func parseIMessageWatchOptions(_ arguments: [String]) throws -> IMessageWatchOptions {
    var options = IMessageWatchOptions()
    var index = 0

    while index < arguments.count {
      switch arguments[index] {
      case "--db-path":
        index += 1
        guard index < arguments.count else {
          throw CLIError.invalidOption("--db-path requires a value")
        }
        options.dbPath = arguments[index]
      default:
        throw CLIError.invalidOption("unknown option: \(arguments[index])")
      }
      index += 1
    }

    return options
  }

  private static func parseBrowserOpenURL(_ arguments: [String]) throws -> String {
    guard arguments.count >= 2, arguments[0] == "--url" else {
      throw CLIError.invalidOption("usage: CuedNative browser open --url URL")
    }

    return arguments[1]
  }

  private static func parseBrowserClosePrefix(_ arguments: [String]) throws -> String {
    guard arguments.count >= 2, arguments[0] == "--url-prefix" else {
      throw CLIError.invalidOption("usage: CuedNative browser close --url-prefix PREFIX")
    }

    return arguments[1]
  }

  private static func parseAuthOpenOptions(_ arguments: [String]) throws -> AuthOpenOptions {
    var options = AuthOpenOptions()
    var index = 0

    while index < arguments.count {
      switch arguments[index] {
      case "--platform":
        index += 1
        guard index < arguments.count else {
          throw CLIError.invalidOption("--platform requires a value")
        }
        options.platform = arguments[index]
      case "--account-key":
        index += 1
        guard index < arguments.count else {
          throw CLIError.invalidOption("--account-key requires a value")
        }
        options.accountKey = arguments[index]
      case "--session-id":
        index += 1
        guard index < arguments.count else {
          throw CLIError.invalidOption("--session-id requires a value")
        }
        options.sessionID = arguments[index]
      case "--db-path":
        index += 1
        guard index < arguments.count else {
          throw CLIError.invalidOption("--db-path requires a value")
        }
        options.dbPath = arguments[index]
      default:
        throw CLIError.invalidOption("unknown option: \(arguments[index])")
      }
      index += 1
    }

    guard !options.platform.isEmpty else {
      throw CLIError.invalidOption("--platform is required")
    }
    guard !options.accountKey.isEmpty else {
      throw CLIError.invalidOption("--account-key is required")
    }
    guard !options.sessionID.isEmpty else {
      throw CLIError.invalidOption("--session-id is required")
    }
    guard !options.dbPath.isEmpty else {
      throw CLIError.invalidOption("--db-path is required")
    }

    return options
  }

  private static func parseAuthQROptions(_ arguments: [String]) throws -> AuthQROptions {
    var options = AuthQROptions()
    var index = 0

    while index < arguments.count {
      switch arguments[index] {
      case "--title":
        index += 1
        guard index < arguments.count else {
          throw CLIError.invalidOption("--title requires a value")
        }
        options.title = arguments[index]
      case "--subtitle":
        index += 1
        guard index < arguments.count else {
          throw CLIError.invalidOption("--subtitle requires a value")
        }
        options.subtitle = arguments[index]
      case "--uri":
        index += 1
        guard index < arguments.count else {
          throw CLIError.invalidOption("--uri requires a value")
        }
        options.uri = arguments[index]
      default:
        throw CLIError.invalidOption("unknown option: \(arguments[index])")
      }
      index += 1
    }

    guard !options.title.isEmpty else {
      throw CLIError.invalidOption("--title is required")
    }
    guard !options.uri.isEmpty else {
      throw CLIError.invalidOption("--uri is required")
    }
    return options
  }

  private static func openBrowser(urlString: String) throws -> BrowserCommandResult {
    guard let url = URL(string: urlString) else {
      throw CLIError.browser("invalid browser URL: \(urlString)")
    }

    let opened = NSWorkspace.shared.open(url)
    if !opened {
      throw CLIError.browser("failed to open browser URL: \(urlString)")
    }

    return BrowserCommandResult(ok: true, action: "open", target: urlString, closedTabs: nil)
  }

  private static func closeBrowserTabs(urlPrefix: String) throws -> BrowserCommandResult {
    let scripts = [
      chromeStyleCloseScript(appName: "Google Chrome", urlPrefix: urlPrefix),
      chromeStyleCloseScript(appName: "Arc", urlPrefix: urlPrefix),
      chromeStyleCloseScript(appName: "Brave Browser", urlPrefix: urlPrefix),
      chromeStyleCloseScript(appName: "Microsoft Edge", urlPrefix: urlPrefix),
      safariCloseScript(urlPrefix: urlPrefix),
    ]

    var closedTabs = 0
    for script in scripts {
      closedTabs += try runAppleScript(script)
    }

    return BrowserCommandResult(ok: true, action: "close", target: urlPrefix, closedTabs: closedTabs)
  }

  private static func runAppleScript(_ source: String) throws -> Int {
    var error: NSDictionary?
    guard let script = NSAppleScript(source: source) else {
      throw CLIError.browser("failed to compile browser automation script")
    }

    let output = script.executeAndReturnError(&error)
    if let error {
      let message = error[NSAppleScript.errorMessage] as? String ?? "unknown AppleScript error"
      if message.contains("Application isn’t running") || message.contains("Application isn't running") {
        return 0
      }
      if message.contains("(-600)") {
        return 0
      }
      throw CLIError.browser(message)
    }

    if output.descriptorType == typeSInt32 || output.descriptorType == typeUInt32 {
      return Int(output.int32Value)
    }

    if let stringValue = output.stringValue, let parsed = Int(stringValue) {
      return parsed
    }

    return 0
  }

  private static func chromeStyleCloseScript(appName: String, urlPrefix: String) -> String {
    let escapedAppName = appName.replacingOccurrences(of: "\"", with: "\\\"")
    let escapedPrefix = appleScriptStringLiteral(urlPrefix)

    return """
    set closedCount to 0
    tell application "\(escapedAppName)"
      if not running then return 0
      repeat with w in windows
        set tabList to every tab of w
        repeat with i from (count of tabList) to 1 by -1
          set currentTab to item i of tabList
          try
            set tabURL to URL of currentTab
            if tabURL starts with "\(escapedPrefix)" then
              close currentTab
              set closedCount to closedCount + 1
            end if
          end try
        end repeat
      end repeat
    end tell
    return closedCount
    """
  }

  private static func safariCloseScript(urlPrefix: String) -> String {
    let escapedPrefix = appleScriptStringLiteral(urlPrefix)

    return """
    set closedCount to 0
    tell application "Safari"
      if not running then return 0
      repeat with w in windows
        set tabList to every tab of w
        repeat with i from (count of tabList) to 1 by -1
          set currentTab to item i of tabList
          try
            set tabURL to URL of currentTab
            if tabURL starts with "\(escapedPrefix)" then
              close currentTab
              set closedCount to closedCount + 1
            end if
          end try
        end repeat
      end repeat
    end tell
    return closedCount
    """
  }

  private static func appleScriptStringLiteral(_ value: String) -> String {
    value
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"")
  }

  @MainActor
  private static func runManagedAuth(options: AuthOpenOptions) throws -> NativeAuthResult {
    let coordinator = try ManagedAuthCoordinator(options: options)
    return try coordinator.run()
  }

  @MainActor
  private static func runAuthQRCode(options: AuthQROptions) throws -> NativeQRResult {
    let coordinator = QRCodeCoordinator(options: options)
    return coordinator.run()
  }

  private static func dumpContacts() throws -> [ContactRecord] {
    let store = CNContactStore()
    try ensureContactsAccess(store: store)

    let keysToFetch: [CNKeyDescriptor] = [
      CNContactIdentifierKey as CNKeyDescriptor,
      CNContactGivenNameKey as CNKeyDescriptor,
      CNContactMiddleNameKey as CNKeyDescriptor,
      CNContactFamilyNameKey as CNKeyDescriptor,
      CNContactNicknameKey as CNKeyDescriptor,
      CNContactOrganizationNameKey as CNKeyDescriptor,
      CNContactImageDataAvailableKey as CNKeyDescriptor,
      CNContactPhoneNumbersKey as CNKeyDescriptor,
      CNContactEmailAddressesKey as CNKeyDescriptor,
      CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
    ]

    let request = CNContactFetchRequest(keysToFetch: keysToFetch)
    request.sortOrder = .givenName

    var records: [ContactRecord] = []
    try store.enumerateContacts(with: request) { contact, _ in
      records.append(
        ContactRecord(
          sourceId: contact.identifier,
          displayName: preferredDisplayName(for: contact),
          company: nilIfEmpty(contact.organizationName),
          avatarUrl: contact.imageDataAvailable ? "addressbook://\(contact.identifier)" : nil,
          phoneNumbers: contact.phoneNumbers.map { $0.value.stringValue }.filter { !$0.isEmpty },
          emails: contact.emailAddresses.compactMap { labeledValue in
            let value = labeledValue.value as String
            return value.isEmpty ? nil : value
          }
        )
      )
    }

    return records
  }

  @MainActor
  private static func streamContactChanges() throws {
    let store = CNContactStore()
    try ensureContactsAccess(store: store)

    try writeJSONLine(WatchEvent(
      event: "ready",
      timestamp: Int(Date().timeIntervalSince1970 * 1000)
    ))

    let notificationCenter = NotificationCenter.default
    let observer = notificationCenter.addObserver(
      forName: .CNContactStoreDidChange,
      object: nil,
      queue: nil
    ) { _ in
      do {
        try writeJSONLine(WatchEvent(
          event: "contacts_changed",
          timestamp: Int(Date().timeIntervalSince1970 * 1000)
        ))
      } catch {
        fputs("\(error.localizedDescription)\n", stderr)
      }
    }

    defer {
      notificationCenter.removeObserver(observer)
    }

    RunLoop.main.run()
  }

  private static func contactsAuthorizationStatus() -> String {
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .authorized:
      return "authorized"
    case .notDetermined:
      return "not_determined"
    case .denied:
      return "denied"
    case .restricted:
      return "restricted"
    @unknown default:
      return "unknown"
    }
  }

  private static func dumpIMessage(options: IMessageDumpOptions) throws -> IMessageSyncBatch {
    let connection = try SQLiteConnection(path: options.dbPath)
    let messageRows = try fetchMessageRows(
      connection: connection,
      afterRowID: options.afterRowID,
      limit: options.limit
    )

    if messageRows.isEmpty {
      return IMessageSyncBatch(
        cursor: options.afterRowID,
        fetchedCount: 0,
        chats: [],
        messages: [],
        handles: []
      )
    }

    var messages = transformMessages(rows: messageRows)
    let attachments = try fetchAttachments(
      connection: connection,
      messageIDs: messages.map(\.id)
    )
    for index in messages.indices {
      messages[index].attachments = attachments[messages[index].id] ?? []
    }
    let cursor = messageRows.last?.rowID ?? options.afterRowID
    let reactions = try fetchReactions(
      connection: connection,
      guids: messages.map(\.guid)
    )

    for index in messages.indices {
      messages[index].reactions = reactions[messages[index].guid] ?? []
    }

    let chatIDs = Array(Set(messages.map(\.chatId))).sorted()
    let chats = try chatIDs.compactMap { chatID in
      try fetchChat(connection: connection, chatID: chatID)
    }

    var handlesByID: [Int: IMessageHandle] = [:]
    for chat in chats {
      for participant in chat.participants {
        handlesByID[participant.id] = participant
      }
    }
    for message in messages {
      if let sender = message.sender {
        handlesByID[sender.id] = sender
      }
    }

    return IMessageSyncBatch(
      cursor: cursor,
      fetchedCount: messageRows.count,
      chats: chats,
      messages: messages,
      handles: handlesByID.values.sorted { $0.id < $1.id }
    )
  }

  @MainActor
  private static func streamIMessageChanges(options: IMessageWatchOptions) throws {
    let url = URL(fileURLWithPath: options.dbPath)
    let directoryURL = url.deletingLastPathComponent()
    guard FileManager.default.fileExists(atPath: directoryURL.path) else {
      throw CLIError.imessageWatch("messages directory does not exist: \(directoryURL.path)")
    }

    let fileDescriptor = open(directoryURL.path, O_EVTONLY)
    guard fileDescriptor >= 0 else {
      throw CLIError.imessageWatch("unable to watch messages directory: \(directoryURL.path)")
    }

    try writeJSONLine(WatchEvent(
      event: "ready",
      timestamp: Int(Date().timeIntervalSince1970 * 1000)
    ))

    let source = DispatchSource.makeFileSystemObjectSource(
      fileDescriptor: fileDescriptor,
      eventMask: [.write, .extend, .rename, .delete, .attrib],
      queue: DispatchQueue.main
    )
    source.setEventHandler {
      do {
        try writeJSONLine(WatchEvent(
          event: "messages_changed",
          timestamp: Int(Date().timeIntervalSince1970 * 1000)
        ))
      } catch {
        fputs("\(error.localizedDescription)\n", stderr)
      }
    }
    source.setCancelHandler {
      close(fileDescriptor)
    }
    source.resume()

    RunLoop.main.run()
  }

  private static func fetchMessageRows(
    connection: SQLiteConnection,
    afterRowID: Int,
    limit: Int
  ) throws -> [MessageRow] {
    let sql = """
      SELECT
        m.ROWID as rowid,
        m.guid,
        cmj.chat_id,
        m.item_type,
        CASE WHEN m.is_from_me = 0 THEN m.handle_id ELSE NULL END as sender_id,
        h.id as sender_identifier,
        h.service as sender_service,
        m.text,
        m.attributedBody,
        CAST(m.date / 1000000000 AS INTEGER) + \(appleEpochOffset) as unix_date,
        m.is_from_me,
        m.is_sent,
        m.is_delivered,
        m.is_read,
        CASE
          WHEN m.date_read IS NULL OR m.date_read = 0 THEN NULL
          ELSE CAST(m.date_read / 1000000000 AS INTEGER) + \(appleEpochOffset)
        END as unix_date_read,
        m.error,
        m.cache_has_attachments,
        m.associated_message_type
      FROM message m
      INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ? AND m.item_type IN (0, 1, 2)
      ORDER BY m.ROWID
      LIMIT ?
    """

    return try connection.query(
      sql: sql,
      bind: { statement in
        sqlite3_bind_int64(statement, 1, sqlite3_int64(afterRowID))
        sqlite3_bind_int64(statement, 2, sqlite3_int64(limit))
      },
      mapRow: { statement in
        MessageRow(
          rowID: intColumn(statement, 0) ?? 0,
          guid: stringColumn(statement, 1) ?? "",
          chatID: intColumn(statement, 2) ?? 0,
          itemType: intColumn(statement, 3) ?? 0,
          senderID: intColumn(statement, 4),
          senderIdentifier: stringColumn(statement, 5),
          senderService: stringColumn(statement, 6),
          text: stringColumn(statement, 7),
          attributedBody: dataColumn(statement, 8),
          unixDate: intColumn(statement, 9),
          isFromMe: boolColumn(statement, 10),
          isSent: boolColumn(statement, 11),
          isDelivered: boolColumn(statement, 12),
          isRead: boolColumn(statement, 13),
          unixDateRead: intColumn(statement, 14),
          errorCode: intColumn(statement, 15) ?? 0,
          hasAttachments: boolColumn(statement, 16),
          associatedMessageType: intColumn(statement, 17) ?? 0
        )
      }
    )
  }

  private static func transformMessages(rows: [MessageRow]) -> [IMessageMessage] {
    rows
      .filter { !isTapbackType($0.associatedMessageType) }
      .map { row in
        let sender: IMessageHandle?
        if let senderID = row.senderID {
          sender = IMessageHandle(
            id: senderID,
            identifier: normalizeHandleIdentifier(row.senderIdentifier ?? ""),
            service: row.senderService ?? "iMessage"
          )
        } else {
          sender = nil
        }

        let messageText = resolvedMessageText(
          text: row.text,
          attributedBody: row.attributedBody
        )

        return IMessageMessage(
          id: row.rowID,
          guid: row.guid,
          chatId: row.chatID,
          itemType: row.itemType,
          text: messageText,
          timestamp: row.unixDate ?? 0,
          isFromMe: row.isFromMe,
          isRead: row.isRead,
          readAt: row.unixDateRead,
          status: messageStatus(
            isFromMe: row.isFromMe,
            isSent: row.isSent,
            isDelivered: row.isDelivered,
            isRead: row.isRead,
            errorCode: row.errorCode
          ),
          errorCode: row.errorCode,
          hasAttachments: row.hasAttachments,
          attachments: [],
          sender: sender,
          reactions: []
        )
      }
  }

  private static func fetchAttachments(
    connection: SQLiteConnection,
    messageIDs: [Int]
  ) throws -> [Int: [IMessageAttachment]] {
    guard !messageIDs.isEmpty else {
      return [:]
    }

    let placeholders = Array(repeating: "?", count: messageIDs.count).joined(separator: ", ")
    let sql = """
      SELECT
        maj.message_id,
        a.guid,
        a.filename,
        a.transfer_name,
        a.mime_type,
        a.uti,
        a.total_bytes,
        a.is_sticker,
        a.hide_attachment,
        a.ck_record_id
      FROM message_attachment_join maj
      JOIN attachment a ON a.ROWID = maj.attachment_id
      WHERE maj.message_id IN (\(placeholders))
      ORDER BY maj.message_id ASC, a.ROWID ASC
    """

    let rows = try connection.query(
      sql: sql,
      bind: { statement in
        for (offset, messageID) in messageIDs.enumerated() {
          sqlite3_bind_int64(statement, Int32(offset + 1), sqlite3_int64(messageID))
        }
      },
      mapRow: { statement in
        AttachmentRow(
          messageID: intColumn(statement, 0) ?? 0,
          guid: stringColumn(statement, 1) ?? "",
          filename: stringColumn(statement, 2),
          transferName: stringColumn(statement, 3),
          mimeType: stringColumn(statement, 4),
          uti: stringColumn(statement, 5),
          totalBytes: intColumn(statement, 6),
          isSticker: boolColumn(statement, 7),
          hideAttachment: boolColumn(statement, 8),
          ckRecordID: stringColumn(statement, 9)
        )
      }
    )

    var attachmentsByMessageID: [Int: [IMessageAttachment]] = [:]
    for row in rows {
      attachmentsByMessageID[row.messageID, default: []].append(
        IMessageAttachment(
          guid: row.guid,
          filename: row.filename,
          transferName: row.transferName,
          mimeType: row.mimeType,
          uti: row.uti,
          totalBytes: row.totalBytes,
          isSticker: row.isSticker,
          hideAttachment: row.hideAttachment,
          ckRecordId: row.ckRecordID
        )
      )
    }
    return attachmentsByMessageID
  }

  private static func resolvedMessageText(
    text: String?,
    attributedBody: Data?
  ) -> String? {
    if let extracted = extractTextFromAttributedBody(attributedBody) {
      let trimmed = extracted.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty {
        return extracted
      }
    }

    return text
  }

  private static func fetchChat(
    connection: SQLiteConnection,
    chatID: Int
  ) throws -> IMessageChat? {
    let chatSQL = """
      WITH participant_counts AS (
        SELECT chat_id, COUNT(*) as cnt
        FROM chat_handle_join
        WHERE chat_id = ?
        GROUP BY chat_id
      )
      SELECT
        c.ROWID as id,
        c.chat_identifier as identifier,
        c.display_name as name,
        COALESCE(pc.cnt, 0) > 1 as is_group
      FROM chat c
      LEFT JOIN participant_counts pc ON pc.chat_id = c.ROWID
      WHERE c.ROWID = ?
    """

    let chatRows = try connection.query(
      sql: chatSQL,
      bind: { statement in
        sqlite3_bind_int64(statement, 1, sqlite3_int64(chatID))
        sqlite3_bind_int64(statement, 2, sqlite3_int64(chatID))
      },
      mapRow: { statement in
        (
          id: intColumn(statement, 0) ?? 0,
          identifier: stringColumn(statement, 1) ?? "",
          name: stringColumn(statement, 2),
          isGroup: boolColumn(statement, 3)
        )
      }
    )

    guard let chatRow = chatRows.first else {
      return nil
    }

    let participantsSQL = """
      SELECT h.ROWID as id, h.id as identifier, h.service
      FROM handle h
      INNER JOIN chat_handle_join chj ON chj.handle_id = h.ROWID
      WHERE chj.chat_id = ?
    """

    let participants = try connection.query(
      sql: participantsSQL,
      bind: { statement in
        sqlite3_bind_int64(statement, 1, sqlite3_int64(chatID))
      },
      mapRow: { statement in
        IMessageHandle(
          id: intColumn(statement, 0) ?? 0,
          identifier: normalizeHandleIdentifier(stringColumn(statement, 1) ?? ""),
          service: stringColumn(statement, 2) ?? "iMessage"
        )
      }
    )

    return IMessageChat(
      id: chatRow.id,
      identifier: chatRow.identifier,
      displayName: chatRow.name,
      isGroup: chatRow.isGroup,
      participants: participants
    )
  }

  private static func fetchReactions(
    connection: SQLiteConnection,
    guids: [String]
  ) throws -> [String: [IMessageReaction]] {
    if guids.isEmpty {
      return [:]
    }

    let placeholders = Array(repeating: "?", count: guids.count).joined(separator: ",")
    let sql = """
      SELECT
        CASE
          WHEN m.associated_message_guid LIKE 'p:%/%' THEN substr(m.associated_message_guid, instr(m.associated_message_guid, '/') + 1)
          WHEN m.associated_message_guid LIKE 'bp:%' THEN substr(m.associated_message_guid, 4)
          ELSE m.associated_message_guid
        END as target_guid,
        m.associated_message_type,
        m.associated_message_emoji,
        h.id as reactor_identifier,
        m.is_from_me,
        CAST(m.date / 1000000000 AS INTEGER) + \(appleEpochOffset) as unix_date
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.associated_message_type BETWEEN 2000 AND 3007
        AND (
          CASE
            WHEN m.associated_message_guid LIKE 'p:%/%' THEN substr(m.associated_message_guid, instr(m.associated_message_guid, '/') + 1)
            WHEN m.associated_message_guid LIKE 'bp:%' THEN substr(m.associated_message_guid, 4)
            ELSE m.associated_message_guid
          END
        ) IN (\(placeholders))
    """

    let reactionRows = try connection.query(
      sql: sql,
      bind: { statement in
        for (index, guid) in guids.enumerated() {
          _ = guid.withCString { value in
            sqlite3_bind_text(statement, Int32(index + 1), value, -1, sqliteTransient)
          }
        }
      },
      mapRow: { statement in
        ReactionRow(
          targetGUID: stringColumn(statement, 0) ?? "",
          associatedMessageType: intColumn(statement, 1) ?? 0,
          associatedMessageEmoji: stringColumn(statement, 2),
          reactorIdentifier: stringColumn(statement, 3),
          isFromMe: boolColumn(statement, 4),
          unixDate: intColumn(statement, 5)
        )
      }
    )

    var grouped: [String: [String: IMessageReaction]] = [:]
    for row in reactionRows {
      let baseType = tapbackBaseType(row.associatedMessageType)
      guard let emoji = row.associatedMessageEmoji ?? defaultTapbackEmoji(baseType) else {
        continue
      }

      let normalizedReactor = normalizeHandleIdentifier(row.reactorIdentifier ?? "")
      let reactorKey = "\(row.isFromMe ? "__me__" : normalizedReactor):\(baseType)"
      if grouped[row.targetGUID] == nil {
        grouped[row.targetGUID] = [:]
      }

      if isTapbackRemovalType(row.associatedMessageType) {
        grouped[row.targetGUID]?.removeValue(forKey: reactorKey)
        continue
      }

      grouped[row.targetGUID]?[reactorKey] = IMessageReaction(
        emoji: emoji,
        reactorIdentifier: normalizedReactor,
        isFromMe: row.isFromMe,
        timestamp: row.unixDate ?? 0
      )
    }

    var result: [String: [IMessageReaction]] = [:]
    for (guid, reactions) in grouped {
      result[guid] = reactions.values.sorted { $0.timestamp < $1.timestamp }
    }
    return result
  }

  private static func ensureContactsAccess(store: CNContactStore) throws {
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .authorized:
      return
    case .notDetermined:
      let semaphore = DispatchSemaphore(value: 0)
      let state = ContactsAccessState()
      store.requestAccess(for: .contacts) { accessGranted, _ in
        state.granted = accessGranted
        semaphore.signal()
      }
      semaphore.wait()
      guard state.granted else {
        throw CLIError.contactsAccessDenied
      }
    case .denied, .restricted:
      throw CLIError.contactsAccessDenied
    @unknown default:
      throw CLIError.contactsAccessDenied
    }
  }

  private static func preferredDisplayName(for contact: CNContact) -> String {
    if let formatted = CNContactFormatter.string(from: contact, style: .fullName) {
      let trimmed = formatted.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty {
        return trimmed
      }
    }

    if let nickname = nilIfEmpty(contact.nickname) {
      return nickname
    }

    if let organization = nilIfEmpty(contact.organizationName) {
      return organization
    }

    return "Unknown"
  }

  private static func messageStatus(
    isFromMe: Bool,
    isSent: Bool,
    isDelivered: Bool,
    isRead: Bool,
    errorCode: Int
  ) -> String {
    if errorCode != 0 {
      return "failed"
    }
    if !isFromMe {
      return isRead ? "read" : "delivered"
    }
    if isRead {
      return "read"
    }
    if isDelivered {
      return "delivered"
    }
    if isSent {
      return "sent"
    }
    return "sending"
  }

  private static func isTapbackType(_ value: Int) -> Bool {
    (2000...3007).contains(value)
  }

  private static func isTapbackRemovalType(_ value: Int) -> Bool {
    (3000...3007).contains(value)
  }

  private static func tapbackBaseType(_ value: Int) -> Int {
    isTapbackRemovalType(value) ? value - 1000 : value
  }

  private static func defaultTapbackEmoji(_ value: Int) -> String? {
    switch value {
    case 2000:
      return "❤️"
    case 2001:
      return "👍"
    case 2002:
      return "👎"
    case 2003:
      return "😂"
    case 2004:
      return "‼️"
    case 2005:
      return "❓"
    default:
      return nil
    }
  }

  private static func normalizeHandleIdentifier(_ value: String) -> String {
    value.replacingOccurrences(
      of: #"\s*\(filtered\)\s*$"#,
      with: "",
      options: .regularExpression
    )
  }

  private static func decodeTypedstreamLength(_ data: [UInt8], offset: Int) -> (bytesConsumed: Int, length: Int)? {
    guard offset < data.count else {
      return nil
    }

    let first = Int(data[offset])
    if first < 0x80 {
      return (1, first)
    }

    let extraBytes = first - 0x80 + 1
    guard extraBytes >= 2, extraBytes <= 4, offset + extraBytes < data.count else {
      return nil
    }

    var value = 0
    for index in 0..<extraBytes {
      let byte = Int(data[offset + 1 + index])
      value |= byte << (index * 8)
    }
    return (1 + extraBytes, value)
  }

  private static func extractTextFromAttributedBody(_ blob: Data?) -> String? {
    guard let blob, !blob.isEmpty else {
      return nil
    }

    let marker = Data("NSString".utf8)
    guard let markerRange = blob.range(of: marker) else {
      return nil
    }

    let afterMarker = blob[markerRange.upperBound...]
    let bytes = Array(afterMarker)
    guard bytes.count >= 7 else {
      return nil
    }

    for index in 0..<(bytes.count - 6) {
      let firstByte = bytes[index]
      guard (firstByte == 0x94 || firstByte == 0x95), bytes.count > index + 4 else {
        continue
      }
      guard bytes[index + 1] == 0x84, bytes[index + 2] == 0x01, bytes[index + 3] == 0x2b else {
        continue
      }
      guard let decoded = decodeTypedstreamLength(bytes, offset: index + 4) else {
        continue
      }

      let textStart = index + 4 + decoded.bytesConsumed
      let textEnd = textStart + decoded.length
      guard textEnd <= bytes.count else {
        continue
      }

      let textData = Data(bytes[textStart..<textEnd])
      guard let raw = String(data: textData, encoding: .utf8) else {
        continue
      }

      let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      let isAppleInternal =
        trimmed.isEmpty ||
        trimmed.hasPrefix("NS") ||
        trimmed.hasPrefix("_NS") ||
        trimmed.contains("AttributeName")
      if isAppleInternal {
        continue
      }

      let filtered = trimmed.replacingOccurrences(of: "\u{fffc}", with: "")
      return filtered.isEmpty ? "[attachment]" : filtered
    }

    return nil
  }

  private static func nilIfEmpty(_ value: String?) -> String? {
    guard let value else {
      return nil
    }

    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private static func stringColumn(_ statement: OpaquePointer?, _ index: Int32) -> String? {
    guard sqlite3_column_type(statement, index) != SQLITE_NULL,
      let value = sqlite3_column_text(statement, index)
    else {
      return nil
    }

    return String(cString: value)
  }

  private static func dataColumn(_ statement: OpaquePointer?, _ index: Int32) -> Data? {
    guard sqlite3_column_type(statement, index) != SQLITE_NULL,
      let value = sqlite3_column_blob(statement, index)
    else {
      return nil
    }

    let count = Int(sqlite3_column_bytes(statement, index))
    return Data(bytes: value, count: count)
  }

  private static func intColumn(_ statement: OpaquePointer?, _ index: Int32) -> Int? {
    guard sqlite3_column_type(statement, index) != SQLITE_NULL else {
      return nil
    }

    return Int(sqlite3_column_int64(statement, index))
  }

  private static func boolColumn(_ statement: OpaquePointer?, _ index: Int32) -> Bool {
    intColumn(statement, index) == 1
  }
}

private enum ManagedAuthPlatform: String {
  case slack
  case linkedin

  var loginURL: URL {
    switch self {
    case .slack:
      return URL(string: "https://slack.com/signin")!
    case .linkedin:
      return URL(string: "https://www.linkedin.com/login")!
    }
  }

  var windowTitle: String {
    switch self {
    case .slack:
      return "Sign in to Slack"
    case .linkedin:
      return "Sign in to LinkedIn"
    }
  }

  var keychainService: String {
    "dev.cued.auth.\(rawValue)"
  }

  var desktopUserAgent: String {
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15"
  }
}

@MainActor
private final class QRCodeCoordinator: NSObject, NSWindowDelegate {
  private let options: AuthQROptions
  private let app = NSApplication.shared
  private var window: NSWindow?
  private var finalState = "cancelled"

  init(options: AuthQROptions) {
    self.options = options
    super.init()
  }

  func run() -> NativeQRResult {
    app.setActivationPolicy(.regular)

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 420, height: 520),
      styleMask: [.titled, .closable],
      backing: .buffered,
      defer: false
    )
    window.center()
    window.title = options.title
    window.delegate = self

    let contentView = NSView(frame: window.contentView?.bounds ?? .zero)
    contentView.translatesAutoresizingMaskIntoConstraints = false

    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 16
    stack.translatesAutoresizingMaskIntoConstraints = false

    let titleLabel = NSTextField(labelWithString: options.title)
    titleLabel.font = NSFont.systemFont(ofSize: 24, weight: .semibold)
    titleLabel.alignment = .center

    let subtitleLabel = NSTextField(wrappingLabelWithString: options.subtitle)
    subtitleLabel.alignment = .center
    subtitleLabel.maximumNumberOfLines = 0
    subtitleLabel.textColor = .secondaryLabelColor

    let imageView = NSImageView()
    imageView.imageScaling = .scaleProportionallyUpOrDown
    imageView.image = makeQRCodeImage(for: options.uri)
    imageView.translatesAutoresizingMaskIntoConstraints = false

    let caption = NSTextField(labelWithString: "Close this window to cancel")
    caption.textColor = .secondaryLabelColor
    caption.alignment = .center

    stack.addArrangedSubview(titleLabel)
    stack.addArrangedSubview(subtitleLabel)
    stack.addArrangedSubview(imageView)
    stack.addArrangedSubview(caption)

    contentView.addSubview(stack)
    window.contentView = contentView

    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -24),
      stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 24),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor, constant: -24),
      imageView.widthAnchor.constraint(equalToConstant: 280),
      imageView.heightAnchor.constraint(equalToConstant: 280),
    ])

    window.makeKeyAndOrderFront(nil)
    self.window = window
    app.activate(ignoringOtherApps: true)
    app.run()
    return NativeQRResult(state: finalState)
  }

  func closeAsCompleted() {
    finalState = "completed"
    stopRunLoop()
  }

  func windowWillClose(_ notification: Notification) {
    stopRunLoop()
  }

  private func stopRunLoop() {
    if let window {
      self.window = nil
      window.orderOut(nil)
    }
    app.stop(nil)
    let event = NSEvent.otherEvent(
      with: .applicationDefined,
      location: .zero,
      modifierFlags: [],
      timestamp: 0,
      windowNumber: 0,
      context: nil,
      subtype: 0,
      data1: 0,
      data2: 0
    )
    if let event {
      app.postEvent(event, atStart: false)
    }
  }

  private func makeQRCodeImage(for text: String) -> NSImage? {
    guard let data = text.data(using: .utf8) else {
      return nil
    }

    guard let filter = CIFilter(name: "CIQRCodeGenerator") else {
      return nil
    }
    filter.setValue(data, forKey: "inputMessage")
    filter.setValue("H", forKey: "inputCorrectionLevel")
    guard let outputImage = filter.outputImage else {
      return nil
    }

    let transformed = outputImage.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
    let rep = NSCIImageRep(ciImage: transformed)
    let image = NSImage(size: rep.size)
    image.addRepresentation(rep)
    return image
  }
}

@MainActor
private final class ManagedAuthCoordinator: NSObject, NSWindowDelegate, WKNavigationDelegate {
  private let options: AuthOpenOptions
  private let platform: ManagedAuthPlatform
  private let app = NSApplication.shared
  private let timeoutSeconds: TimeInterval = 300
  private var window: NSWindow?
  private var webView: WKWebView?
  private var pollTimer: Timer?
  private var timeoutTimer: Timer?
  private var resolved = false
  private var extractionInProgress = false
  private var finalResult: NativeAuthResult?

  init(options: AuthOpenOptions) throws {
    guard let platform = ManagedAuthPlatform(rawValue: options.platform.lowercased()) else {
      throw CLIError.auth("unsupported native auth platform: \(options.platform)")
    }
    self.options = options
    self.platform = platform
    super.init()
  }

  func run() throws -> NativeAuthResult {
    app.setActivationPolicy(.regular)
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.customUserAgent = platform.desktopUserAgent
    webView.navigationDelegate = self
    self.webView = webView

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.center()
    window.title = platform.windowTitle
    window.delegate = self
    window.contentView = webView
    window.makeKeyAndOrderFront(nil)
    self.window = window

    app.activate(ignoringOtherApps: true)

    pollTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
      Task { @MainActor in
        self?.attemptExtraction()
      }
    }
    timeoutTimer = Timer.scheduledTimer(withTimeInterval: timeoutSeconds, repeats: false) { [weak self] _ in
      Task { @MainActor in
        self?.finish(
          state: "failed",
          resultSummary: nil,
          errorSummary: "Timed out waiting for authenticated session"
        )
      }
    }

    webView.load(URLRequest(url: platform.loginURL))
    app.run()

    if let finalResult {
      return finalResult
    }
    throw CLIError.auth("auth session ended without a result")
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    attemptExtraction()
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    attemptExtraction()
  }

  func webView(
    _ webView: WKWebView,
    didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!
  ) {
    attemptExtraction()
  }

  func windowWillClose(_ notification: Notification) {
    if !resolved {
      finish(state: "cancelled", resultSummary: nil, errorSummary: "Login cancelled by user")
    }
  }

  private func attemptExtraction() {
    guard !resolved, !extractionInProgress, let webView else {
      return
    }

    let currentURL = webView.url?.absoluteString ?? platform.loginURL.absoluteString
    guard shouldAttemptExtraction(urlString: currentURL) else {
      return
    }

    extractionInProgress = true
    switch platform {
    case .slack:
      extractSlackAuth(from: webView, currentURL: currentURL)
    case .linkedin:
      extractCookieAuth(from: webView, currentURL: currentURL)
    }
  }

  private func shouldAttemptExtraction(urlString: String) -> Bool {
    switch platform {
    case .slack:
      if !(urlString.contains("slack.com") || urlString.contains("app.slack.com")) {
        return false
      }
      return !urlString.contains("/signin") && !urlString.contains("/checkcookie")
    case .linkedin:
      guard urlString.contains("linkedin.com") else { return false }
      return !urlString.contains("/login")
        && !urlString.contains("/authwall")
        && !urlString.contains("/checkpoint")
    }
  }

  private func extractSlackAuth(from webView: WKWebView, currentURL: String) {
    let script = "window.localStorage.getItem('localConfig_v2')"
    webView.evaluateJavaScript(script) { [weak self] value, error in
      guard let self else { return }
      if let error {
        self.extractionInProgress = false
        self.finish(state: "failed", resultSummary: nil, errorSummary: error.localizedDescription)
        return
      }

      let localConfig = value as? String ?? ""
      self.webViewCookies(from: webView) { cookies in
        self.finishSlackExtraction(
          currentURL: currentURL,
          localConfig: localConfig,
          cookies: cookies
        )
      }
    }
  }

  private func finishSlackExtraction(currentURL: String, localConfig: String, cookies: [HTTPCookie]) {
    defer { extractionInProgress = false }

    guard
      let summary = parseSlackLocalConfig(localConfig),
      let cookie = cookies.first(where: { $0.name == "d" && $0.value.isEmpty == false })
    else {
      return
    }

    let payload = [
      "token": summary.token,
      "cookie": cookie.value,
      "teamId": summary.teamID,
      "teamName": summary.teamName,
      "userId": summary.userID,
      "capturedFrom": currentURL,
    ]

    do {
      try storeSecret(payload: payload)
      finish(
        state: "authenticated",
        resultSummary: [
          "teamId": summary.teamID,
          "teamName": summary.teamName,
          "userId": summary.userID,
        ],
        errorSummary: nil
      )
    } catch {
      finish(state: "failed", resultSummary: nil, errorSummary: error.localizedDescription)
    }
  }

  private func extractCookieAuth(from webView: WKWebView, currentURL: String) {
    webViewCookies(from: webView) { [weak self] cookies in
      guard let self else { return }
      defer { self.extractionInProgress = false }

      let requiredCookies: [String]
      switch self.platform {
      case .linkedin:
        requiredCookies = ["li_at", "JSESSIONID"]
      case .slack:
        requiredCookies = []
      }

      var extracted: [String: String] = [:]
      for name in requiredCookies {
        if let cookie = cookies.first(where: { $0.name == name && $0.value.isEmpty == false }) {
          extracted[name] = cookie.value
        }
      }

      guard extracted.count == requiredCookies.count else {
        return
      }

      extracted["capturedFrom"] = currentURL
      do {
        try self.storeSecret(payload: extracted)
        self.finish(
          state: "authenticated",
          resultSummary: requiredCookies.reduce(into: [String: String]()) { result, name in
            result[name] = "present"
          },
          errorSummary: nil
        )
      } catch {
        self.finish(state: "failed", resultSummary: nil, errorSummary: error.localizedDescription)
      }
    }
  }

  private func webViewCookies(from webView: WKWebView, completion: @escaping ([HTTPCookie]) -> Void) {
    webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
      let filtered = cookies.filter { cookie in
        switch self.platform {
        case .slack:
          return cookie.domain.contains("slack.com")
        case .linkedin:
          return cookie.domain.contains("linkedin.com")
        }
      }
      completion(filtered)
    }
  }

  private func storeSecret(payload: [String: String]) throws {
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: platform.keychainService,
      kSecAttrAccount: options.accountKey,
    ]

    let attributes: [CFString: Any] = [
      kSecValueData: data,
      kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
      kSecAttrLabel: "Cued \(platform.rawValue) auth",
    ]

    let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if updateStatus == errSecSuccess {
      return
    }

    if updateStatus != errSecItemNotFound {
      throw CLIError.auth("failed to update Keychain item: \(updateStatus)")
    }

    var insert = query
    for (key, value) in attributes {
      insert[key] = value
    }
    let addStatus = SecItemAdd(insert as CFDictionary, nil)
    if addStatus != errSecSuccess {
      throw CLIError.auth("failed to store Keychain item: \(addStatus)")
    }
  }

  private func finish(
    state: String,
    resultSummary: [String: String]?,
    errorSummary: String?
  ) {
    guard !resolved else {
      return
    }
    resolved = true
    pollTimer?.invalidate()
    timeoutTimer?.invalidate()
    finalResult = NativeAuthResult(
      sessionId: options.sessionID,
      platform: platform.rawValue,
      accountKey: options.accountKey,
      state: state,
      keychainService: state == "authenticated" ? platform.keychainService : nil,
      keychainAccount: state == "authenticated" ? options.accountKey : nil,
      resultSummary: resultSummary,
      errorSummary: errorSummary
    )

    if let window {
      window.orderOut(nil)
      window.close()
    }

    stopApplicationRunLoop()
  }

  private func stopApplicationRunLoop() {
    app.stop(nil)
    let event = NSEvent.otherEvent(
      with: .applicationDefined,
      location: .zero,
      modifierFlags: [],
      timestamp: 0,
      windowNumber: 0,
      context: nil,
      subtype: 0,
      data1: 0,
      data2: 0
    )
    if let event {
      app.postEvent(event, atStart: false)
    }
  }
}

private struct SlackLocalConfigSummary {
  let token: String
  let teamID: String
  let teamName: String
  let userID: String
}

private func parseSlackLocalConfig(_ rawValue: String) -> SlackLocalConfigSummary? {
  guard let data = rawValue.data(using: .utf8) else {
    return nil
  }
  guard
    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let teams = json["teams"] as? [String: Any]
  else {
    return nil
  }

  for (teamID, teamValue) in teams {
    guard let team = teamValue as? [String: Any] else {
      continue
    }
    guard let token = team["token"] as? String, token.hasPrefix("xoxc-") else {
      continue
    }
    let teamName = (team["name"] as? String) ?? teamID
    let userID = (team["user_id"] as? String) ?? ""
    return SlackLocalConfigSummary(token: token, teamID: teamID, teamName: teamName, userID: userID)
  }

  return nil
}
