import Foundation

enum APIClientError: LocalizedError {
    case serverOffline
    case invalidResponse
    case httpError(Int)

    var errorDescription: String? {
        switch self {
        case .serverOffline: return "Server is not reachable"
        case .invalidResponse: return "Invalid response from server"
        case .httpError(let code): return "Server returned HTTP \(code)"
        }
    }
}

/// Client for the companion Node.js server that handles Nitter fetching
/// via a real Chrome browser, avoiding rate-limiting on the iOS device.
actor APIClient {
    static let shared = APIClient()

    /// Configurable base URL — defaults to localhost; override via
    /// UserDefaults key "server.baseURL" for LAN testing.
    var baseURL: String {
        SharedSettings.defaults.string(forKey: "server.baseURL")
            ?? "http://localhost:3000"
    }

    /// API key for the companion server. Set via UserDefaults "server.apiKey".
    var apiKey: String? {
        SharedSettings.defaults.string(forKey: "server.apiKey")
    }

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()

    private func authorizedRequest(_ url: URL, method: String = "GET") -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let key = apiKey {
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        return URLSession(configuration: config)
    }()

    private func endpoint(_ components: [String], queryItems: [URLQueryItem] = []) throws -> URL {
        guard var url = URL(string: baseURL),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host != nil,
              url.user == nil,
              url.password == nil else {
            throw APIClientError.invalidResponse
        }
        for component in components {
            url.appendPathComponent(component)
        }
        guard var result = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw APIClientError.invalidResponse
        }
        result.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let finalURL = result.url else { throw APIClientError.invalidResponse }
        return finalURL
    }

    // MARK: - Feed

    func fetchFeed(limit: Int = 50) async throws -> [Tweet] {
        let url = try endpoint(["api", "feed"], queryItems: [.init(name: "limit", value: String(limit))])
        let request = authorizedRequest(url)
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        let decoded = try decoder.decode(ServerTweetList.self, from: data)
        return decoded.tweets.map { $0.toTweet() }
    }

    // MARK: - Timeline

    func fetchTimeline(for username: String, limit: Int = 20) async throws -> [Tweet] {
        let url = try endpoint(["api", "timeline", username], queryItems: [.init(name: "limit", value: String(limit))])
        let request = authorizedRequest(url)
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        let decoded = try decoder.decode(ServerTweetList.self, from: data)
        return decoded.tweets.map { $0.toTweet() }
    }

    // MARK: - Accounts

    struct ServerAccount: Codable {
        let username: String
        let display_name: String?
        let avatar_url: String?
        let last_fetched_at: String?
        let fetch_error: String?
        let created_at: String?

        var lastFetchedDate: Date? {
            guard let last_fetched_at else { return nil }
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
            formatter.timeZone = TimeZone(identifier: "UTC")
            return formatter.date(from: last_fetched_at)
        }
    }

    private var cachedAccounts: [ServerAccount]?
    private var cachedAccountsAt: Date?

    func listAccounts(forceRefresh: Bool = false) async throws -> [ServerAccount] {
        if !forceRefresh, let cached = cachedAccounts, let at = cachedAccountsAt,
           Date.now.timeIntervalSince(at) < 60 {
            return cached
        }
        let url = try endpoint(["api", "accounts"])
        let request = authorizedRequest(url)
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        let accounts = try decoder.decode([ServerAccount].self, from: data)
        cachedAccounts = accounts
        cachedAccountsAt = .now
        return accounts
    }

    func addAccount(_ username: String) async throws -> ServerAccount {
        cachedAccounts = nil
        let url = try endpoint(["api", "accounts"])
        var request = authorizedRequest(url, method: "POST")
        request.httpBody = try JSONEncoder().encode(["username": username])
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        return try decoder.decode(ServerAccount.self, from: data)
    }

    func removeAccount(_ username: String) async throws {
        let url = try endpoint(["api", "accounts", username])
        let request = authorizedRequest(url, method: "DELETE")
        let (_, response) = try await session.data(for: request)
        try checkResponse(response)
        cachedAccounts = nil
    }

    // MARK: - Health

    func isServerOnline() async -> Bool {
        guard let url = try? endpoint(["health"]) else { return false }
        guard let (_, response) = try? await session.data(from: url) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    // MARK: - Trigger Fetch

    func triggerFetch() async throws {
        let url = try endpoint(["api", "fetch"])
        let request = authorizedRequest(url, method: "POST")
        let (_, response) = try await session.data(for: request)
        try checkResponse(response)
    }

    // MARK: - Tweet Detail

    struct TweetDetail: Decodable {
        let tweet: ServerTweet?
        let replies: [ServerTweet]
    }

    func fetchTweetDetail(username: String, tweetId: String) async throws -> (tweet: Tweet, replies: [Tweet]) {
        let url = try endpoint(["api", "tweet", username, tweetId])
        let request = authorizedRequest(url)
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        let decoded = try decoder.decode(TweetDetail.self, from: data)
        guard let mainTweet = decoded.tweet else {
            throw APIClientError.invalidResponse
        }
        return (mainTweet.toTweet(), decoded.replies.map { $0.toTweet() })
    }

    // MARK: - Private

    private func checkResponse(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            throw APIClientError.httpError(http.statusCode)
        }
    }
}

// MARK: - Server JSON models

/// Mirrors the JSON shape returned by the Node.js server's formatTweet().
/// Uses String for dates and URLs because the server sends them as strings,
/// not ISO8601-encoded values.
struct ServerTweet: Decodable {
    let id: String
    let authorName: String
    let authorHandle: String
    let avatarURL: String?
    let date: String?
    let text: String
    let statusURL: String?
    let replyCount: Int
    let retweetCount: Int
    let likeCount: Int
    let viewCount: Int
    let photoURLs: [String]
    let videoPosterURL: String?
    let videoURL: String?
    let retweetedBy: String?
    let isPinned: Bool
    let quotedText: String?
    let quotedHandle: String?
    let parent: ServerTweetPreview?

    enum CodingKeys: String, CodingKey {
        case id
        case authorName, authorHandle, avatarURL
        case date, text, statusURL
        case replyCount, retweetCount, likeCount, viewCount
        case photoURLs, videoPosterURL, videoURL, retweetedBy
        case isPinned, quotedText, quotedHandle, parent
    }

    func toTweet() -> Tweet {
        Tweet(
            id: id,
            authorName: authorName,
            authorHandle: authorHandle,
            avatarURL: avatarURL.flatMap(URL.init(string:)),
            date: date.flatMap(Self.parseDate),
            text: text,
            statusURL: statusURL.flatMap(URL.init(string:)),
            replyCount: replyCount,
            retweetCount: retweetCount,
            likeCount: likeCount,
            viewCount: viewCount,
            photoURLs: photoURLs.compactMap(URL.init(string:)),
            videoPosterURL: videoPosterURL.flatMap(URL.init(string:)),
            videoURL: videoURL.flatMap(URL.init(string:)),
            retweetedBy: retweetedBy,
            isPinned: isPinned,
            quotedText: quotedText,
            quotedHandle: quotedHandle,
            parent: parent?.toTweetPreview()
        )
    }

    /// Parse the date format used by Nitter: "Jul 20, 2026 · 5:15 AM UTC"
    static func parseDate(_ s: String) -> Date? {
        let fractionalISO8601 = ISO8601DateFormatter()
        fractionalISO8601.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractionalISO8601.date(from: s) { return date }
        if let date = ISO8601DateFormatter().date(from: s) { return date }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MMM d, yyyy · h:mm a 'UTC'"
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.date(from: s)
    }
}

struct ServerTweetPreview: Decodable {
    let id: String
    let authorName: String
    let authorHandle: String
    let avatarURL: String?
    let date: String?
    let text: String
    let statusURL: String?

    func toTweetPreview() -> TweetPreview {
        TweetPreview(
            id: id,
            authorName: authorName,
            authorHandle: authorHandle,
            avatarURL: avatarURL.flatMap(URL.init(string:)),
            date: date.flatMap(ServerTweet.parseDate),
            text: text,
            statusURL: statusURL.flatMap(URL.init(string:))
        )
    }
}

private struct ServerTweetList: Decodable {
    let tweets: [ServerTweet]
}
