import XCTest
@testable import Nitter

/// End-to-end test against the live Nitter instance: exercises the
/// anti-bot challenge bootstrap (hidden WKWebView), cookie harvesting and
/// timeline parsing. Disabled by default — flip `enabled` to true to run.
final class LiveFetchTests: XCTestCase {

    private static let enabled = false

    func testLiveTimelineFetch() async throws {
        try XCTSkipUnless(Self.enabled, "Live network test disabled")

        let timeline = try await NitterClient.shared.timeline(for: "nasa")

        XCTAssertEqual(timeline.account?.handle.lowercased(), "nasa")
        XCTAssertFalse(timeline.tweets.isEmpty, "expected tweets from the live Nitter instance")

        let tweet = try XCTUnwrap(timeline.tweets.first)
        XCTAssertFalse(tweet.authorName.isEmpty)
        XCTAssertNotNil(tweet.date)
        XCTAssertNotNil(tweet.statusURL)
    }
}
