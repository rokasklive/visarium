import AppKit

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: swift desktop/icons/render-icon.swift <output.png>\n", stderr)
    exit(2)
}
let destination = URL(fileURLWithPath: CommandLine.arguments[1])
let size = 1024.0
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let context = NSGraphicsContext.current!.cgContext
context.setShouldAntialias(false)
// macOS icon grid: 824px rounded square centred in 1024.
let inset = 100.0
let rect = NSRect(x: inset, y: inset, width: size - 2*inset, height: size - 2*inset)
NSColor(srgbRed: 0.098, green: 0.102, blue: 0.118, alpha: 1).setFill()
NSBezierPath(roundedRect: rect, xRadius: 185, yRadius: 185).fill()

let vRows = ["##..##", "##..##", "##..##", "##..##", "##..##", "######", ".####.", "..##.."]
let rowColors = [0xffffff, 0xffffff, 0xffffff, 0xffffff, 0xf5e3b5, 0xf9c59a, 0xf87562, 0x31c5b7]
let pitch = 60.0
let dot = 30.0
let left = (size - (5 * pitch + dot)) / 2
let bottom = (size - (7 * pitch + dot)) / 2
let rows = zip(vRows, rowColors).enumerated().map { row, pair in
    let (cells, hex) = pair
    let color = NSColor(
        srgbRed: CGFloat((hex >> 16) & 255) / 255,
        green: CGFloat((hex >> 8) & 255) / 255,
        blue: CGFloat(hex & 255) / 255,
        alpha: 1
    ).cgColor
    let path = CGMutablePath()
    let y = bottom + Double(vRows.count - 1 - row) * pitch
    for (column, cell) in cells.enumerated() where cell == "#" {
        let x = left + Double(column) * pitch
        path.addRect(CGRect(x: x.rounded(), y: y.rounded(), width: dot.rounded(), height: dot.rounded()))
    }
    return (path, color)
}

context.saveGState()
for (path, color) in rows {
    context.setShadow(offset: .zero, blur: 16, color: color.copy(alpha: 0.18))
    context.setFillColor(color)
    context.addPath(path)
    context.fillPath()
}
context.restoreGState()

for (path, color) in rows {
    context.setFillColor(color)
    context.addPath(path)
    context.fillPath()
}

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: destination)
