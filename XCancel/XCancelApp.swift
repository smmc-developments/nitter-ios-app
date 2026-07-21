import SwiftUI
import SwiftData

@main
struct XCancelApp: App {
    @StateObject private var theme = ThemeManager()

    init() {
        URLCache.shared = URLCache(
            memoryCapacity: 64 * 1024 * 1024,
            diskCapacity: 256 * 1024 * 1024
        )
    }

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .preferredColorScheme(theme.appearance.colorScheme)
        }
        .environmentObject(theme)
        .modelContainer(for: SavedAccount.self)
    }
}
