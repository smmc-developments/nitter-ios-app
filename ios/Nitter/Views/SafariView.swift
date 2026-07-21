import SwiftUI
import SafariServices

/// In-app browser used to open a tweet's page (thread, replies, video
/// playback) on the source Nitter instance.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}
