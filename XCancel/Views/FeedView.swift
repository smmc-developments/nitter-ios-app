import SwiftUI

struct FeedView: View {
    @State private var viewModel = FeedViewModel()
    @State private var selectedTweet: Tweet?
    @State private var showFetchSent = false
    @State private var accounts: [APIClient.ServerAccount] = []

    var body: some View {
        NavigationStack {
            Group {
                if accounts.isEmpty && !viewModel.isLoading {
                    ContentUnavailableView(
                        "No Accounts",
                        systemImage: "person.2.badge.plus",
                        description: Text("Add accounts in the Accounts tab to build your feed.")
                    )
                } else if viewModel.tweets.isEmpty && viewModel.isLoading {
                    ProgressView("Loading feed…")
                } else if viewModel.tweets.isEmpty {
                    ContentUnavailableView(
                        "No Posts",
                        systemImage: "tray",
                        description: Text(viewModel.failedAccounts.isEmpty
                            ? "Pull down to refresh."
                            : "Couldn't load any timeline right now.")
                    )
                } else {
                    feedList
                }
            }
            .refreshable { await load(force: true) }
            .navigationTitle("Feed")
            .navigationDestination(item: $selectedTweet) { tweet in
                TweetDetailView(tweet: tweet)
            }
            .toolbar {
                if viewModel.isLoading && !viewModel.tweets.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) { ProgressView() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Fetch", systemImage: "arrow.clockwise") {
                        Task {
                            do {
                                try await APIClient.shared.triggerFetch()
                                showFetchSent = true
                                try? await Task.sleep(for: .seconds(3))
                                await load(force: true)
                            } catch {
                                showFetchSent = true
                            }
                        }
                    }
                    .disabled(viewModel.isLoading)
                }
            }
            .alert("Server Fetch", isPresented: $showFetchSent) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("Fetch request sent to the server.")
            }
            .task { await load() }
        }
    }

    private var feedList: some View {
        List {
            if !viewModel.failedAccounts.isEmpty {
                Section {
                    Label(
                        "Couldn't load: \(viewModel.failedAccounts.map { "@\($0)" }.joined(separator: ", "))",
                        systemImage: "exclamationmark.triangle"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
            }
            ForEach(viewModel.tweets) { tweet in
                TweetCell(tweet: tweet)
                    .contentShape(Rectangle())
                    .onTapGesture { selectedTweet = tweet }
            }
            if let updated = viewModel.dataUpdatedAt {
                Section {
                    HStack {
                        Spacer()
                        Text("Updated ") + Text(updated, style: .relative)
                        Spacer()
                    }
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .listRowBackground(Color.clear)
                }
            }
        }
        .listStyle(.plain)
    }

    private func load(force: Bool = false) async {
        do {
            accounts = try await APIClient.shared.listAccounts(forceRefresh: force)
        } catch {
            accounts = []
        }
        let usernames = accounts.map(\.username)
        await viewModel.load(usernames: usernames, force: force)
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}
