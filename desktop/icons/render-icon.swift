// Renders app-icon.png from the wordmark face. Then: pnpm tauri icon desktop/icons/app-icon.png -o desktop/icons
//   swift desktop/icons/render-icon.swift web/public/fonts/editundo-dot.ttf desktop/icons/app-icon.png
import AppKit
import CoreText
let args = CommandLine.arguments
let fontURL = URL(fileURLWithPath: args[1]) as CFURL
CTFontManagerRegisterFontsForURL(fontURL, .process, nil)
let descs = CTFontManagerCreateFontDescriptorsFromURL(fontURL) as! [CTFontDescriptor]
let size = 1024.0
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current!.shouldAntialias = false
// macOS icon grid: 824px rounded square centred in 1024.
let inset = 100.0
let rect = NSRect(x: inset, y: inset, width: size - 2*inset, height: size - 2*inset)
NSColor(srgbRed: 0.098, green: 0.102, blue: 0.118, alpha: 1).setFill()
NSBezierPath(roundedRect: rect, xRadius: 185, yRadius: 185).fill()
let font = CTFontCreateWithFontDescriptor(descs[0], 560, nil) as NSFont
let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor(srgbRed: 0.90, green: 0.905, blue: 0.92, alpha: 1)]
let text = NSAttributedString(string: "V", attributes: attrs)
let bounds = text.boundingRect(with: NSSize(width: 2000, height: 2000), options: [.usesDeviceMetrics])
text.draw(at: NSPoint(x: (size - bounds.width)/2 - bounds.minX, y: (size - bounds.height)/2 - bounds.minY - 100))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
