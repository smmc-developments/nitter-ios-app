import SwiftUI
import UniformTypeIdentifiers

struct AccountsView: View {
    @State private var accounts: [APIClient.ServerAccount] = []
    @State private var newHandle = ""
    @State private var showInvalidHandle = false
    @State private var showPicker = false
    @State private var importResult: ImportResult?
    @State private var isLoading = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        TextField("Add account (e.g. @nasa)", text: $newHandle)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onSubmit(addAccount)
                        Button(action: addAccount) {
                            Image(systemName: "plus.circle.fill").font(.title2)
                        }
                        .disabled(SavedAccount.sanitize(handle: newHandle) == nil)
                    }
                } footer: {
                    if showInvalidHandle {
                        Text("Invalid handle — letters, numbers and underscores only.")
                            .foregroundStyle(.red)
                    }
                }

                Section("Saved Accounts (\(accounts.count))") {
                    if isLoading {
                        ProgressView("Loading accounts…")
                    } else if accounts.isEmpty {
                        Text("No accounts on server.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(accounts, id: \.username) { account in
                            NavigationLink(value: account.username) {
                                AccountRow(account: account)
                            }
                        }
                        .onDelete(perform: delete)
                    }
                }
            }
            .navigationTitle("Accounts")
            .navigationDestination(for: String.self) { username in
                AccountFeedView(username: username)
            }
            .toolbar {
                Button("Import CSV", systemImage: "doc.badge.plus") {
                    showPicker = true
                }
            }
            .task { await load() }
            .fileImporter(
                isPresented: $showPicker,
                allowedContentTypes: [UTType.commaSeparatedText, .plainText, .item]
            ) { result in
                handleImport(result)
            }
            .alert("Import Complete", isPresented: Binding(
                get: { importResult != nil },
                set: { if !$0 { importResult = nil } }
            )) {
                Button("OK", role: .cancel) { importResult = nil }
            } message: {
                if let result = importResult {
                    Text(result.message)
                }
            }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            accounts = try await APIClient.shared.listAccounts(forceRefresh: true)
        } catch {
            accounts = []
        }
    }

    private func addAccount() {
        guard let handle = SavedAccount.sanitize(handle: newHandle) else {
            showInvalidHandle = true
            return
        }
        showInvalidHandle = false
        newHandle = ""
        guard !accounts.contains(where: { $0.username.caseInsensitiveCompare(handle) == .orderedSame }) else {
            return
        }
        Task {
            do {
                let account = try await APIClient.shared.addAccount(handle)
                accounts.append(account)
            } catch {
                showInvalidHandle = true
            }
        }
    }

    private func delete(at offsets: IndexSet) {
        let usernames = offsets.map { accounts[$0].username }
        Task {
            for username in usernames {
                do {
                    try await APIClient.shared.removeAccount(username)
                    accounts.removeAll { $0.username == username }
                } catch {
                    // Keep failed deletions visible.
                }
            }
        }
    }

    private func handleImport(_ result: Result<URL, Error>) {
        guard let url = try? result.get() else { return }
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8) else { return }

        let handles = Self.extractHandles(from: text)
        let existing = Set(accounts.map { $0.username.lowercased() })

        Task {
            var imported = 0, duplicates = 0, invalid = 0
            for raw in handles {
                if let handle = SavedAccount.sanitize(handle: raw) {
                    if existing.contains(handle.lowercased()) {
                        duplicates += 1
                    } else {
                        do {
                            let _ = try await APIClient.shared.addAccount(handle)
                            imported += 1
                        } catch {
                            if case APIClientError.httpError(409) = error {
                                duplicates += 1
                            } else {
                                invalid += 1
                            }
                        }
                    }
                } else {
                    invalid += 1
                }
            }
            importResult = ImportResult(
                imported: imported,
                duplicates: duplicates,
                invalid: invalid
            )
            await load()
        }
    }

    static func extractHandles(from csv: String) -> [String] {
        let headerWords: Set<String> = [
            "name", "handle", "username", "screen_name", "screenname",
            "email", "url", "link", "bio", "location", "description",
            "followers", "following", "tweets", "posts", "joined",
            "verified", "protected", "id", "userid", "user_id"
        ]
        let handlePattern = "^[A-Za-z0-9_]{2,15}$"

        let lines = csv.components(separatedBy: .newlines)
        var seen = Set<String>()
        var results: [String] = []

        var handleColumn: Int?
        for (lineIndex, line) in lines.enumerated() {
            let cells = line.components(separatedBy: ",")
            let trimmedCells = cells.map {
                $0.trimmingCharacters(in: .whitespacesAndNewlines)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            }

            if lineIndex == 0,
               let column = trimmedCells.firstIndex(where: {
                   ["handle", "username", "screen_name", "screenname"].contains($0.lowercased())
               }) {
                handleColumn = column
                continue
            }
            if lineIndex == 0 && trimmedCells.contains(where: { headerWords.contains($0.lowercased()) }) {
                continue
            }

            let candidateCells = handleColumn.map { $0 < trimmedCells.count ? [trimmedCells[$0]] : [] }
                ?? trimmedCells
            for cell in candidateCells {
                let candidate = cell.hasPrefix("@") ? String(cell.dropFirst()) : cell
                guard candidate.range(of: handlePattern, options: .regularExpression) != nil,
                      candidate.contains(where: { $0.isLetter }) else {
                    continue
                }
                let lower = candidate.lowercased()
                if !seen.contains(lower) {
                    seen.insert(lower)
                    results.append("@" + candidate)
                }
            }
        }
        return results
    }
}

private struct ImportResult {
    var imported: Int
    var duplicates: Int
    var invalid: Int
    var message: String {
        var parts: [String] = []
        if imported > 0 { parts.append("\(imported) imported") }
        if duplicates > 0 { parts.append("\(duplicates) skipped (duplicate)") }
        if invalid > 0 { parts.append("\(invalid) skipped (invalid)") }
        return parts.isEmpty ? "No valid handles found." : parts.joined(separator: "\n")
    }
}

private struct AccountRow: View {
    let account: APIClient.ServerAccount

    var body: some View {
        HStack(spacing: 10) {
            CachedAsyncImage(url: account.avatar_url.flatMap(URL.init(string:))) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Image(systemName: "person.crop.circle.fill")
                    .resizable()
                    .foregroundStyle(.tertiary)
            }
            .frame(width: 40, height: 40)
            .clipShape(Circle())

            VStack(alignment: .leading) {
                Text(account.display_name ?? account.username).fontWeight(.semibold)
                Text("@\(account.username)").foregroundStyle(.secondary).font(.callout)
                if let updated = account.lastFetchedDate {
                    (Text("Updated ") + Text(updated, style: .relative))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                } else {
                    Text("Not fetched yet")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }
}
