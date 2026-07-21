import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var theme: ThemeManager
    @State private var serverURL: String
    @State private var apiKey: String
    @State private var serverStatus: ServerStatus?

    enum ServerStatus {
        case online
        case unreachable
    }

    init() {
        _serverURL = State(initialValue: UserDefaults.standard.string(forKey: "server.baseURL") ?? "http://localhost:3000")
        _apiKey = State(initialValue: UserDefaults.standard.string(forKey: "server.apiKey") ?? "")
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Appearance") {
                    appearanceRow(.system)
                    appearanceRow(.light)
                    appearanceRow(.dark)
                }

                Section {
                    TextField("https://server.example.com", text: $serverURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .onChange(of: serverURL) { _, value in
                            UserDefaults.standard.set(value, forKey: "server.baseURL")
                        }
                    SecureField("API key", text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: apiKey) { _, value in
                            UserDefaults.standard.set(value, forKey: "server.apiKey")
                        }
                } header: {
                    Text("Server")
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Include http:// or https://. The API key is optional.")
                        if let serverStatus {
                            switch serverStatus {
                            case .online:
                                Label("Server is reachable", systemImage: "checkmark.circle")
                                    .foregroundStyle(.green)
                            case .unreachable:
                                Label("Server is not reachable", systemImage: "xmark.circle")
                                    .foregroundStyle(.red)
                            }
                        }
                    }
                }

                Section {
                    Button("Test Connection") {
                        Task { await testConnection() }
                    }
                }

                Section {
                    LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "–")
                }
            }
            .navigationTitle("Settings")
        }
    }

    private func appearanceRow(_ option: ThemeManager.Appearance) -> some View {
        Button {
            theme.appearance = option
        } label: {
            HStack {
                Text(option.label)
                Spacer()
                if theme.appearance == option {
                    Image(systemName: "checkmark")
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.accentColor)
                }
            }
        }
    }

    private func testConnection() async {
        let online = await APIClient.shared.isServerOnline()
        serverStatus = online ? .online : .unreachable
    }
}
