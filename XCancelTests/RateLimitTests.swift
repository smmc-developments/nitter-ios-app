import XCTest
@testable import XCancel

final class RateLimitTests: XCTestCase {

    func testBackoffIncreasesExponentially() {
        let b0 = XCancelClient.backoff(attempt: 0)
        let b1 = XCancelClient.backoff(attempt: 1)
        let b2 = XCancelClient.backoff(attempt: 2)
        // Base is 2s: 2*2^0=2, 2*2^1=4, 2*2^2=8 (plus jitter).
        XCTAssertGreaterThanOrEqual(b0, 2.0)
        XCTAssertLessThan(b0, 2.6)
        XCTAssertGreaterThanOrEqual(b1, 4.0)
        XCTAssertLessThan(b1, 4.6)
        XCTAssertGreaterThanOrEqual(b2, 8.0)
        XCTAssertLessThan(b2, 8.6)
    }

    func testBackoffWithRetryAfter() {
        // Retry-After should win when it's larger than the computed backoff.
        let b = XCancelClient.backoff(attempt: 0, retryAfter: 5.0)
        XCTAssertGreaterThanOrEqual(b, 5.0)
    }

    func testBackoffRetryAfterSmallerThanComputed() {
        // Computed wins when Retry-After is tiny.
        let b = XCancelClient.backoff(attempt: 2, retryAfter: 0.1)
        XCTAssertGreaterThanOrEqual(b, 4.0)
    }

    func testParseRetryAfterSeconds() {
        let response = fakeResponse(headers: ["Retry-After": "10"])
        XCTAssertEqual(XCancelClient.parseRetryAfter(response), 10.0)
    }

    func testParseRetryAfterHTTPDate() {
        let future = Date().addingTimeInterval(30)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        formatter.timeZone = TimeZone(identifier: "UTC")
        let dateStr = formatter.string(from: future)
        let response = fakeResponse(headers: ["Retry-After": dateStr])
        let parsed = XCancelClient.parseRetryAfter(response)
        XCTAssertNotNil(parsed)
        XCTAssertGreaterThanOrEqual(parsed!, 25) // ~30s minus clock slop
    }

    func testParseRetryAfterMissing() {
        let response = fakeResponse(headers: [:])
        XCTAssertNil(XCancelClient.parseRetryAfter(response))
    }

    func testXCancelErrorIsRateLimited() {
        XCTAssertTrue(XCancelError.rateLimited(retryAfter: nil).isRateLimited)
        XCTAssertFalse(XCancelError.http(429).isRateLimited)
        XCTAssertFalse(XCancelError.challengeFailed.isRateLimited)
    }

    // MARK: - Helpers

    private func fakeResponse(headers: [String: String]) -> HTTPURLResponse {
        HTTPURLResponse(
            url: URL(string: "https://xcancel.com/test")!,
            statusCode: 429,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
    }
}
