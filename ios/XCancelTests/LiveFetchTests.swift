import XCTest
@testable import XCancel

/// End-to-end test against the live xcancel.com site: exercises the
/// anti-bot challenge bootstrap (hidden WKWebView), cookie harvesting and
/// timeline parsing. Disabled by default — flip `enabled` to true to run.
final class LiveFetchTests: XCTestCase {

    private static let enabled = false

    func testLiveTimelineFetch() async throws {
        try XCTSkipUnless(Self.enabled, "Live network test disabled")

        let timeline = try await XCancelClient.shared.timeline(for: "nasa")

        XCTAssertEqual(timeline.account?.handle.lowercased(), "nasa")
        XCTAssertFalse(timeline.tweets.isEmpty, "expected tweets from live xcancel.com")

        let tweet = try XCTUnwrap(timeline.tweets.first)
        XCTAssertFalse(tweet.authorName.isEmpty)
        XCTAssertNotNil(tweet.date)
        XCTAssertNotNil(tweet.statusURL)
    }
}
