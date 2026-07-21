import SwiftUI

final class ThemeManager: ObservableObject {
    enum Appearance: Int, CaseIterable, Identifiable {
        case system = 0
        case light = 1
        case dark = 2

        var id: Int { rawValue }

        var colorScheme: ColorScheme? {
            switch self {
            case .system: nil
            case .light:  .light
            case .dark:   .dark
            }
        }

        var label: String {
            switch self {
            case .system: "System"
            case .light:  "Light"
            case .dark:   "Dark"
            }
        }

        var icon: String {
            switch self {
            case .system: "circle.lefthalf.filled"
            case .light:  "sun.max.fill"
            case .dark:   "moon.fill"
            }
        }
    }

    @Published var appearance: Appearance {
        didSet { UserDefaults.standard.set(appearance.rawValue, forKey: "appearance") }
    }

    init() {
        let raw = UserDefaults.standard.integer(forKey: "appearance")
        self.appearance = Appearance(rawValue: raw) ?? .system
    }
}
