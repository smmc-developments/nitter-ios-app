import XCTest
@testable import Nitter

final class CSVImporterTests: XCTestCase {

    func testBareHandles() {
        let result = AccountsView.extractHandles(from: "NASA\nSpaceX\nBlueOrigin")
        XCTAssertEqual(result, ["@NASA", "@SpaceX", "@BlueOrigin"])
    }

    func testAtPrefixedHandles() {
        let result = AccountsView.extractHandles(from: "@nasa, @spacex")
        XCTAssertEqual(result, ["@nasa", "@spacex"])
    }

    func testCSVWithHeadersAndColumns() {
        let csv = """
        name,handle,followers
        NASA,@NASA,92000000
        SpaceX,@SpaceX,30000000
        """
        let result = AccountsView.extractHandles(from: csv)
        XCTAssertEqual(result, ["@NASA", "@SpaceX"])
    }

    func testHeaderSelectsOnlyUsernameColumn() {
        let csv = "name,username\nJaneDoe,actual_account"
        XCTAssertEqual(AccountsView.extractHandles(from: csv), ["@actual_account"])
    }

    func testSkipsInvalidHandles() {
        let result = AccountsView.extractHandles(from: "ab, @nasa, https://x.com/nasa, @OK")
        // "ab" is valid (2 chars), x.com URLs still extract "x" but it's <2... actually "x" is 1 char so skipped
        XCTAssertEqual(result, ["@ab", "@nasa", "@OK"])
    }

    func testDeduplicatesCaseInsensitive() {
        let result = AccountsView.extractHandles(from: "NASA, nasa, Nasa")
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result.first, "@NASA")
    }

    func testSkipsLongHandles() {
        let result = AccountsView.extractHandles(from: "@thishandleistoolong123, @valid")
        XCTAssertEqual(result, ["@valid"])
    }

    func testEmptyCSV() {
        XCTAssertTrue(AccountsView.extractHandles(from: "").isEmpty)
    }

    func testHandlesWithWhitespace() {
        let result = AccountsView.extractHandles(from: "  NASA  ,  @SpaceX  ")
        XCTAssertEqual(result, ["@NASA", "@SpaceX"])
    }
}
