import Foundation
import SQLite3
import XCTest
@testable import CuedNative

final class IMessageMutationTests: XCTestCase {
  private func withFixture(mutations: Bool = true, _ body: (String, OpaquePointer?) throws -> Void) throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).path
    var db: OpaquePointer?
    XCTAssertEqual(sqlite3_open(path, &db), SQLITE_OK)
    defer { sqlite3_close(db); try? FileManager.default.removeItem(atPath: path) }
    try execute(db, """
      CREATE TABLE message (guid TEXT, item_type INTEGER DEFAULT 0, handle_id INTEGER,
        text TEXT, attributedBody BLOB, date INTEGER DEFAULT 1000000000,
        is_from_me INTEGER DEFAULT 1, is_sent INTEGER DEFAULT 1,
        is_delivered INTEGER DEFAULT 1, is_read INTEGER DEFAULT 1,
        date_read INTEGER, error INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
        associated_message_type INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_emoji TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE handle (id TEXT, service TEXT);
      CREATE TABLE chat (chat_identifier TEXT, display_name TEXT);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
      CREATE TABLE attachment (guid TEXT, filename TEXT, transfer_name TEXT, mime_type TEXT,
        uti TEXT, total_bytes INTEGER, is_sticker INTEGER, hide_attachment INTEGER, ck_record_id TEXT);
      INSERT INTO chat VALUES ('chat', NULL);
      INSERT INTO message (guid,text) VALUES ('one','original'), ('two','retracted'), ('three','new');
      INSERT INTO chat_message_join VALUES (1,1), (1,2), (1,3);
      """)
    if mutations {
      try execute(db, """
        ALTER TABLE message ADD COLUMN date_edited INTEGER DEFAULT 0;
        ALTER TABLE message ADD COLUMN date_retracted INTEGER DEFAULT 0;
        UPDATE message SET date_edited=123456789012345, attributedBody=X'4e53537472696e679484012b076368616e676564' WHERE ROWID=1;
        UPDATE message SET date_retracted=234567890123456, cache_has_attachments=1 WHERE ROWID=2;
        INSERT INTO attachment (guid, filename) VALUES ('attachment','private');
        INSERT INTO message_attachment_join VALUES (2,1);
        INSERT INTO message (guid,associated_message_type,associated_message_guid) VALUES ('reaction',2000,'two');
        """)
    }
    try body(path, db)
  }

  private func execute(_ db: OpaquePointer?, _ sql: String) throws {
    guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else {
      throw NSError(domain: "fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(db))])
    }
  }

  func testHistoricalMutationPaginationAndRetraction() throws {
    try withFixture { path, db in
      let first = try Command.dumpIMessage(options: IMessageDumpOptions(dbPath: path, afterRowID: 3, limit: 1))
      XCTAssertEqual(first.cursor, 3)
      XCTAssertEqual(first.fetchedCount, 0)
      XCTAssertEqual(first.mutationCursor, 1)
      XCTAssertTrue(first.mutationHasMore)
      XCTAssertEqual(first.messages.first?.text, "changed")
      XCTAssertEqual(first.messages.first?.editedAt, 978_430_656_789)
      XCTAssertEqual(first.messages.first?.mutationStamp, "123456789012345:0")
      try execute(db, "UPDATE message SET date_edited=123456789012346 WHERE ROWID=1")
      let repeated = try Command.dumpIMessage(options: IMessageDumpOptions(dbPath: path, afterRowID: 3, limit: 1))
      XCTAssertEqual(repeated.messages.first?.editedAt, first.messages.first?.editedAt)
      XCTAssertNotEqual(repeated.messages.first?.mutationStamp, first.messages.first?.mutationStamp)
      let second = try Command.dumpIMessage(options: IMessageDumpOptions(dbPath: path, afterRowID: 3, mutationsAfterRowID: 1, limit: 1))
      let deleted = try XCTUnwrap(second.messages.first)
      XCTAssertNil(deleted.text)
      XCTAssertEqual(deleted.deletedAt, 978_541_767_890)
      XCTAssertFalse(deleted.hasAttachments)
      XCTAssertTrue(deleted.attachments.isEmpty)
      XCTAssertTrue(deleted.reactions.isEmpty)
      let end = try Command.dumpIMessage(options: IMessageDumpOptions(dbPath: path, afterRowID: 3, mutationsAfterRowID: 2, limit: 1))
      XCTAssertEqual(end.mutationCursor, 0)
      XCTAssertFalse(end.mutationHasMore)
      // A delayed iCloud mutation can have a timestamp older than prior edits.
      try execute(db, "UPDATE message SET date_edited=1000000000 WHERE ROWID=3")
      let cycle = try Command.dumpIMessage(options: IMessageDumpOptions(dbPath: path, afterRowID: 3, limit: 10))
      XCTAssertEqual(cycle.messages.map(\.id), [1,2,3])
    }
  }

  func testNewRowsIncludeMutationMetadataAndOlderSchemasRemainReadable() throws {
    try withFixture { path, _ in
      let batch = try Command.dumpIMessage(options: IMessageDumpOptions(dbPath: path, limit: 10))
      XCTAssertEqual(batch.cursor, 3)
      XCTAssertEqual(batch.fetchedCount, 3)
      XCTAssertEqual(batch.messages.first?.mutationStamp, "123456789012345:0")
      XCTAssertEqual(batch.messages[1].deletedAt, 978_541_767_890)
    }
    try withFixture(mutations: false) { path, _ in
      let batch = try Command.dumpIMessage(options: IMessageDumpOptions(dbPath: path))
      XCTAssertEqual(batch.messages.count, 3)
      XCTAssertEqual(batch.messages.first?.mutationStamp, "0:0")
      XCTAssertNil(batch.messages.first?.editedAt)
      XCTAssertFalse(batch.mutationHasMore)
      let historical = try Command.dumpIMessage(options: IMessageDumpOptions(dbPath: path, afterRowID: 3))
      XCTAssertTrue(historical.messages.isEmpty)
    }
  }
}
