import Foundation

/// Coordinates the server API, `XCancelClient`, and `TimelineCache` with a
/// stale-while-revalidate policy: serve cached data instantly, then try the
/// server API first, falling back to direct xcancel access if offline.
struct TimelineRepository: Sendable {

    struct Cached: Sendable {
        let timeline: Timeline
        let fetchedAt: Date
        let isFresh: Bool
    }

    static let shared = TimelineRepository()

    private let server: APIClient
    private let client: XCancelClient
    private let cache: TimelineCache

    init(
        server: APIClient = .shared,
        client: XCancelClient = .shared,
        cache: TimelineCache = .shared
    ) {
        self.server = server
        self.client = client
        self.cache = cache
    }

    /// Cached timeline for `username` if present (never hits the network).
    func cached(for username: String) async -> Cached? {
        guard let entry = await cache.entry(for: username) else { return nil }
        let fresh = await cache.isFresh(entry)
        return Cached(timeline: entry.timeline, fetchedAt: entry.fetchedAt, isFresh: fresh)
    }

    /// Fetches the latest timeline, preferring the server API and falling
    /// back to direct xcancel access if the server is offline.
    @discardableResult
    func fetch(for username: String) async throws -> Timeline {
        // Try the server first.
        if await server.isServerOnline() {
            do {
                let tweets = try await server.fetchTimeline(for: username)
                let timeline = Timeline(tweets: tweets, account: nil)
                await cache.store(timeline, for: username)
                return timeline
            } catch {
                // Server fetch failed — fall through to direct.
            }
        }

        // Fallback: direct xcancel.com access.
        let timeline = try await client.timeline(for: username)
        await cache.store(timeline, for: username)
        return timeline
    }

    /// Fetches the merged feed from the server API (all accounts combined).
    func fetchFeedFromServer(limit: Int = 50) async throws -> [Tweet] {
        try await server.fetchFeed(limit: limit)
    }
}
