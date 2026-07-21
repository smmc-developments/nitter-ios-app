import SwiftUI
import SwiftData

@main
struct NitterApp: App {
    @StateObject private var theme = ThemeManager()
    @State private var sharedLink: SharedXLink?

    init() {
        SharedSettings.migrateFromStandardDefaults()
        URLCache.shared = URLCache(
            memoryCapacity: 64 * 1024 * 1024,
            diskCapacity: 256 * 1024 * 1024
        )
    }

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .preferredColorScheme(theme.appearance.colorScheme)
                .onOpenURL { url in
                    sharedLink = SharedXLink(deepLink: url)
                }
                .sheet(item: $sharedLink) { link in
                    SharedLinkView(link: link)
                        .preferredColorScheme(theme.appearance.colorScheme)
                }
        }
        .environmentObject(theme)
        .modelContainer(for: SavedAccount.self)
    }
}
