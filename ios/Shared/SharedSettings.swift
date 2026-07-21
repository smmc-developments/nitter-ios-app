import Foundation

enum SharedSettings {
    static let suiteName = "group.local.xcancel.XCancel"
    static let defaults = UserDefaults(suiteName: suiteName) ?? .standard

    static func migrateFromStandardDefaults() {
        let standard = UserDefaults.standard
        for key in ["server.baseURL", "server.apiKey"] where defaults.object(forKey: key) == nil {
            if let value = standard.object(forKey: key) {
                defaults.set(value, forKey: key)
            }
        }
    }
}
