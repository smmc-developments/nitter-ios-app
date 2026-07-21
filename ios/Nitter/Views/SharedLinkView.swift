import SwiftUI

enum SharedXLink: Identifiable, Equatable {
    case profile(username: String)
    case tweet(username: String, id: String)

    var id: String {
        switch self {
        case .profile(let username): "profile:\(username)"
        case .tweet(let username, let id): "tweet:\(username):\(id)"
        }
    }

    init?(deepLink: URL) {
        guard deepLink.scheme?.lowercased() == "nitter",
              deepLink.host?.lowercased() == "open",
              let components = URLComponents(url: deepLink, resolvingAgainstBaseURL: false),
              let value = components.queryItems?.first(where: { $0.name == "url" })?.value,
              let sourceURL = URL(string: value) else {
            return nil
        }
        self.init(sourceURL: sourceURL)
    }

    init?(sourceURL: URL) {
        let supportedHosts = ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]
        guard let host = sourceURL.host?.lowercased(), supportedHosts.contains(host) else {
            return nil
        }

        let parts = sourceURL.pathComponents.filter { $0 != "/" }
        let reservedPaths = ["compose", "explore", "home", "i", "intent", "messages", "notifications", "search", "settings"]
        guard let username = parts.first,
              !reservedPaths.contains(username.lowercased()),
              username.range(of: "^[A-Za-z0-9_]{1,15}$", options: .regularExpression) != nil else {
            return nil
        }

        if parts.count >= 3,
           parts[1].lowercased() == "status",
           parts[2].allSatisfy(\.isNumber) {
            self = .tweet(username: username.lowercased(), id: parts[2])
        } else if parts.count == 1 {
            self = .profile(username: username.lowercased())
        } else {
            return nil
        }
    }
}

struct SharedLinkView: View {
    let link: SharedXLink
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            switch link {
            case .profile(let username):
                AccountFeedView(username: username)
            case .tweet(let username, let id):
                SharedTweetLoader(username: username, tweetID: id)
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { dismiss() }
            }
        }
    }
}

private struct SharedTweetLoader: View {
    let username: String
    let tweetID: String
    @State private var tweet: Tweet?
    @State private var failed = false

    var body: some View {
        Group {
            if let tweet {
                TweetDetailView(tweet: tweet)
            } else if failed {
                ContentUnavailableView(
                    "Couldn't Open Post",
                    systemImage: "exclamationmark.triangle",
                    description: Text("Check the server connection and try sharing the link again.")
                )
            } else {
                ProgressView("Opening post…")
            }
        }
        .task {
            do {
                tweet = try await APIClient.shared.fetchTweetDetail(
                    username: username,
                    tweetId: tweetID
                ).tweet
            } catch {
                failed = true
            }
        }
    }
}
