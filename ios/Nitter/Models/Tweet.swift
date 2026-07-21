import Foundation

struct TweetPreview: Hashable, Sendable, Codable {
    let id: String
    let authorName: String
    let authorHandle: String
    let avatarURL: URL?
    let date: Date?
    let text: String
    let statusURL: URL?
}

struct Tweet: Identifiable, Hashable, Sendable, Codable {
    /// Status id as decimal string (stable across instances).
    let id: String
    let authorName: String
    /// Handle without the leading "@".
    let authorHandle: String
    let avatarURL: URL?
    let date: Date?
    let text: String
    /// Absolute URL of the status page on the Nitter instance.
    let statusURL: URL?
    let replyCount: Int
    let retweetCount: Int
    let likeCount: Int
    let viewCount: Int
    /// Thumbnail URLs for photos attached to the tweet.
    let photoURLs: [URL]
    /// Poster frame when the tweet contains a video/gif.
    let videoPosterURL: URL?
    /// Playable MP4 source for the video/gif.
    let videoURL: URL?
    /// Fullname of the retweeting account, when this is a retweet.
    let retweetedBy: String?
    let isPinned: Bool
    /// Text of a quoted tweet, if any.
    let quotedText: String?
    /// Handle of the quoted tweet's author, if any.
    let quotedHandle: String?
    /// Immediate parent tweet when this post is a reply.
    let parent: TweetPreview?

    init(
        id: String,
        authorName: String,
        authorHandle: String,
        avatarURL: URL? = nil,
        date: Date? = nil,
        text: String,
        statusURL: URL? = nil,
        replyCount: Int = 0,
        retweetCount: Int = 0,
        likeCount: Int = 0,
        viewCount: Int = 0,
        photoURLs: [URL] = [],
        videoPosterURL: URL? = nil,
        videoURL: URL? = nil,
        retweetedBy: String? = nil,
        isPinned: Bool = false,
        quotedText: String? = nil,
        quotedHandle: String? = nil,
        parent: TweetPreview? = nil
    ) {
        self.id = id
        self.authorName = authorName
        self.authorHandle = authorHandle
        self.avatarURL = avatarURL
        self.date = date
        self.text = text
        self.statusURL = statusURL
        self.replyCount = replyCount
        self.retweetCount = retweetCount
        self.likeCount = likeCount
        self.viewCount = viewCount
        self.photoURLs = photoURLs
        self.videoPosterURL = videoPosterURL
        self.videoURL = videoURL
        self.retweetedBy = retweetedBy
        self.isPinned = isPinned
        self.quotedText = quotedText
        self.quotedHandle = quotedHandle
        self.parent = parent
    }
}

/// Display info about a timeline's owner, recovered from the tweet markup.
struct AccountInfo: Sendable, Hashable, Codable {
    let handle: String
    let name: String
    let avatarURL: URL?
}

/// Result of parsing one Nitter timeline page.
struct Timeline: Sendable, Codable {
    var tweets: [Tweet]
    var account: AccountInfo?
}
