import SwiftUI
import UIKit
import AVKit

struct TweetCell: View {
    let tweet: Tweet

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let retweetedBy = tweet.retweetedBy {
                Label("\(retweetedBy) reposted", systemImage: "arrow.2.squarepath")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if tweet.isPinned {
                Label("Pinned", systemImage: "pin.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(alignment: .top, spacing: 10) {
                avatar
                VStack(alignment: .leading, spacing: 4) {
                    headerRow
                    if let parent = tweet.parent {
                        parentPreview(parent)
                    }
                    LinkedText(value: tweet.text)
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)

                    if let quotedText = tweet.quotedText {
                        VStack(alignment: .leading, spacing: 2) {
                            if let handle = tweet.quotedHandle {
                                Text("@\(handle)").font(.caption).fontWeight(.semibold)
                            }
                            LinkedText(value: quotedText).font(.callout)
                        }
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
                    }

                    media
                    statsRow
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func parentPreview(_ parent: TweetPreview) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Replying to")
                .font(.caption2)
                .foregroundStyle(.tertiary)
            HStack(alignment: .top, spacing: 8) {
                CachedAsyncImage(url: parent.avatarURL) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Image(systemName: "person.crop.circle.fill")
                        .resizable()
                        .foregroundStyle(.tertiary)
                }
                .frame(width: 28, height: 28)
                .clipShape(Circle())

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(parent.authorName)
                            .font(.caption)
                            .fontWeight(.semibold)
                            .lineLimit(1)
                        Text("@\(parent.authorHandle)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer(minLength: 2)
                        if let date = parent.date {
                            Text(date, style: .relative)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    LinkedText(value: parent.text)
                        .font(.callout)
                        .lineLimit(5)
                }
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color("CellFill"))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
        .cornerRadius(8)
    }

    private var avatar: some View {
        CachedAsyncImage(url: tweet.avatarURL) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            Image(systemName: "person.crop.circle.fill")
                .resizable()
                .foregroundStyle(.tertiary)
        }
        .frame(width: 44, height: 44)
        .clipShape(Circle())
    }

    private var headerRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(tweet.authorName).fontWeight(.semibold).lineLimit(1)
            Text("@\(tweet.authorHandle)")
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 4)
            if let date = tweet.date {
                Text(date, style: .relative)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var media: some View {
        if !tweet.photoURLs.isEmpty {
            let columns = tweet.photoURLs.count == 1
                ? [GridItem(.flexible())]
                : [GridItem(.flexible(), spacing: 4), GridItem(.flexible(), spacing: 4)]
            LazyVGrid(columns: columns, spacing: 4) {
                ForEach(tweet.photoURLs.prefix(4), id: \.absoluteString) { url in
                    CachedAsyncImage(url: url) { image in
                        image
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: .infinity)
                    } placeholder: {
                        Color("MediaPlaceholder")
                            .frame(height: tweet.photoURLs.count == 1 ? 220 : 110)
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                    .background(Color("MediaCellFill"))
                    .cornerRadius(8)
                }
            }
        } else if let poster = tweet.videoPosterURL {
            TweetVideoView(posterURL: poster, videoURL: tweet.videoURL)
        }
    }

    private var statsRow: some View {
        HStack(spacing: 20) {
            statView(systemImage: "bubble", count: tweet.replyCount)
            statView(systemImage: "arrow.2.squarepath", count: tweet.retweetCount)
            statView(systemImage: "heart", count: tweet.likeCount)
            statView(systemImage: "eye", count: tweet.viewCount)
            Spacer()
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private func statView(systemImage: String, count: Int) -> some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage)
            if count > 0 { Text(count.formatted()) }
        }
    }
}

private struct TweetVideoView: View {
    let posterURL: URL
    let videoURL: URL?
    @State private var isPlaying = false

    var body: some View {
        Button {
            if videoURL != nil { isPlaying = true }
        } label: {
            CachedAsyncImage(url: posterURL) { image in
                image
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 320)
            } placeholder: {
                Color("MediaPlaceholder")
                    .frame(height: 200)
            }
            .frame(maxWidth: .infinity, alignment: .center)
            .cornerRadius(8)
            .overlay {
                if videoURL != nil {
                    Image(systemName: "play.circle.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(.white.opacity(0.9))
                        .shadow(radius: 2)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(videoURL == nil)
        .fullScreenCover(isPresented: $isPlaying) {
            if let videoURL {
                VideoPlaybackView(url: videoURL)
            }
        }
    }
}

private struct VideoPlaybackView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer

    init(url: URL) {
        _player = State(initialValue: AVPlayer(url: url))
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            VideoPlayer(player: player)
                .ignoresSafeArea()
            Button("Done") { dismiss() }
                .buttonStyle(.borderedProminent)
                .padding()
        }
        .onAppear { player.play() }
        .onDisappear { player.pause() }
    }
}

struct CachedAsyncImage<Content: View, Placeholder: View>: View {
    let url: URL?
    @ViewBuilder let content: (Image) -> Content
    @ViewBuilder let placeholder: () -> Placeholder
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                content(Image(uiImage: image))
            } else {
                placeholder()
            }
        }
        .task(id: url) {
            image = nil
            guard let url else { return }
            image = await RemoteImageStore.shared.image(for: url)
        }
    }
}

private actor RemoteImageStore {
    static let shared = RemoteImageStore()

    private let cache = NSCache<NSURL, UIImage>()
    private var inFlight: [URL: Task<UIImage?, Never>] = [:]

    private init() {
        cache.totalCostLimit = 64 * 1024 * 1024
        cache.countLimit = 300
    }

    func image(for url: URL) async -> UIImage? {
        if let cached = cache.object(forKey: url as NSURL) {
            return cached
        }
        if let task = inFlight[url] {
            return await task.value
        }

        let task = Task<UIImage?, Never> {
            var request = URLRequest(url: url)
            request.cachePolicy = .returnCacheDataElseLoad
            guard let (data, response) = try? await URLSession.shared.data(for: request),
                  let http = response as? HTTPURLResponse,
                  (200...299).contains(http.statusCode) else {
                return nil
            }
            return UIImage(data: data)
        }
        inFlight[url] = task
        let loaded = await task.value
        inFlight[url] = nil

        if let loaded {
            let cost = loaded.cgImage.map { $0.bytesPerRow * $0.height } ?? 0
            cache.setObject(loaded, forKey: url as NSURL, cost: cost)
        }
        return loaded
    }
}
