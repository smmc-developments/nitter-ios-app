import SwiftUI

/// Timeline for a single account (pushed from the Accounts tab).
struct AccountFeedView: View {
    let username: String

    @State private var tweets: [Tweet] = []
    @State private var isLoading = true
    @State private var failed = false
    @State private var selectedTweet: Tweet?

    private let repository = TimelineRepository.shared

    var body: some View {
        Group {
            if isLoading && tweets.isEmpty {
                ProgressView("Loading @\(username)…")
            } else if failed {
                ContentUnavailableView(
                    "Couldn't Load",
                    systemImage: "exclamationmark.triangle",
                    description: Text("xcancel.com returned an error for @\(username).")
                )
            } else if tweets.isEmpty {
                ContentUnavailableView("No Posts", systemImage: "tray")
            } else {
                List(tweets) { tweet in
                    TweetCell(tweet: tweet)
                        .contentShape(Rectangle())
                        .onTapGesture { selectedTweet = tweet }
                }
                .listStyle(.plain)
                .refreshable { await load(force: true) }
            }
        }
        .navigationTitle("@\(username)")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $selectedTweet) { tweet in
            TweetDetailView(tweet: tweet)
        }
        .task { await load() }
    }

    private func load(force: Bool = false) async {
        isLoading = tweets.isEmpty
        defer { isLoading = false }

        // Show cache instantly; skip the network entirely when still fresh.
        if !force, let cached = await repository.cached(for: username) {
            tweets = cached.timeline.tweets
            if cached.isFresh { return }
        }

        do {
            tweets = try await repository.fetch(for: username).tweets
            failed = false
        } catch {
            // Only show an error state when there's nothing cached to display.
            failed = tweets.isEmpty
        }
    }
}
