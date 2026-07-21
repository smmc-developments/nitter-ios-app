import Foundation

enum NitterError: LocalizedError {
    case http(Int)
    case rateLimited(retryAfter: TimeInterval?)
    case challengeFailed
    case badResponse

    var errorDescription: String? {
        switch self {
        case .http(let code): return "The Nitter instance returned HTTP \(code)"
        case .rateLimited: return "The Nitter instance is rate-limiting requests"
        case .challengeFailed: return "Couldn't pass the Nitter instance's anti-bot check"
        case .badResponse: return "Unexpected response from the Nitter instance"
        }
    }

    var isRateLimited: Bool {
        if case .rateLimited = self { return true }
        return false
    }
}

/// Thin client for a Nitter instance. Fetches timeline HTML with `URLSession`,
/// transparently delegating to `ChallengeBootstrapper` when the site answers
/// with its JavaScript anti-bot challenge (HTTP 503).
actor NitterClient {
    static let shared = NitterClient()
    static let userAgentDefaultsKey = "nitter.userAgent"
    private static let legacyUserAgentDefaultsKey = "xcancel.userAgent"

    /// Base inter-request delay in seconds when fetching multiple accounts.
    static let baseRequestDelay: TimeInterval = 2.0

    private let baseURL = "https://nitter.poast.org"
    private let session: URLSession

    private init() {
        let defaults = UserDefaults.standard
        if defaults.string(forKey: Self.userAgentDefaultsKey) == nil,
           let legacyUserAgent = defaults.string(forKey: Self.legacyUserAgentDefaultsKey) {
            defaults.set(legacyUserAgent, forKey: Self.userAgentDefaultsKey)
            defaults.removeObject(forKey: Self.legacyUserAgentDefaultsKey)
        }

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.httpCookieStorage = .shared
        session = URLSession(configuration: config)
    }

    func timeline(for username: String) async throws -> Timeline {
        let html = try await fetchHTML(path: "/" + username)
        return try TimelineParser.parse(html: html, baseURL: URL(string: baseURL)!)
    }

    // MARK: - Private

    private func fetchHTML(path: String) async throws -> String {
        var retriesRemaining = 3

        for attempt in 0..<4 {
            var request = URLRequest(url: URL(string: baseURL + path)!)
            request.setValue(userAgent, forHTTPHeaderField: "User-Agent")

            let (data, response) = try await session.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let html = String(decoding: data, as: UTF8.self)

            // 429 Rate Limited: exponential backoff + retry.
            if code == 429 {
                guard retriesRemaining > 0 else {
                    throw NitterError.rateLimited(
                        retryAfter: Self.parseRetryAfter(response)
                    )
                }
                retriesRemaining -= 1
                let retryAfter = Self.parseRetryAfter(response)
                let backoff = Self.backoff(attempt: attempt, retryAfter: retryAfter)
                try await Task.sleep(for: .seconds(backoff))
                continue
            }

            // Not rate limited — check for challenge.
            if !isChallenge(statusCode: code, html: html) {
                guard code == 200 else { throw NitterError.http(code) }
                return html
            }

            // Challenge: solve only on first attempt.
            guard attempt == 0 else { break }
            let solved = await ChallengeBootstrapper.shared.ensureSession(path: path)
            if !solved { throw NitterError.challengeFailed }
        }

        throw NitterError.rateLimited(retryAfter: nil)
    }

    private func isChallenge(statusCode: Int, html: String) -> Bool {
        statusCode == 503
            || html.contains("Verifying your request")
            || html.contains("javascript puzzle")
    }

    // MARK: - Backoff

    /// Exponential backoff: base * 2^attempt + jitter, clamped to Retry-After
    /// when the server provides one.
    static func backoff(attempt: Int, retryAfter: TimeInterval? = nil) -> TimeInterval {
        let base: TimeInterval = 2.0
        let exponential = base * pow(2.0, Double(attempt))
        let jitter = Double.random(in: 0...0.5)
        let computed = exponential + jitter
        if let retryAfter, retryAfter > 0 {
            return max(computed, retryAfter)
        }
        return computed
    }

    /// Parses the `Retry-After` header (seconds or HTTP-date).
    static func parseRetryAfter(_ response: URLResponse) -> TimeInterval? {
        guard let httpResponse = response as? HTTPURLResponse,
              let value = httpResponse.value(forHTTPHeaderField: "Retry-After") else {
            return nil
        }
        // Try numeric first.
        if let seconds = TimeInterval(value) { return seconds }
        // Try HTTP-date format.
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        if let date = formatter.date(from: value) {
            return max(0, date.timeIntervalSinceNow)
        }
        return nil
    }

    private var userAgent: String {
        UserDefaults.standard.string(forKey: Self.userAgentDefaultsKey)
            ?? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    }
}
