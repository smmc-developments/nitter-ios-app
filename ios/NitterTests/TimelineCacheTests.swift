import XCTest
@testable import Nitter

final class TimelineCacheTests: XCTestCase {

    private var directory: URL!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TimelineCacheTests-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    private func sampleTimeline(text: String = "hello") -> Timeline {
        Timeline(
            tweets: [Tweet(id: "1", authorName: "NASA", authorHandle: "NASA", date: Date(), text: text)],
            account: AccountInfo(handle: "NASA", name: "NASA", avatarURL: nil)
        )
    }

    func testStoreAndRetrieve() async throws {
        let cache = TimelineCache(directory: directory, freshTTL: 60, maxAge: 3600)
        await cache.store(sampleTimeline(), for: "NASA")

        let entry = await cache.entry(for: "nasa")
        XCTAssertNotNil(entry)
        XCTAssertEqual(entry?.timeline.tweets.first?.text, "hello")
        XCTAssertEqual(entry?.timeline.account?.handle, "NASA")

        let fresh = await cache.isFresh(try XCTUnwrap(entry))
        XCTAssertTrue(fresh)
    }

    func testCaseInsensitive() async {
        let cache = TimelineCache(directory: directory, freshTTL: 60, maxAge: 3600)
        await cache.store(sampleTimeline(text: "A"), for: "NASA")
        await cache.store(sampleTimeline(text: "B"), for: "spacex")

        let nasa = await cache.entry(for: "nasa")
        let spx = await cache.entry(for: "SpaceX")
        XCTAssertEqual(nasa?.timeline.tweets.first?.text, "A")
        XCTAssertEqual(spx?.timeline.tweets.first?.text, "B")
    }

    func testMissReturnsNil() async {
        let cache = TimelineCache(directory: directory, freshTTL: 60, maxAge: 3600)
        let entry = await cache.entry(for: "nobody")
        XCTAssertNil(entry)
    }

    func testFreshTTLExpiry() async throws {
        let cache = TimelineCache(directory: directory, freshTTL: 60, maxAge: 3600)
        let oldDate = Date().addingTimeInterval(-90)
        await cache.store(sampleTimeline(), for: "NASA", fetchedAt: oldDate)

        let nasa = await cache.entry(for: "NASA")
        let fresh = await cache.isFresh(try XCTUnwrap(nasa))
        XCTAssertFalse(fresh)
    }

    func testMaxAgeExpiry() async {
        let cache = TimelineCache(directory: directory, freshTTL: 60, maxAge: 3600)

        await cache.store(sampleTimeline(), for: "NASA", fetchedAt: Date().addingTimeInterval(-1200))
        let nasa = await cache.entry(for: "NASA")
        XCTAssertNotNil(nasa)

        await cache.store(sampleTimeline(), for: "old", fetchedAt: Date().addingTimeInterval(-3 * 24 * 3600))
        let old = await cache.entry(for: "old")
        XCTAssertNil(old)
    }

    func testPersistenceAcrossInstances() async {
        let cache1 = TimelineCache(directory: directory, freshTTL: 60, maxAge: 3600)
        await cache1.store(sampleTimeline(text: "persisted"), for: "NASA")

        let cache2 = TimelineCache(directory: directory, freshTTL: 60, maxAge: 3600)
        let entry = await cache2.entry(for: "NASA")
        XCTAssertEqual(entry?.timeline.tweets.first?.text, "persisted")
    }

    func testRemoveAll() async {
        let cache = TimelineCache(directory: directory, freshTTL: 60, maxAge: 3600)
        await cache.store(sampleTimeline(), for: "NASA")
        let before = await cache.entry(for: "NASA")
        XCTAssertNotNil(before)

        await cache.removeAll()
        let after = await cache.entry(for: "NASA")
        XCTAssertNil(after)
    }

    func testRepositoryCachedReturnsFetchedAt() async throws {
        let dir = directory.appendingPathComponent("repo")
        let cache = TimelineCache(directory: dir, freshTTL: 60, maxAge: 3600)
        let repository = TimelineRepository(cache: cache)
        await cache.store(sampleTimeline(), for: "NASA")

        let cached = await repository.cached(for: "NASA")
        XCTAssertNotNil(cached)
        XCTAssertNotNil(cached?.fetchedAt)
        XCTAssertTrue(cached?.isFresh == true)
    }
}
