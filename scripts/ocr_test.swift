#!/usr/bin/env swift
// macOS Vision framework OCR — AppKit不使用版
// Usage: ./ocr_test <image_path>

import Vision
import CoreGraphics
import ImageIO
import Foundation

guard CommandLine.arguments.count > 1 else {
  fputs("Usage: ocr_test <image_path>\n", stderr)
  exit(1)
}

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)

guard let src = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
  fputs("ERROR: Could not load image: \(imagePath)\n", stderr)
  exit(1)
}

let sema = DispatchSemaphore(value: 0)

let request = VNRecognizeTextRequest { req, err in
  defer { sema.signal() }
  if let err = err { fputs("Vision error: \(err)\n", stderr); return }
  guard let obs = req.results as? [VNRecognizedTextObservation] else { return }

  var blocks: [(y: CGFloat, x: CGFloat, text: String)] = []
  for o in obs {
    guard let c = o.topCandidates(1).first else { continue }
    let bb = o.boundingBox
    blocks.append((y: 1.0 - bb.midY, x: bb.midX, text: c.string))
  }
  blocks.sort { $0.y < $1.y }
  for b in blocks {
    print("[\(Int(b.y*100))%,\(Int(b.x*100))%] \(b.text)")
  }
}
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["ja-JP", "en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
DispatchQueue.global().async {
  do {
    try handler.perform([request])
  } catch {
    fputs("Perform error: \(error)\n", stderr)
    sema.signal()
  }
}

sema.wait()
