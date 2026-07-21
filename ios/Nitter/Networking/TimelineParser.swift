import Foundation
import SwiftSoup

/// Parses Nitter timeline pages into `Timeline` values.
///
/// Selectors follow the upstream templates (`views/tweet.nim`,
/// `views/timeline.nim`, `views/renderutils.nim`), e.g.:
///   div.timeline > div.timeline-item[data-username]
///     a.tweet-link[href="/<user>/status/<id>#m"]
///     div.tweet-body
///       div.tweet-header (avatar, fullname, username, tweet-date title)
///       div.tweet-content
///       div.attachments > .attachment (a.still-image img, video[poster])
///       div.quote (optional)
///       div.tweet-stats > span.tweet-stat (icon-comment/-retweet/-heart/-views)
enum TimelineParser {

    static func parse(html: String, baseURL: URL) throws -> Timeline {
        let doc = try SwiftSoup.parse(html, baseURL.absoluteString)

        var tweets: [Tweet] = []
        // Prefer the page's profile card: the first timeline item is often a
        // retweet, so its header names a different account.
        var account = profileAccount(in: doc, baseURL: baseURL)

        for item in try doc.select("div.timeline-item") {
            // Skip "load more", "more replies" and tombstone rows.
            guard let body = try item.select("div.tweet-body").first(),
                  let content = try body.select("div.tweet-content").first() else {
                continue
            }

            let header = try body.select("div.tweet-header").first()

            let name = try header?.select("a.fullname").first()?.text()
                ?? item.attr("data-username")
            let handle = try header?.select("a.username").first()?.text()
                .replacingOccurrences(of: "@", with: "")
                ?? item.attr("data-username")

            if account == nil, !handle.isEmpty {
                account = AccountInfo(
                    handle: handle,
                    name: name,
                    avatarURL: avatarURL(in: header, baseURL: baseURL)
                )
            }

            let statusPath = try item.select("a.tweet-link").first()?.attr("href")
                ?? (try header?.select(".tweet-date a").first()?.attr("href"))
                ?? ""
            let id = statusID(from: statusPath) ?? UUID().uuidString

            let text = normalizedText(of: content, baseURL: baseURL)

            tweets.append(Tweet(
                id: id,
                authorName: name,
                authorHandle: handle,
                avatarURL: avatarURL(in: header, baseURL: baseURL),
                date: date(in: header),
                text: text,
                statusURL: absoluteURL(statusPath, baseURL: baseURL, stripFragment: true),
                replyCount: try stat(in: body, icon: "icon-comment"),
                retweetCount: try stat(in: body, icon: "icon-retweet"),
                likeCount: try stat(in: body, icon: "icon-heart"),
                viewCount: try stat(in: body, icon: "icon-views"),
                photoURLs: try photoURLs(in: body, baseURL: baseURL),
                videoPosterURL: try videoPoster(in: body, baseURL: baseURL),
                videoURL: try videoURL(in: body, baseURL: baseURL),
                retweetedBy: retweetedBy(in: body),
                isPinned: try !body.select(".pinned").isEmpty(),
                quotedText: try body.select(".quote .quote-text").first().map {
                    normalizedText(of: $0, baseURL: baseURL)
                },
                quotedHandle: try body.select(".quote a.username").first()?.text()
                    .replacingOccurrences(of: "@", with: "")
            ))
        }

        return Timeline(tweets: tweets, account: account)
    }

    // MARK: - Pieces

    /// Account info from the profile card header (`.profile-card`), if present.
    private static func profileAccount(in doc: Document, baseURL: URL) -> AccountInfo? {
        guard let card = try? doc.select(".profile-card").first(),
              let handle = try? card.select(".profile-card-username").first()?.text()
                .replacingOccurrences(of: "@", with: ""),
              !handle.isEmpty else { return nil }
        let name = (try? card.select(".profile-card-fullname").first()?.text()) ?? handle
        let avatar = (try? card.select(".profile-card-avatar img").first()?.attr("src"))
            .flatMap { absoluteURL($0, baseURL: baseURL) }
        return AccountInfo(handle: handle, name: name, avatarURL: avatar)
    }

    private static func statusID(from path: String) -> String? {
        guard let range = path.range(of: #"/status/(\d+)"#, options: .regularExpression) else {
            return nil
        }
        let digits = path[range].dropFirst("/status/".count)
        return String(digits.prefix(while: \.isNumber))
    }

    private static func absoluteURL(_ path: String, baseURL: URL, stripFragment: Bool = false) -> URL? {
        guard !path.isEmpty else { return nil }
        var url = URL(string: path, relativeTo: baseURL)?.absoluteURL
        if stripFragment {
            url = url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
                .map { components -> URL? in
                    var c = components
                    c.fragment = nil
                    return c.url
                } ?? nil
        }
        return url
    }

    private static func avatarURL(in header: Element?, baseURL: URL) -> URL? {
        guard let src = try? header?.select(".tweet-avatar img").first()?.attr("src") else {
            return nil
        }
        return absoluteURL(src, baseURL: baseURL)
    }

    /// Title attribute of the date link, e.g. "Jul 17, 2026 · 8:15 PM UTC".
    private static func date(in header: Element?) -> Date? {
        guard let title = try? header?.select(".tweet-date a").first()?.attr("title"),
              !title.isEmpty else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "MMM d, yyyy '·' h:mm a 'UTC'"
        return formatter.date(from: title)
    }

    private static func stat(in body: Element, icon: String) throws -> Int {
        for stat in try body.select(".tweet-stats .tweet-stat") {
            guard try !stat.select("." + icon).isEmpty() else { continue }
            let raw = try stat.text()
                .replacingOccurrences(of: ",", with: "")
                .trimmingCharacters(in: .whitespaces)
            return Int(raw) ?? 0
        }
        return 0
    }

    /// Direct `.attachments` children of the tweet body (quoted tweets have
    /// their own nested `.attachments`, which we intentionally skip).
    private static func ownAttachments(in body: Element) -> [Element] {
        body.children().filter { $0.hasClass("attachments") }
    }

    private static func photoURLs(in body: Element, baseURL: URL) throws -> [URL] {
        var urls: [URL] = []
        for attachments in ownAttachments(in: body) {
            for img in try attachments.select(".attachment a.still-image img") {
                if let url = absoluteURL(try img.attr("src"), baseURL: baseURL) {
                    urls.append(url)
                }
            }
        }
        return urls
    }

    private static func videoPoster(in body: Element, baseURL: URL) throws -> URL? {
        for attachments in ownAttachments(in: body) {
            if let poster = try attachments.select(".attachment video").first()?.attr("poster"),
               !poster.isEmpty {
                return absoluteURL(poster, baseURL: baseURL)
            }
        }
        return nil
    }

    private static func videoURL(in body: Element, baseURL: URL) throws -> URL? {
        for attachments in ownAttachments(in: body) {
            guard let video = try attachments.select(".attachment video").first() else { continue }
            let source = try video.select("source[type=video/mp4]").first()?.attr("src")
                ?? (try video.select("source").first()?.attr("src"))
                ?? (try video.attr("src"))
            if !source.isEmpty {
                return absoluteURL(source, baseURL: baseURL)
            }
        }
        return nil
    }

    private static func retweetedBy(in body: Element) -> String? {
        guard let text = try? body.select(".retweet-header").first()?.text(),
              !text.isEmpty else { return nil }
        return text.replacingOccurrences(of: " retweeted", with: "")
    }

    // MARK: - Text extraction (preserves line breaks)

    private static func normalizedText(of element: Element, baseURL: URL) -> String {
        innerText(of: element, baseURL: baseURL)
            .replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func innerText(of node: Node, baseURL: URL) -> String {
        var result = ""
        for child in node.getChildNodes() {
            if let text = child as? TextNode {
                result += text.getWholeText()
            } else if let element = child as? Element {
                if element.tagName() == "br" {
                    result += "\n"
                } else {
                    let label = innerText(of: element, baseURL: baseURL)
                    result += element.tagName() == "a"
                        ? expandedLinkText(element: element, label: label, baseURL: baseURL)
                        : label
                }
            }
        }
        return result
    }

    private static func expandedLinkText(element: Element, label: String, baseURL: URL) -> String {
        guard label.contains(".") || label.contains("…") || label.contains("..."),
              let href = try? element.attr("href"),
              let url = URL(string: href, relativeTo: baseURL)?.absoluteURL else {
            return label
        }
        if url.host != baseURL.host { return url.absoluteString }
        guard url.path == "/redirect",
              let target = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "url" })?.value,
              let targetURL = URL(string: target) else {
            return label
        }
        return targetURL.absoluteString
    }
}
