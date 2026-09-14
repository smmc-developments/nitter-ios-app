import SwiftUI

/// Live view of the companion server's recent log buffer (`GET /api/logs`).
/// Polls incrementally using the server's `latest` id watermark.
struct ServerLogsView: View {
    @State private var entries: [ServerLogEntry] = []
    @State private var latest = 0
    @State private var minLevel = "info"
    @State private var errorMessage: String?
    @State private var isLoading = false

    private let levels = ["debug", "info", "warn", "error"]

    var body: some View {
        Group {
            if entries.isEmpty && isLoading {
                ProgressView("Loading logs…")
            } else if entries.isEmpty, let errorMessage {
                ContentUnavailableView(
                    "Couldn't Load Logs",
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorMessage)
                )
            } else if entries.isEmpty {
                ContentUnavailableView(
                    "No Logs",
                    systemImage: "text.alignleft",
                    description: Text("Pull down to refresh.")
                )
            } else {
                logList
            }
        }
        .navigationTitle("Server Logs")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Minimum level", selection: $minLevel) {
                        ForEach(levels, id: \.self) { level in
                            Text(level.capitalized).tag(level)
                        }
                    }
                } label: {
                    Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: logText) {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
                .disabled(entries.isEmpty)
            }
        }
        .refreshable { await refresh(full: true) }
        .task { await pollLoop() }
        .onChange(of: minLevel) { _, _ in
            Task { await refresh(full: true) }
        }
    }

    private var logList: some View {
        List(entries.reversed()) { entry in
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(timeString(for: entry))
                    Text(entry.level.uppercased())
                        .fontWeight(.bold)
                        .foregroundStyle(color(for: entry.level))
                    Text(entry.scope)
                        .foregroundStyle(.secondary)
                }
                .font(.caption.monospaced())
                Text(entry.message)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
            .padding(.vertical, 2)
        }
        .listStyle(.plain)
    }

    private var logText: String {
        entries
            .map { "[\($0.ts)] [\($0.scope)] [\($0.level)] \($0.message)" }
            .joined(separator: "\n")
    }

    private func pollLoop() async {
        await refresh(full: true)
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { break }
            await refresh()
        }
    }

    private func refresh(full: Bool = false) async {
        if full { isLoading = entries.isEmpty }
        defer { isLoading = false }
        do {
            let response = try await APIClient.shared.fetchLogs(
                after: full ? 0 : latest,
                limit: 500,
                level: minLevel
            )
            if full {
                entries = response.entries
            } else if response.latest < latest {
                // Server restarted — ids reset, so resync from scratch.
                await refresh(full: true)
                return
            } else {
                entries.append(contentsOf: response.entries)
                if entries.count > 1_000 {
                    entries.removeFirst(entries.count - 1_000)
                }
            }
            latest = max(latest, response.latest)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func timeString(for entry: ServerLogEntry) -> String {
        guard let date = entry.date else { return entry.ts }
        return date.formatted(date: .omitted, time: .standard)
    }

    private func color(for level: String) -> Color {
        switch level {
        case "error": return .red
        case "warn": return .orange
        case "debug": return .secondary
        default: return .primary
        }
    }
}
