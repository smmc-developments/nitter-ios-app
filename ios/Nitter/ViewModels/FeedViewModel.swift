import Foundation

/// Loads the feed from the server's batch endpoint (single request for all
/// accounts), falling back to per-account direct Nitter fetches when offline.
@MainActor
@Observable
final class FeedViewModel {
    private(set) var tweets: [Tweet] = []
    private(set) var failedAccounts: [String] = []
    private(set) var isLoading = false
    private(set) var dataUpdatedAt: Date?

    private let repository: TimelineRepository

    init(repository: TimelineRepository = .shared) {
        self.repository = repository
    }

    func load(usernames: [String], force: Bool = false) async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        // Try the batch endpoint first — single request for everything.
        do {
            let serverTweets = try await APIClient.shared.fetchFeed(limit: 500)
            if !serverTweets.isEmpty || usernames.isEmpty {
                tweets = serverTweets.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
                dataUpdatedAt = .now
                failedAccounts = []
                return
            }
        } catch {
            // Server offline — fall through to per-account.
        }

        // Fallback: per-account fetch via direct Nitter access.
        var allTimelines: [Timeline] = []
        var failed: [String] = []

        for username in usernames {
            do {
                let timeline = try await repository.fetch(for: username)
                allTimelines.append(timeline)
            } catch {
                if let cached = await repository.cached(for: username) {
                    allTimelines.append(cached.timeline)
                } else {
                    failed.append(username)
                }
            }
        }

        if !allTimelines.isEmpty {
            tweets = Self.merge(allTimelines)
            dataUpdatedAt = .now
        }
        failedAccounts = failed
    }

    static func merge(_ timelines: [Timeline]) -> [Tweet] {
        var seen = Set<String>()
        return timelines
            .flatMap(\.tweets)
            .sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
            .filter { seen.insert($0.id).inserted }
    }
}
