import Foundation
import SwiftData

@Model
final class SavedAccount {
    @Attribute(.unique) var username: String
    var displayName: String?
    var avatarURLString: String?
    var addedAt: Date

    init(username: String, addedAt: Date = .now) {
        self.username = username
        self.addedAt = addedAt
    }

    /// Sanitizes user input into a valid X handle, or returns nil.
    static func sanitize(handle raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let noAt = trimmed.hasPrefix("@") ? String(trimmed.dropFirst()) : trimmed
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")
        guard !noAt.isEmpty, noAt.count <= 15,
              noAt.unicodeScalars.allSatisfy(allowed.contains) else {
            return nil
        }
        return noAt
    }
}
