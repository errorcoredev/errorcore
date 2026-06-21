import fs from 'node:fs'
import path from 'node:path'

export function decodeEnvelopeLine(line) {
  const envelope = JSON.parse(line)
  if (!envelope || typeof envelope.ciphertext !== 'string') {
    throw new Error('capture line is not an errorcore envelope')
  }
  const plaintext = Buffer.from(envelope.ciphertext, 'base64').toString('utf8')
  return {
    envelope,
    package: JSON.parse(plaintext),
  }
}

export function readCaptureFile(file) {
  if (!fs.existsSync(file)) {
    return []
  }
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => ({ file, line: index + 1, ...decodeEnvelopeLine(line) }))
}

export function readAllCaptures(root) {
  const files = []
  function walk(dir) {
    if (!fs.existsSync(dir)) {
      return
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith('.ndjson')) {
        files.push(full)
      }
    }
  }
  walk(root)
  return files.flatMap(readCaptureFile)
}
