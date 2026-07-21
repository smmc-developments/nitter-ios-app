import XCTest
@testable import Nitter

final class SharedLinkTests: XCTestCase {
    func testParsesXStatusURL() throws {
        let link = SharedXLink(sourceURL: try XCTUnwrap(URL(string: "https://x.com/NASA/status/1234567890?s=20")))
        XCTAssertEqual(link, .tweet(username: "nasa", id: "1234567890"))
    }

    func testParsesTwitterProfileURL() throws {
        let link = SharedXLink(sourceURL: try XCTUnwrap(URL(string: "https://twitter.com/Canucks")))
        XCTAssertEqual(link, .profile(username: "canucks"))
    }

    func testParsesAppDeepLink() throws {
        var components = URLComponents()
        components.scheme = "nitter"
        components.host = "open"
        components.queryItems = [
            URLQueryItem(name: "url", value: "https://mobile.twitter.com/NHL/status/987654321"),
        ]

        let link = SharedXLink(deepLink: try XCTUnwrap(components.url))
        XCTAssertEqual(link, .tweet(username: "nhl", id: "987654321"))
    }

    func testRejectsUnsupportedURLs() throws {
        XCTAssertNil(SharedXLink(sourceURL: try XCTUnwrap(URL(string: "https://example.com/NASA/status/123"))))
        XCTAssertNil(SharedXLink(sourceURL: try XCTUnwrap(URL(string: "https://x.com/home"))))
    }
}
