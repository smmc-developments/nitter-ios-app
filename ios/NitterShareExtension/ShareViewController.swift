import SwiftUI
import UIKit
import UniformTypeIdentifiers

@MainActor
final class ShareModel: ObservableObject {
    @Published var sourceURL: URL?
    @Published var errorMessage: String?
}

final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()

        let reader = ShareReaderView(model: model) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
        let host = UIHostingController(rootView: reader)
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)

        loadSharedURL()
    }

    private func loadSharedURL() {
        let providers = extensionContext?.inputItems
            .compactMap { $0 as? NSExtensionItem }
            .flatMap { $0.attachments ?? [] } ?? []

        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }) {
            provider.loadItem(forTypeIdentifier: UTType.url.identifier) { [weak self] item, _ in
                let url = item as? URL ?? (item as? NSURL).map { $0 as URL }
                Task { @MainActor in self?.accept(url) }
            }
            return
        }

        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) }) {
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { [weak self] item, _ in
                let url = Self.firstURL(in: item as? String)
                Task { @MainActor in self?.accept(url) }
            }
            return
        }

        accept(nil)
    }

    private func accept(_ url: URL?) {
        guard let url, ShareRoute(url: url) != nil else {
            model.errorMessage = "Share an x.com or twitter.com profile or post link."
            return
        }
        model.sourceURL = url
    }

    private static func firstURL(in text: String?) -> URL? {
        guard let text,
              let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue),
              let match = detector.firstMatch(
                in: text,
                range: NSRange(text.startIndex..., in: text)
              ) else {
            return nil
        }
        return match.url
    }
}

private enum ShareRoute {
    case profile(username: String)
    case tweet(username: String, id: String)

    init?(url: URL) {
        let hosts = ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]
        guard let host = url.host?.lowercased(), hosts.contains(host) else { return nil }

        let parts = url.pathComponents.filter { $0 != "/" }
        let reserved = ["compose", "explore", "home", "i", "intent", "messages", "notifications", "search", "settings"]
        guard let username = parts.first,
              !reserved.contains(username.lowercased()),
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

private struct ShareReaderView: View {
    @ObservedObject var model: ShareModel
    let done: () -> Void
    @State private var tweets: [SharedTweet] = []
    @State private var isLoading = false
    @State private var loadError: String?

    var body: some View {
        NavigationStack {
            Group {
                if let message = model.errorMessage ?? loadError {
                    ContentUnavailableView(
                        "Couldn't Open Link",
                        systemImage: "exclamationmark.triangle",
                        description: Text(message)
                    )
                } else if isLoading || model.sourceURL == nil {
                    ProgressView("Loading…")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 16) {
                            ForEach(tweets) { tweet in
                                SharedTweetView(tweet: tweet)
                                Divider()
                            }
                        }
                        .padding()
                    }
                }
            }
            .navigationTitle("Nitter")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done", action: done)
                }
            }
        }
        .task(id: model.sourceURL) {
            guard let sourceURL = model.sourceURL,
                  let route = ShareRoute(url: sourceURL) else { return }
            await load(route)
        }
    }

    private func load(_ route: ShareRoute) async {
        isLoading = true
        loadError = nil
        defer { isLoading = false }

        do {
            let baseURL = SharedSettings.defaults.string(forKey: "server.baseURL")
                ?? "http://localhost:3000"
            var url = try validURL(baseURL)
            switch route {
            case .profile(let username):
                for component in ["api", "timeline", username] {
                    url.append(path: component)
                }
                url.append(queryItems: [URLQueryItem(name: "limit", value: "20")])
                let response: SharedTweetList = try await request(url)
                tweets = response.tweets
            case .tweet(let username, let id):
                for component in ["api", "tweet", username, id] {
                    url.append(path: component)
                }
                let response: SharedTweetDetail = try await request(url)
                guard let tweet = response.tweet else { throw ShareError.invalidResponse }
                tweets = [tweet] + response.replies
            }
        } catch {
            loadError = "Check Nitter's server URL and API key, then try again."
        }
    }

    private func validURL(_ value: String) throws -> URL {
        guard let url = URL(string: value), url.scheme != nil, url.host != nil else {
            throw ShareError.invalidResponse
        }
        return url
    }

    private func request<Response: Decodable>(_ url: URL) async throws -> Response {
        var request = URLRequest(url: url)
        if let apiKey = SharedSettings.defaults.string(forKey: "server.apiKey"), !apiKey.isEmpty {
            request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw ShareError.invalidResponse
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }
}

private struct SharedTweetView: View {
    let tweet: SharedTweet

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                AsyncImage(url: tweet.avatarURL) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Image(systemName: "person.crop.circle.fill")
                        .resizable()
                        .foregroundStyle(.tertiary)
                }
                .frame(width: 40, height: 40)
                .clipShape(Circle())

                VStack(alignment: .leading, spacing: 2) {
                    Text(tweet.authorName).fontWeight(.semibold)
                    Text("@\(tweet.authorHandle)").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }

            Text(tweet.text)
                .frame(maxWidth: .infinity, alignment: .leading)

            ForEach(tweet.photoURLs.prefix(4), id: \.absoluteString) { url in
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFit()
                } placeholder: {
                    ProgressView()
                }
                .frame(maxWidth: .infinity)
                .frame(height: 220)
            }

            if tweet.photoURLs.isEmpty, let poster = tweet.videoPosterURL {
                AsyncImage(url: poster) { image in
                    image.resizable().scaledToFit()
                } placeholder: {
                    ProgressView()
                }
                .frame(maxWidth: .infinity)
                .frame(height: 220)
            }
        }
    }
}

private struct SharedTweet: Decodable, Identifiable {
    let id: String
    let authorName: String
    let authorHandle: String
    let avatarURL: URL?
    let text: String
    let photoURLs: [URL]
    let videoPosterURL: URL?
}

private struct SharedTweetList: Decodable {
    let tweets: [SharedTweet]
}

private struct SharedTweetDetail: Decodable {
    let tweet: SharedTweet?
    let replies: [SharedTweet]
}

private enum ShareError: Error {
    case invalidResponse
}
