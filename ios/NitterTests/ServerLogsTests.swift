import XCTest
@testable import Nitter

final class ServerLogsTests: XCTestCase {

    func testDecodesLogResponse() throws {
        let json = """
        {
          "entries": [
            {"id": 41, "ts": "2026-09-10T18:04:33.421Z", "level": "warn", "scope": "routes", "message": "Auth failed"},
            {"id": 42, "ts": "2026-09-10T18:04:34.000Z", "level": "error", "scope": "fetcher", "message": "boom"}
          ],
          "latest": 42
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(ServerLogResponse.self, from: json)
        XCTAssertEqual(decoded.latest, 42)
        XCTAssertEqual(decoded.entries.count, 2)
        XCTAssertEqual(decoded.entries[0].id, 41)
        XCTAssertEqual(decoded.entries[0].level, "warn")
        XCTAssertEqual(decoded.entries[0].scope, "routes")
        XCTAssertEqual(decoded.entries[0].message, "Auth failed")
    }

    func testParsesFractionalSecondsTimestamp() throws {
        let json = """
        {"id": 1, "ts": "2026-09-10T18:04:33.421Z", "level": "info", "scope": "index", "message": "hi"}
        """.data(using: .utf8)!
        let entry = try JSONDecoder().decode(ServerLogEntry.self, from: json)
        let date = try XCTUnwrap(entry.date)
        XCTAssertEqual(date.timeIntervalSince1970, 1_789_063_473.421, accuracy: 0.001)
    }
}
