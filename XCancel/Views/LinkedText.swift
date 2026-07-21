import SwiftUI

struct LinkedText: View {
    let value: String

    var body: some View {
        Text(Self.attributedValue(for: value))
    }

    private static let detector = try? NSDataDetector(
        types: NSTextCheckingResult.CheckingType.link.rawValue
    )

    private static func attributedValue(for value: String) -> AttributedString {
        guard let detector else { return AttributedString(value) }

        let matches = detector.matches(
            in: value,
            range: NSRange(value.startIndex..., in: value)
        )
        var result = AttributedString()
        var cursor = value.startIndex

        for match in matches {
            guard let url = match.url,
                  let range = Range(match.range, in: value) else { continue }

            result.append(AttributedString(value[cursor..<range.lowerBound]))
            var link = AttributedString(value[range])
            link.link = url
            link.foregroundColor = .accentColor
            result.append(link)
            cursor = range.upperBound
        }

        result.append(AttributedString(value[cursor...]))
        return result
    }
}
