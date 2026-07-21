import XCTest
@testable import XCancel

final class TimelineParserTests: XCTestCase {

    private var timeline: Timeline!

    override func setUpWithError() throws {
        let url = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "timeline", withExtension: "html"),
            "fixture timeline.html missing"
        )
        let html = try String(contentsOf: url, encoding: .utf8)
        timeline = try TimelineParser.parse(
            html: html,
            baseURL: try XCTUnwrap(URL(string: "https://xcancel.com"))
        )
    }

    func testServerISODateWithFractionalSeconds() throws {
        let date = try XCTUnwrap(ServerTweet.parseDate("2026-07-20T20:33:00.000Z"))
        XCTAssertEqual(date.timeIntervalSince1970, 1_784_579_580, accuracy: 0.001)
        let account = APIClient.ServerAccount(
            username: "nasa",
            display_name: "NASA",
            avatar_url: nil,
            last_fetched_at: "2026-07-21 02:15:30",
            fetch_error: nil,
            created_at: nil
        )
        let fetchedDate = try XCTUnwrap(account.lastFetchedDate)
        XCTAssertEqual(fetchedDate.timeIntervalSince1970, 1_784_600_130, accuracy: 0.001)
    }

    func testParsesAllRealTweetsAndSkipsShowMore() {
        XCTAssertEqual(timeline.tweets.count, 3)
        XCTAssertEqual(
            timeline.tweets.map(\.id),
            ["1948123456789012345", "1949000000000000001", "1949500000000000002"]
        )
    }

    func testAccountInfoFromProfileCard() {
        let account = timeline.account
        XCTAssertEqual(account?.handle, "NASA")
        XCTAssertEqual(account?.name, "NASA")
        XCTAssertEqual(account?.avatarURL?.absoluteString,
                       "https://pbs.twimg.com/profile_images/13235879/nasa_400x400.jpg")
    }

    func testProfileCardPreferredOverFirstTweetAuthor() throws {
        // First timeline item is a SpaceX retweet; the account must still be
        // the profile owner (NASA) from the profile card.
        let html = """
        <div class="profile-card">
          <a class="profile-card-fullname" href="/NASA">NASA</a>
          <a class="profile-card-username" href="/NASA">@NASA</a>
        </div>
        <div class="timeline">
          <div class="timeline-item " data-username="SpaceX">
            <a class="tweet-link" href="/SpaceX/status/1949000000000000001#m"></a>
            <div class="tweet-body">
              <div class="tweet-header">
                <div class="tweet-name-row">
                  <div class="fullname-and-username">
                    <a class="fullname" href="/SpaceX">SpaceX</a>
                    <a class="username" href="/SpaceX">@SpaceX</a>
                  </div>
                  <span class="tweet-date"><a href="/SpaceX/status/1949000000000000001#m" title="Jul 18, 2026 &#183; 9:05 AM UTC">7h</a></span>
                </div>
              </div>
              <div class="tweet-content media-body" dir="auto">hi</div>
            </div>
          </div>
        </div>
        """
        let parsed = try TimelineParser.parse(html: html, baseURL: URL(string: "https://xcancel.com")!)
        XCTAssertEqual(parsed.account?.handle, "NASA")
        XCTAssertEqual(parsed.tweets.first?.authorHandle, "SpaceX")
    }

    func testExpandsTruncatedLinkText() throws {
        let html = """
        <div class="timeline-item" data-username="author">
          <a class="tweet-link" href="/author/status/123"></a>
          <div class="tweet-body">
            <div class="tweet-header"><a class="fullname">Author</a><a class="username">@author</a></div>
            <div class="tweet-content">Visit <a href="https://example.com/full/path">example.com/full…</a></div>
          </div>
        </div>
        """
        let parsed = try TimelineParser.parse(
            html: html,
            baseURL: XCTUnwrap(URL(string: "https://xcancel.com"))
        )
        XCTAssertEqual(parsed.tweets.first?.text, "Visit https://example.com/full/path")
    }

    func testPinnedTweetFields() {
        let pinned = timeline.tweets[0]
        XCTAssertTrue(pinned.isPinned)
        XCTAssertNil(pinned.retweetedBy)
        XCTAssertEqual(pinned.authorName, "NASA")
        XCTAssertEqual(pinned.authorHandle, "NASA")
        XCTAssertEqual(pinned.statusURL?.absoluteString,
                       "https://xcancel.com/NASA/status/1948123456789012345")
        XCTAssertTrue(pinned.text.contains("Welcome to our pinned post."))
        XCTAssertTrue(pinned.text.contains("mission"))
        XCTAssertEqual(pinned.replyCount, 42)
        XCTAssertEqual(pinned.retweetCount, 128)
        XCTAssertEqual(pinned.likeCount, 1024)
        XCTAssertEqual(pinned.viewCount, 96500)
    }

    func testDateParsing() throws {
        let date = try XCTUnwrap(timeline.tweets[1].date)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let components = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        XCTAssertEqual(components.year, 2026)
        XCTAssertEqual(components.month, 7)
        XCTAssertEqual(components.day, 18)
        XCTAssertEqual(components.hour, 9)
        XCTAssertEqual(components.minute, 5)
    }

    func testRetweetHeaderAndPhotos() {
        let retweet = timeline.tweets[1]
        XCTAssertEqual(retweet.retweetedBy, "NASA")
        XCTAssertFalse(retweet.isPinned)
        XCTAssertEqual(retweet.photoURLs.count, 2)
        XCTAssertEqual(
            retweet.photoURLs.first?.absoluteString,
            "https://xcancel.com/pic/pbs.twimg.com%2Fmedia%2Faaa.jpg?name=small&format=webp"
        )
        XCTAssertNil(retweet.videoPosterURL)
        // Empty stat text parses as zero.
        XCTAssertEqual(retweet.retweetCount, 0)
    }

    func testVideoAndQuote() {
        let tweet = timeline.tweets[2]
        XCTAssertEqual(tweet.videoPosterURL?.absoluteString,
                       "https://xcancel.com/pic/pbs.twimg.com%2Fext_tw_video_thumb%2Fxyz.jpg?name=small")
        XCTAssertEqual(tweet.videoURL?.absoluteString,
                       "https://xcancel.com/video/vid.twimg.com%2Fext_tw_video%2Fxyz%2Fpu%2Fvid%2Favc1%2F640x360%2Fabc.mp4")
        XCTAssertTrue(tweet.photoURLs.isEmpty)
        XCTAssertEqual(tweet.quotedText, "Congratulations on the launch!")
        XCTAssertEqual(tweet.quotedHandle, "ESA")
        XCTAssertEqual(tweet.replyCount, 0)
        XCTAssertEqual(tweet.viewCount, 0)
    }

    func testGarbageHTMLReturnsEmptyTimeline() throws {
        let empty = try TimelineParser.parse(
            html: "<html><body><p>nothing here</p></body></html>",
            baseURL: URL(string: "https://xcancel.com")!
        )
        XCTAssertTrue(empty.tweets.isEmpty)
        XCTAssertNil(empty.account)
    }
}
