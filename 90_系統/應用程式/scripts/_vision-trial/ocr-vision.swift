// Apple Vision OCR → 輸出跟 analyze-app-images.js 的 ocrPage() 完全一樣格式的 JSON
//
// 為什麼要一樣格式：這樣比對才公平，而且將來真的要換引擎時，
// 上層 900 行邏輯一行都不用動 —— 只把 ocrPage() 的內容換掉。
//
// 用法（一次吃多張圖，只啟動一次程序，比每張跑一次快很多）：
//   swiftc -O ocr-vision.swift -o ocr-vision
//   ./ocr-vision a.jpg b.jpg c.jpg > out.json
//   ./ocr-vision --lang zh-Hant,en-US --correct a.jpg     # 開語言校正（預設關）
//
// ⚠️ 預設關閉 usesLanguageCorrection：股名／代號／數字要的是「照實讀」，
//    語言校正會把 3481 之類的東西「修」成比較像中文的結果。
import Foundation
import Vision
import CoreGraphics
import ImageIO

struct Word: Codable { let t: String; let x: Int; let y: Int; let w: Int; let h: Int; let c: Int }
struct Line: Codable { let text: String; let x: Int; let y: Int; let w: Int; let h: Int; let c: Int }
struct PageResult: Codable {
  let words: [Word]; let lines: [Line]
  let width: Int; let height: Int; let ms: Int
}

func loadCGImage(_ path: String) -> CGImage? {
  let url = URL(fileURLWithPath: path) as CFURL
  guard let src = CGImageSourceCreateWithURL(url, nil),
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
  return img
}

// Vision 的座標是「左下角原點、0~1 正規化」；tesseract 是「左上角原點、像素」。
// 這裡一律轉成 tesseract 的慣例，上層才不用改。
func toPixels(_ b: CGRect, _ W: CGFloat, _ H: CGFloat) -> (Int, Int, Int, Int) {
  return (Int((b.minX * W).rounded()),
          Int(((1 - b.maxY) * H).rounded()),
          Int((b.width  * W).rounded()),
          Int((b.height * H).rounded()))
}


/**
 * 把「逐字框」合併成「詞框」。
 *
 * 為什麼一定要做：findCell() 是對每一個字框做 parseFloat 的 ——
 *   Tesseract 給 "524.0" → 524 ✅
 *   Vision 逐字給 "5","2","4",".","0" → 5,2,4,0 ❌ 數字比對整個失效
 *
 * 規則完全照搬 scripts/shot-memory.js 的 mergeRuns()（那是為 tesseract 把
 * 「南亞科」拆成「南亞」+「科」寫的，同一個問題、同一套解法）：
 *   分行 —— 用「垂直重疊比例」不是中心點距離（又寬又扁的頁籤框會把中心點判斷帶歪）
 *   併詞 —— 同一行、水平間隙小於 0.8 個字寬就黏起來
 */
func mergeRuns(_ input: [Word]) -> [Word] {
  let ws = input.filter { !$0.t.isEmpty && $0.h > 0 }
                .sorted { $0.y != $1.y ? $0.y < $1.y : $0.x < $1.x }
  if ws.isEmpty { return [] }

  struct Ln { var y: Int; var h: Int; var items: [Word] }
  var lines: [Ln] = []
  for w in ws {
    var placed = false
    for i in lines.indices {
      let ov = min(lines[i].y + lines[i].h, w.y + w.h) - max(lines[i].y, w.y)
      let minH = min(lines[i].h, w.h), maxH = max(lines[i].h, w.h)
      if minH > 0, Double(ov) > Double(minH) * 0.6, Double(maxH) / Double(minH) < 2.2 {
        let bottom = max(lines[i].y + lines[i].h, w.y + w.h)
        lines[i].items.append(w)
        lines[i].y = min(lines[i].y, w.y)
        lines[i].h = bottom - lines[i].y
        placed = true
        break
      }
    }
    if !placed { lines.append(Ln(y: w.y, h: w.h, items: [w])) }
  }

  var runs: [Word] = []
  for L in lines {
    let items = L.items.sorted { $0.x < $1.x }
    var curT = "", curX = 0, curY = 0, curW = 0, curH = 0, curC = 0
    var has = false
    for w in items {
      let charW = Double(w.w) / Double(max(1, w.t.count))
      if has {
        let gap = Double(w.x - (curX + curW))
        if gap <= charW * 0.8 && gap > -charW {
          let bottom = max(curY + curH, w.y + w.h)
          curT += w.t
          curW = max(curX + curW, w.x + w.w) - curX
          curY = min(curY, w.y)
          curH = bottom - curY
          curC = min(curC, w.c)
          continue
        }
        runs.append(Word(t: curT, x: curX, y: curY, w: curW, h: curH, c: curC))
      }
      curT = w.t; curX = w.x; curY = w.y; curW = w.w; curH = w.h; curC = w.c
      has = true
    }
    if has { runs.append(Word(t: curT, x: curX, y: curY, w: curW, h: curH, c: curC)) }
  }
  return runs.sorted { $0.y != $1.y ? $0.y < $1.y : $0.x < $1.x }
}

func ocr(_ cg: CGImage, langs: [String], correction: Bool, rawChars: Bool) -> ([Word], [Line]) {
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.recognitionLanguages = langs
  req.usesLanguageCorrection = correction
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  try? handler.perform([req])

  let W = CGFloat(cg.width), H = CGFloat(cg.height)
  var words: [Word] = []
  var lines: [Line] = []

  for obs in (req.results ?? []) {
    guard let cand = obs.topCandidates(1).first else { continue }
    let s = cand.string
    let conf = Int((cand.confidence * 100).rounded())

    let (lx, ly, lw, lh) = toPixels(obs.boundingBox, W, H)
    lines.append(Line(text: s, x: lx, y: ly, w: lw, h: lh, c: conf))

    // 逐字框：Vision 原生只給「整行」的框，但可以用字元 range 反查每個字的框。
    // analyze-app-images.js 的 words 是逐字的，所以這裡也給逐字，
    // shot-memory.js 的 mergeRuns() 會再把相鄰的字併成詞。
    var idx = s.startIndex
    while idx < s.endIndex {
      let next = s.index(after: idx)
      let ch = String(s[idx..<next])
      if ch != " " && ch != "\n",
         let rect = (try? cand.boundingBox(for: idx..<next)) ?? nil {
        let (x, y, w, h) = toPixels(rect.boundingBox, W, H)
        if w > 0 && h > 0 { words.append(Word(t: ch, x: x, y: y, w: w, h: h, c: conf)) }
      }
      idx = next
    }
  }
  // 預設輸出「詞」（跟 tesseract 同粒度，才能直接餵給 findCell）。
  // --chars 可以拿到未合併的逐字框，除錯用。
  return (rawChars ? words : mergeRuns(words), lines)
}

// ── 參數 ──
var langs = ["zh-Hant", "en-US"]
var correction = false
var rawChars = false
var paths: [String] = []
let args = Array(CommandLine.arguments.dropFirst())
var i = 0
while i < args.count {
  let a = args[i]
  if a == "--lang", i + 1 < args.count {
    i += 1; langs = args[i].split(separator: ",").map(String.init)
  } else if a == "--correct" {
    correction = true
  } else if a == "--chars" {
    rawChars = true
  } else {
    paths.append(a)
  }
  i += 1
}
if paths.isEmpty {
  FileHandle.standardError.write("用法: ocr-vision [--lang zh-Hant,en-US] [--correct] [--chars] <圖片...>\n".data(using: .utf8)!)
  exit(2)
}

var out: [String: PageResult] = [:]
for p in paths {
  guard let cg = loadCGImage(p) else {
    FileHandle.standardError.write("讀不到圖：\(p)\n".data(using: .utf8)!)
    continue
  }
  let t0 = Date()
  let (w, l) = ocr(cg, langs: langs, correction: correction, rawChars: rawChars)
  out[p] = PageResult(words: w, lines: l, width: cg.width, height: cg.height,
                      ms: Int(Date().timeIntervalSince(t0) * 1000))
}
let enc = JSONEncoder()
if let data = try? enc.encode(out) { FileHandle.standardOutput.write(data) }
