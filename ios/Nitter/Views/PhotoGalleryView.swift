import SwiftUI
import UIKit

struct PhotoGalleryView: View {
    let photos: [URL]
    @State private var index: Int
    @State private var zoom: CGFloat = 1
    @State private var dragOffset: CGFloat = 0
    @Environment(\.dismiss) private var dismiss

    init(photos: [URL], startIndex: Int) {
        self.photos = photos
        _index = State(initialValue: startIndex)
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea().opacity(max(0, 1 - dragOffset / 500))
            TabView(selection: $index) {
                ForEach(Array(photos.enumerated()), id: \.offset) { index, url in
                    ZoomableImageView(url: url, onZoomChanged: { zoom = $0 })
                        .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: photos.count > 1 ? .automatic : .never))
            .ignoresSafeArea()
            .offset(y: dragOffset)
            Button("Done") { dismiss() }
                .font(.headline)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.ultraThinMaterial, in: Capsule())
                .padding(.trailing, 16)
                .padding(.top, 8)
                .offset(y: dragOffset)
        }
        .onChange(of: index) { _, _ in
            zoom = 1
            dragOffset = 0
        }
        .simultaneousGesture(
            DragGesture(minimumDistance: 12)
                .onChanged { value in
                    let height = value.translation.height
                    let width = value.translation.width
                    guard zoom <= 1, height > 0, height > abs(width) else { return }
                    dragOffset = height
                }
                .onEnded { value in
                    let height = value.translation.height
                    let width = value.translation.width
                    let swipedDown = height > 0 && height > abs(width)
                    let shouldDismiss = swipedDown && (height > 130 || value.predictedEndTranslation.height > 350)
                    if shouldDismiss {
                        withAnimation(.easeOut(duration: 0.18)) { dragOffset = 800 }
                        Task { @MainActor in
                            try? await Task.sleep(for: .milliseconds(180))
                            dismiss()
                        }
                    } else {
                        withAnimation(.spring(duration: 0.3)) { dragOffset = 0 }
                    }
                }
        )
    }
}

private struct ZoomableImageView: UIViewRepresentable {
    let url: URL
    let onZoomChanged: (CGFloat) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(url: url, onZoomChanged: onZoomChanged) }

    func makeUIView(context: Context) -> UIScrollView {
        let scrollView = UIScrollView()
        scrollView.delegate = context.coordinator
        scrollView.backgroundColor = .black
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 6
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.bouncesZoom = true
        context.coordinator.scrollView = scrollView

        let imageView = UIImageView()
        imageView.contentMode = .scaleAspectFit
        scrollView.addSubview(imageView)
        context.coordinator.imageView = imageView

        let doubleTap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleDoubleTap(_:))
        )
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)

        context.coordinator.loadImage()
        return scrollView
    }

    func updateUIView(_ uiView: UIScrollView, context: Context) {}

    final class Coordinator: NSObject, UIScrollViewDelegate {
        let url: URL
        let onZoomChanged: (CGFloat) -> Void
        weak var scrollView: UIScrollView?
        weak var imageView: UIImageView?

        init(url: URL, onZoomChanged: @escaping (CGFloat) -> Void) {
            self.url = url
            self.onZoomChanged = onZoomChanged
        }

        func loadImage() {
            Task { @MainActor in
                guard let image = await RemoteImageStore.shared.image(for: url) else { return }
                guard let scrollView, let imageView else { return }
                imageView.image = image
                let size = aspectFitSize(of: image, in: scrollView.bounds.size)
                imageView.frame = CGRect(origin: .zero, size: size)
                scrollView.contentSize = size
                scrollView.zoomScale = 1
                centerContent()
            }
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            imageView
        }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            onZoomChanged(scrollView.zoomScale)
            centerContent()
        }

        @objc func handleDoubleTap(_ recognizer: UITapGestureRecognizer) {
            guard let scrollView, let imageView else { return }
            if scrollView.zoomScale > 1 {
                scrollView.setZoomScale(1, animated: true)
                return
            }
            let point = recognizer.location(in: imageView)
            let zoomRect = CGRect(
                x: point.x - scrollView.bounds.width / 4,
                y: point.y - scrollView.bounds.height / 4,
                width: scrollView.bounds.width / 2,
                height: scrollView.bounds.height / 2
            )
            scrollView.zoom(to: zoomRect, animated: true)
        }

        private func aspectFitSize(of image: UIImage, in bounds: CGSize) -> CGSize {
            guard image.size.width > 0, image.size.height > 0 else { return bounds }
            let scale = min(bounds.width / image.size.width, bounds.height / image.size.height)
            return CGSize(width: image.size.width * scale, height: image.size.height * scale)
        }

        private func centerContent() {
            guard let scrollView, let imageView else { return }
            let bounds = scrollView.bounds.size
            let frame = imageView.frame
            var originX = frame.origin.x
            var originY = frame.origin.y
            if frame.width < bounds.width {
                originX = (bounds.width - frame.width) / 2
            }
            if frame.height < bounds.height {
                originY = (bounds.height - frame.height) / 2
            }
            imageView.frame.origin = CGPoint(x: originX, y: originY)
        }
    }
}
