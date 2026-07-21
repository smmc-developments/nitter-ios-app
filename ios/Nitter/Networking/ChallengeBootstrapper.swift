import Foundation
import WebKit
import UIKit

/// Solves the Nitter instance's JavaScript anti-bot challenge by loading a page in a
/// real (hidden) `WKWebView`. WebKit executes the challenge JS, the site sets
/// session cookies, and we harvest them into `HTTPCookieStorage.shared` so
/// plain `URLSession` requests (and `AsyncImage`) are authorized afterwards.
///
/// The default WK website data store is used so a solved session survives app
/// relaunches for the lifetime of the cookies.
@MainActor
final class ChallengeBootstrapper {
    static let shared = ChallengeBootstrapper()

    private var webView: WKWebView?
    private var isSolving = false

    private init() {}

    /// Loads `path` in a hidden web view and waits until the anti-bot
    /// challenge (if any) has been solved, then syncs cookies + user agent.
    /// Returns `true` when a session is ready.
    @discardableResult
    func ensureSession(path: String) async -> Bool {
        // Coalesce concurrent callers: wait for an in-flight solve.
        while isSolving {
            try? await Task.sleep(for: .milliseconds(200))
            if Task.isCancelled { return false }
        }
        isSolving = true
        defer { isSolving = false }

        let bounds = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?
            .screen.bounds ?? CGRect(x: 0, y: 0, width: 390, height: 844)
        let webView = WKWebView(frame: bounds)
        self.webView = webView
        defer { self.webView = nil }

        guard let url = URL(string: "https://nitter.poast.org" + path) else { return false }
        webView.load(URLRequest(url: url))

        // The challenge page solves itself (JS puzzle + fingerprint POST) and
        // then reloads. Poll the title until it no longer says "Verifying".
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            if Task.isCancelled { return false }
            try? await Task.sleep(for: .seconds(1))
            guard let title = try? await webView.evaluateJavaScript("document.title") as? String else {
                continue
            }
            if !title.localizedCaseInsensitiveContains("verifying") {
                await syncCookies()
                await saveUserAgent(from: webView)
                return true
            }
        }
        return false
    }

    private func syncCookies() async {
        let store = WKWebsiteDataStore.default().httpCookieStore
        let cookies: [HTTPCookie] = await withCheckedContinuation { continuation in
            store.getAllCookies { continuation.resume(returning: $0) }
        }
        for cookie in cookies {
            HTTPCookieStorage.shared.setCookie(cookie)
        }
    }

    private func saveUserAgent(from webView: WKWebView) async {
        guard let ua = try? await webView.evaluateJavaScript("navigator.userAgent") as? String,
              !ua.isEmpty else { return }
        UserDefaults.standard.set(ua, forKey: NitterClient.userAgentDefaultsKey)
    }
}
