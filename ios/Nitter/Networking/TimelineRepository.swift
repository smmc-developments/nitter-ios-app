import Foundation

/// Coordinates the server API and `TimelineCache` with a stale-while-revalidate
/// policy: serve cached data instantly, then refresh from the server API.
struct TimelineRepository: Sendable {

    struct Cached: Sendable {
        let timeline: Timeline
        let fetchedAt: Date
        let isFresh: Bool
    }

    static let shared = TimelineRepository()

    private let server: APIClient
    private let cache: TimelineCache

    init(
        server: APIClient = .shared,
        cache: TimelineCache = .shared
    ) {
        self.server = server
        self.cache = cache
    }

    /// Cached timeline for `username` if present (never hits the network).
    func cached(for username: String) async -> Cached? {
        guard let entry = await cache.entry(for: username) else { return nil }
        let fresh = await cache.isFresh(entry)
        return Cached(timeline: entry.timeline, fetchedAt: entry.fetchedAt, isFresh: fresh)
    }

    /// Fetches the latest timeline from the server API, refreshing the cache.
    @discardableResult
    func fetch(for username: String) async throws -> Timeline {
        let tweets = try await server.fetchTimeline(for: username)
        let timeline = Timeline(tweets: tweets, account: nil)
        await cache.store(timeline, for: username)
        return timeline
    }

    /// Fetches the merged feed from the server API (all accounts combined).
    func fetchFeedFromServer(limit: Int = 50) async throws -> [Tweet] {
        try await server.fetchFeed(limit: limit)
    }
}
