import SwiftUI
import SafariServices

/// In-app browser used to open a tweet's page (thread, replies, video
/// playback) on xcancel.com.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}
