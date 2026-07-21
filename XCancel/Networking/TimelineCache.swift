import Foundation

/// Memory + disk cache for parsed timelines, keyed by lowercase username.
///
/// Follows a stale-while-revalidate pattern: entries are served instantly
/// from cache and callers use `isFresh(_:)` to decide whether a network
/// refetch is due. Entries older than `maxAge` are pruned.
actor TimelineCache {

    struct Entry: Codable, Sendable {
        let fetchedAt: Date
        let timeline: Timeline
    }

    static let shared = TimelineCache()

    private var memory: [String: Entry] = [:]
    private let directory: URL
    private let freshTTL: TimeInterval
    private let maxAge: TimeInterval

    init(
        directory: URL? = nil,
        freshTTL: TimeInterval = 15 * 60,
        maxAge: TimeInterval = 7 * 24 * 60 * 60
    ) {
        self.directory = directory
            ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("TimelineCache", isDirectory: true)
        self.freshTTL = freshTTL
        self.maxAge = maxAge
        try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
    }

    /// Cached entry for `username`, or nil when missing/expired.
    func entry(for username: String) -> Entry? {
        let key = Self.key(for: username)
        if let entry = memory[key] {
            return isValid(entry) ? entry : nil
        }
        guard let data = try? Data(contentsOf: fileURL(for: key)),
              let entry = try? JSONDecoder().decode(Entry.self, from: data),
              isValid(entry) else {
            return nil
        }
        memory[key] = entry
        return entry
    }

    /// True when the entry is within the fresh TTL and needs no refetch.
    func isFresh(_ entry: Entry) -> Bool {
        Date().timeIntervalSince(entry.fetchedAt) < freshTTL
    }

    func store(_ timeline: Timeline, for username: String) {
        store(timeline, for: username, fetchedAt: Date())
    }

    func removeAll() {
        memory.removeAll()
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    // MARK: - Internal (testable)

    func store(_ timeline: Timeline, for username: String, fetchedAt: Date) {
        let key = Self.key(for: username)
        let entry = Entry(fetchedAt: fetchedAt, timeline: timeline)
        memory[key] = entry
        if let data = try? JSONEncoder().encode(entry) {
            try? data.write(to: fileURL(for: key), options: .atomic)
        }
        pruneExpired()
    }

    // MARK: - Private

    private func isValid(_ entry: Entry) -> Bool {
        Date().timeIntervalSince(entry.fetchedAt) < maxAge
    }

    private func pruneExpired() {
        memory = memory.filter { isValid($0.value) }
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil
        ) else { return }
        for file in files {
            guard let data = try? Data(contentsOf: file),
                  let entry = try? JSONDecoder().decode(Entry.self, from: data),
                  !isValid(entry) else { continue }
            try? FileManager.default.removeItem(at: file)
        }
    }

    private func fileURL(for key: String) -> URL {
        directory.appendingPathComponent(key + ".json")
    }

    private static func key(for username: String) -> String {
        username.lowercased()
    }
}
