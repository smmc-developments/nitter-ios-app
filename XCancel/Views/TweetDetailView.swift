import SwiftUI

struct TweetDetailView: View {
    let tweet: Tweet
    @State private var replies: [Tweet] = []
    @State private var isLoading = true
    @State private var failed = false
    @State private var selectedTweetURL: URL?

    var body: some View {
        List {
            Section {
                TweetCell(tweet: tweet)
            }

            if !replies.isEmpty {
                Section("Replies") {
                    ForEach(replies) { reply in
                        TweetCell(tweet: reply)
                            .contentShape(Rectangle())
                            .onTapGesture { selectedTweetURL = reply.statusURL }
                    }
                }
            } else if isLoading {
                Section { ProgressView("Loading replies…") }
            } else if failed {
                Section {
                    ContentUnavailableView(
                        "Couldn't Load Replies",
                        systemImage: "exclamationmark.triangle",
                        description: Text("The post is still available above.")
                    )
                }
            } else {
                Section {
                    ContentUnavailableView(
                        "No Replies",
                        systemImage: "bubble",
                        description: Text("No replies were found for this post.")
                    )
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Post")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .sheet(item: $selectedTweetURL) { url in
            SafariView(url: url).ignoresSafeArea()
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let detail = try await APIClient.shared.fetchTweetDetail(
                username: tweet.authorHandle,
                tweetId: tweet.id
            )
            replies = detail.replies
            failed = false
        } catch {
            failed = true
        }
    }
}
